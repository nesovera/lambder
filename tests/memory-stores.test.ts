/**
 * The in-memory stores: what they add beyond the store interfaces, which
 * tests/store-conformance.test.ts pins for every implementation. These are
 * the memory-only accessors (countOf, recordOf, size, reset, list) and the
 * expiry the process itself has to do, since no table TTL does it here.
 */

import { describe, it, expect, vi } from 'vitest';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';

describe('LambderMemoryRateLimiter', () => {
    it('counts attempts per window with the DynamoDB limiter semantics, and windows reset with the clock', async () => {
        let now = 1_700_000_000_000;
        const limiter = new LambderMemoryRateLimiter({ now: () => now });
        expect(await limiter.isRateLimited('k', { perMin: 2, perHour: 3 })).toBe(false);
        expect(await limiter.isRateLimited('k', { perMin: 2, perHour: 3 })).toBe(false);
        const exceeded = await limiter.isRateLimited('k', { perMin: 2, perHour: 3 });
        expect(exceeded).toMatchObject({ window: 'perMin', limit: 2 });
        expect(limiter.countOf('k', 'perMin')).toBe(2);
        expect(limiter.countOf('k', 'perHour')).toBe(2);
        expect(await limiter.isRateLimited('other', { perMin: 2 })).toBe(false);

        now += 61_000;
        expect(await limiter.isRateLimited('k', { perMin: 2, perHour: 3 })).toBe(false);
        expect(await limiter.isRateLimited('k', { perMin: 2, perHour: 3 })).toMatchObject({ window: 'perHour', limit: 3 });
        limiter.reset();
        expect(limiter.countOf('k', 'perMin')).toBe(0);
        expect(await limiter.isRateLimited('k', {})).toBe(false);
    });
});

describe('LambderMemoryIdempotencyStore', () => {
    it('claims, settles, replays, refuses lost claims and forgets expired ones', async () => {
        let now = 1_700_000_000_000;
        const store = new LambderMemoryIdempotencyStore({ now: () => now, maxBodyBytes: 20 });
        const claim = await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' });
        if(claim.state !== 'new') throw new Error('expected a fresh claim');
        expect(await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-2' })).toEqual({ state: 'pending', fingerprint: 'request-1' });
        expect(await store.peek('s')).toBeNull();
        expect(await store.complete('s', 'wrong-owner', { statusCode: 200, headers: {}, body: 'x', fingerprint: 'request-1', ttlSeconds: 60 })).toBe('lost');
        expect(await store.complete('s', claim.ownerToken, { statusCode: 200, headers: {}, body: 'x'.repeat(21), fingerprint: 'request-1', ttlSeconds: 60 })).toBe('too-large');
        expect(await store.complete('s', claim.ownerToken, { statusCode: 201, headers: { A: ['1'] }, body: 'done', fingerprint: 'request-1', ttlSeconds: 60 })).toBe('stored');
        expect(await store.peek('s')).toEqual({ statusCode: 201, headers: { A: ['1'] }, body: 'done', fingerprint: 'request-1' });
        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('done');

        now += 61_000;
        expect(await store.peek('s')).toBeNull();
        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('new');

        const pending = await store.begin('p', { pendingTtlSeconds: 1, fingerprint: 'request-1' });
        if(pending.state !== 'new') throw new Error('expected a fresh claim');
        await store.abandon('p', 'not-the-owner');
        expect(store.recordOf('p')?.state).toBe('pending');
        await store.abandon('p', pending.ownerToken);
        expect(store.recordOf('p')).toBeNull();
        store.reset();
        expect(store.size).toBe(0);
    });

    it('answers a claim it has no room for with the caller\'s own fingerprint, so it reads as in flight rather than as a reused key', async () => {
        // Any other fingerprint here would have the engine answer the
        // key-reused 409, which moves a key scope on as though the operation
        // were settled; the in-flight 409 keeps the key for the retry.
        const store = new LambderMemoryIdempotencyStore({ maxEntries: 1 });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect((await store.begin('held', { pendingTtlSeconds: 300, fingerprint: 'request-1' })).state).toBe('new');

            expect(await store.begin('no-room', { pendingTtlSeconds: 300, fingerprint: 'request-2' })).toEqual({ state: 'pending', fingerprint: 'request-2' });
        } finally {
            logged.mockRestore();
        }
    });
});

describe('LambderMemorySessionStore', () => {
    it('stores copies, lists a partition, refuses a second create and updates only existing records', async () => {
        const store = new LambderMemorySessionStore();
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        const record = { sessionKeyHash: 'p', secretHash: 's1', csrfTokenHash: 'c', sessionKey: 'u', data: { a: 1 }, createdAt: 1, expiresAt, lastAccessedAt: 1, ttlInSeconds: 3600, dataVersion: 0 };
        await store.create(record);
        record.data.a = 2;
        expect((await store.get('p', 's1'))?.data).toEqual({ a: 1 });
        await store.create({ ...record, secretHash: 's2' });
        await store.create({ ...record, sessionKeyHash: 'q', secretHash: 's3' });
        expect((await store.listSecretHashes('p')).sort()).toEqual(['s1', 's2']);
        await expect(store.create(record)).rejects.toThrow(/already exists/);
        expect(await store.update('p', 's1', { dataExpiresAt: 99 })).toBe('updated');
        expect(await store.update('p', 'missing', { dataExpiresAt: 99 })).toBe('missing');
        expect(await store.get('p', 'missing')).toBeNull();
        expect(await store.get('p', 's1')).toMatchObject({ dataExpiresAt: 99, dataVersion: 1 });
        expect(await store.update('p', 's1', { data: { a: 3 } }, { dataVersion: 0 })).toBe('stale');
        expect(await store.update('p', 's1', { data: { a: 3 } }, { dataVersion: 1 })).toBe('updated');
        expect(await store.get('p', 's1')).toMatchObject({ data: { a: 3 }, dataVersion: 2 });
        await store.delete('p', 's1');
        expect(await store.get('p', 's1')).toBeNull();
        expect(store.size).toBe(2);
    });

    it('drops a record at its own expiresAt, the way the table\'s TTL removes it', async () => {
        // Without this the store holds every session it ever issued for as
        // long as the process lives.
        let now = 1_700_000_000_000;
        const store = new LambderMemorySessionStore({ now: () => now });
        const expiresAt = Math.floor(now / 1000) + 60;
        await store.create({ sessionKeyHash: 'p', secretHash: 's1', csrfTokenHash: 'c', sessionKey: 'u', data: {}, createdAt: 1, expiresAt, lastAccessedAt: 1, ttlInSeconds: 60, dataVersion: 0 });
        expect(await store.get('p', 's1')).not.toBeNull();

        now += 61_000;

        expect(await store.get('p', 's1')).toBeNull();
        expect(await store.listSecretHashes('p')).toEqual([]);
        expect(store.size).toBe(0);
        store.reset();
        expect(store.list()).toEqual([]);
    });
});

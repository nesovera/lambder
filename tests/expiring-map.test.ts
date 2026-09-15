/**
 * The map every in-memory store is built on: expiry, the amortized sweep, and
 * the ceiling that makes "in memory" a bounded claim.
 *
 * The ceiling is where the interesting rules are. Which entry it takes is a
 * product decision, not a detail: the entries with the most life left are the
 * long-window rate-limit counters and the day-long idempotency records, and
 * the entry that must never be taken at all is a pending idempotency claim,
 * because losing one lets two concurrent retries both execute. The last
 * section drives that through LambderMemoryIdempotencyStore itself, which is where
 * it is reachable.
 */

import { describe, it, expect, vi } from 'vitest';
import { LambderExpiringMap, LambderExpiringMapFullError } from '../src/shared/util/LambderExpiringMap.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';

const START = 1_700_000_000_000;
const startSeconds = Math.floor(START / 1000);

describe('LambderExpiringMap', () => {
    it('drops an entry at its expiry, on a read and on an amortized sweep', () => {
        let now = START;
        const map = new LambderExpiringMap<string>({ now: () => now });
        map.set('a', 'A', startSeconds + 60);

        expect(map.get('a')).toBe('A');

        now += 61_000;

        expect(map.get('a')).toBeUndefined();
        expect(map.size).toBe(0);
    });

    it('replaces a value and forgets everything on clear', () => {
        const map = new LambderExpiringMap<string>({ now: () => START });
        map.set('a', 'A', startSeconds + 60);
        map.set('a', 'B', startSeconds + 60);
        expect(map.values()).toEqual(['B']);

        map.delete('a');
        expect(map.get('a')).toBeUndefined();

        map.set('b', 'B', startSeconds + 60);
        map.clear();
        expect(map.size).toBe(0);
    });

    it('does not accumulate entries nobody reads again', () => {
        // The leak the class exists to close: two of the memory stores used to
        // expire an entry only when something asked for that exact key, so a
        // counter or a record for a key that never returns stayed for the life
        // of the process.
        let now = START;
        const map = new LambderExpiringMap<number>({ now: () => now });
        for(let i = 0; i < 5000; i += 1) map.set(`k-${i}`, i, Math.floor(now / 1000) + 60);
        expect(map.size).toBe(5000);

        now += 61_000;
        // Nothing reads any of those keys again; new traffic alone reclaims them.
        for(let i = 0; i < 300; i += 1) map.set(`fresh-${i}`, i, Math.floor(now / 1000) + 60);

        expect(map.size).toBe(300);
    });

    it('counts and lists live entries without deleting anything, because a read is not a write', () => {
        // size and values() used to run a full sweep, so reading the map wrote
        // to it: a debugger hover, a log line or an assertion changed what the
        // next call saw, and values() deleted from the Map it was iterating.
        let now = START;
        const map = new LambderExpiringMap<string>({ now: () => now });
        map.set('gone', 'G', startSeconds + 10);
        map.set('live', 'L', startSeconds + 600);

        now += 11_000;

        expect(map.size).toBe(1);
        expect(map.values()).toEqual(['L']);
        // Nothing was reclaimed by asking, and the expired entry is still
        // hidden from every read.
        expect(map.get('gone')).toBeUndefined();
        expect(map.values()).toEqual(['L']);
    });

    it('rejects a nonsense ceiling at construction', () => {
        expect(() => new LambderExpiringMap({ maxEntries: 0 })).toThrow(/maxEntries must be a positive integer/);
        expect(() => new LambderExpiringMap({ maxEntries: 1.5 })).toThrow(/maxEntries must be a positive integer/);
    });

    it('rejects an expiry that is not a number, so nothing can be stored for ever', () => {
        // NaN compares false against every clock, so an entry carrying one is
        // neither read, swept nor evicted: it is an immortal record, and the
        // way to get one was a TTL option that arrived as a string.
        const map = new LambderExpiringMap<string>({ now: () => START });

        expect(() => map.set('a', 'A', Number.NaN)).toThrow(/expiresAt must be a positive integer/);
        expect(() => map.set('a', 'A', Number.POSITIVE_INFINITY)).toThrow(/expiresAt must be a positive integer/);
        expect(() => map.set('a', 'A', startSeconds + 0.5)).toThrow(/expiresAt must be a positive integer/);
        expect(() => map.set('a', 'A', 'soon' as unknown as number)).toThrow(/expiresAt must be a positive integer/);
        expect(map.size).toBe(0);
    });

    it('stays bounded when nothing has expired yet and no key ever repeats', () => {
        // Expiry bounds how LONG an entry lives, not how MANY there are. A
        // counter per IP on a monthly window, or an idempotency key per
        // request, never repeats a key, so without a ceiling the map grows
        // until the process dies and "in memory" is just a slower leak.
        const map = new LambderExpiringMap<number>({ now: () => START, maxEntries: 500 });
        // A month out, so the sweep can retire nothing at all.
        const expiresAt = startSeconds + 30 * 24 * 3600;
        for(let i = 0; i < 5000; i += 1) map.set(`k-${i}`, i, expiresAt);

        expect(map.size).toBeLessThanOrEqual(500);
        // Every entry here expires at the same second, so the tie falls to the
        // earliest written and the most recent keys are the ones kept.
        expect(map.get('k-4999')).toBe(4999);
        expect(map.get('k-0')).toBeUndefined();
    });

    it('evicts what expires soonest, not what was written earliest', () => {
        // The entries with the most life left are the ones worth keeping: a
        // monthly rate-limit counter is also one of the OLDEST writes, so
        // evicting by insertion order would retire exactly it, and a flood of
        // short-lived keys could reset a monthly cap.
        const map = new LambderExpiringMap<string>({ now: () => START, maxEntries: 10 });

        map.set('per-month', 'counter', startSeconds + 30 * 24 * 3600);
        map.set('per-day', 'record', startSeconds + 24 * 3600);
        for(let i = 0; i < 200; i += 1) map.set(`flood-${i}`, 'x', startSeconds + 60);

        expect(map.size).toBeLessThanOrEqual(10);
        expect(map.get('per-month')).toBe('counter');
        expect(map.get('per-day')).toBe('record');
        // The flood evicted itself.
        expect(map.get('flood-0')).toBeUndefined();
    });

    it('never evicts an entry written as not evictable, even when it is the soonest to expire', () => {
        // The inversion this option exists for: a pending idempotency claim
        // lives for minutes while the settled record it becomes lives for a
        // day, so "soonest to expire" made the claim the first victim of every
        // flood, which is the one entry whose loss costs correctness.
        const map = new LambderExpiringMap<string>({ now: () => START, maxEntries: 10 });

        map.set('claim', 'pending', startSeconds + 300, { evictable: false });
        for(let i = 0; i < 500; i += 1) map.set(`flood-${i}`, 'x', startSeconds + 24 * 3600);

        expect(map.get('claim')).toBe('pending');
        expect(map.size).toBeLessThanOrEqual(10);
    });

    it('refuses the write rather than evicting when every entry is protected', () => {
        const map = new LambderExpiringMap<string>({ now: () => START, maxEntries: 3 });
        for(let i = 0; i < 3; i += 1) map.set(`claim-${i}`, 'pending', startSeconds + 300, { evictable: false });

        expect(() => map.set('one-more', 'pending', startSeconds + 300, { evictable: false }))
            .toThrow(LambderExpiringMapFullError);
        // The refused write left the map exactly as it was: nothing added and,
        // more to the point, nothing taken from anybody else.
        expect(map.size).toBe(3);
        expect(map.get('one-more')).toBeUndefined();
        expect(map.get('claim-0')).toBe('pending');
    });

    it('lets a protected entry be evicted again once it is rewritten as evictable', () => {
        // How a claim rejoins the pool: settling rewrites it as a record, and
        // a record is as droppable as any other.
        const map = new LambderExpiringMap<string>({ now: () => START, maxEntries: 2 });
        map.set('claim', 'pending', startSeconds + 300, { evictable: false });
        map.set('claim', 'settled', startSeconds + 300);

        for(let i = 0; i < 20; i += 1) map.set(`flood-${i}`, 'x', startSeconds + 24 * 3600);

        expect(map.get('claim')).toBeUndefined();
        expect(map.size).toBeLessThanOrEqual(2);
    });

    it('evicts in batches, so a run of writes at the ceiling does not pay for a pass each', () => {
        // The cost this pins is the full sweep that used to run from inside
        // every ceiling write, and the clock is what makes it countable: a
        // write asks what time it is only in the amortized sweep (one call
        // per 256 writes) and once per eviction batch (one call per one
        // percent of the ceiling, when the batch reclaims expired entries in
        // the same walk). One call per write is the ceiling walking the whole
        // map again for each of them.
        let nowCalls = 0;
        const now = () => { nowCalls += 1; return START; };
        const maxEntries = 2_000;
        const map = new LambderExpiringMap<number>({ now, maxEntries });
        const expiresAt = startSeconds + 30 * 24 * 3600;
        for(let i = 0; i < maxEntries; i += 1) map.set(`fill-${i}`, i, expiresAt + (i % 100));

        nowCalls = 0;
        for(let i = 0; i < 1_000; i += 1) map.set(`hot-${i}`, i, expiresAt + (i % 100));

        expect(nowCalls).toBeLessThanOrEqual(1_000 / 256 + 1_000 / (maxEntries / 100) + 1);
        expect(map.size).toBeLessThanOrEqual(maxEntries);
    });
});

describe('LambderMemoryIdempotencyStore at its ceiling', () => {
    const answer = { statusCode: 200, headers: {}, body: '{"ok":true}', ttlSeconds: 24 * 3600 };

    it('keeps a pending claim while the settled records around it are evicted', async () => {
        // Reproduces the defect whole: with the map full of day-long settled
        // records, a claim's 300-second TTL made it the soonest to expire and
        // therefore the first thing evicted, so the duplicate that arrived
        // while the original was still running got a claim of its own and both
        // executed. The original's complete() then reported "lost".
        const store = new LambderMemoryIdempotencyStore({ now: () => START, maxEntries: 50 });
        for(let i = 0; i < 50; i += 1){
            const token = await store.begin(`settled-${i}`, { pendingTtlSeconds: 300 });
            if(token.state !== 'new') throw new Error('expected a new claim while filling');
            await store.complete(`settled-${i}`, token.ownerToken, answer);
        }

        const first = await store.begin('victim', { pendingTtlSeconds: 300 });
        const duplicate = await store.begin('victim', { pendingTtlSeconds: 300 });

        expect(first.state).toBe('new');
        expect(duplicate.state).toBe('pending');
        if(first.state !== 'new') throw new Error('expected the first request to own the scope');
        expect(await store.complete('victim', first.ownerToken, answer)).toBe('stored');
    });

    it('refuses a duplicate rather than granting a claim it cannot hold', async () => {
        // Every record held is a live claim, so there is nothing droppable and
        // nothing to grant. "pending" is the answer that cannot execute
        // anything twice; the engine turns it into a 409 the caller can retry.
        const store = new LambderMemoryIdempotencyStore({ now: () => START, maxEntries: 3 });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        for(let i = 0; i < 3; i += 1){
            expect((await store.begin(`claim-${i}`, { pendingTtlSeconds: 300 })).state).toBe('new');
        }

        expect((await store.begin('one-more', { pendingTtlSeconds: 300 })).state).toBe('pending');
        // And the claims that were already held are all still held.
        for(let i = 0; i < 3; i += 1){
            expect((await store.begin(`claim-${i}`, { pendingTtlSeconds: 300 })).state).toBe('pending');
        }
        // Saturation is an operator's problem, so it is reported, and reported
        // once: a refusal per request would otherwise be a log per request.
        expect(logged).toHaveBeenCalledTimes(1);
        expect(logged.mock.calls[0]?.[0]).toContain('LambderMemoryIdempotencyStore');
        logged.mockRestore();
    });
});

describe('LambderMemoryRateLimiter at its ceiling', () => {
    it("spends the flood's own counters and keeps the long-window one", async () => {
        // The ceiling is reachable through the option now, which is the point:
        // it was hardcoded, so the real bound of a process running all three
        // memory stores was three times 100,000 and no deployment could say
        // otherwise. What it costs when it is reached is a counter starting
        // its window again, and the ones spent first are the ones with the
        // least life left, so a flood of per-minute keys cannot wipe the
        // monthly cap it is trying to get past.
        const limiter = new LambderMemoryRateLimiter({ now: () => START, maxEntries: 4 });
        await limiter.isRateLimited('victim', { perMonth: 2 });
        expect(limiter.countOf('victim', 'perMonth')).toBe(1);

        for(let i = 0; i < 50; i += 1) await limiter.isRateLimited(`flood-${i}`, { perMin: 100 });

        expect(limiter.countOf('victim', 'perMonth')).toBe(1);
        expect(limiter.countOf('flood-0', 'perMin')).toBe(0);
    });
});

describe('LambderExpiringMap at a ceiling of protected entries', () => {
    it('refuses an evictable write rather than storing nothing, and never takes the write as its own victim', () => {
        // Evicting the entry just written answered the write with success
        // while the map kept nothing: the caller's get() came back empty.
        let now = 1_700_000_000_000;
        const far = Math.floor(now / 1000) + 3600;
        const map = new LambderExpiringMap<string>({ now: () => now, maxEntries: 3 });
        map.set('claim-a', 'a', far, { evictable: false });
        map.set('claim-b', 'b', far, { evictable: false });
        map.set('claim-c', 'c', far, { evictable: false });
        expect(() => map.set('record', 'r', far)).toThrow(LambderExpiringMapFullError);
        expect(map.get('record')).toBeUndefined();
        expect(map.size).toBe(3);
        now += 1;
    });

    it('reclaims an expired protected entry before it evicts a live evictable one', () => {
        let now = 1_700_000_000_000;
        const nowSeconds = () => Math.floor(now / 1000);
        const map = new LambderExpiringMap<string>({ now: () => now, maxEntries: 5 });
        for(const name of ['dead-1', 'dead-2', 'dead-3']) map.set(name, name, nowSeconds() + 1, { evictable: false });
        map.set('live-1', 'live', nowSeconds() + 3600);
        map.set('live-2', 'live', nowSeconds() + 3600);
        now += 5_000;
        map.set('newcomer', 'new', nowSeconds() + 3600);
        expect(map.get('live-1')).toBe('live');
        expect(map.get('live-2')).toBe('live');
        expect(map.get('newcomer')).toBe('new');
        expect(map.get('dead-1')).toBeUndefined();
    });
});

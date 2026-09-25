/**
 * One set of rules, every implementation of a store interface.
 *
 * Tests run against the memory implementations while production runs against
 * the DynamoDB ones, which is only sound while the two behave identically.
 * The compiler checks a method's SIGNATURE, not its semantics, so every rule
 * an engine relies on is asserted once and driven through each implementation.
 *
 * The DynamoDB stores run against the in-memory DynamoDB from helpers, which
 * models the conditional writes they depend on. Time comes from one injected
 * clock, and the system clock deliberately does NOT move with it: a store
 * that read Date.now() behind its `now` option would see time standing still
 * and fail the expiry rules, rather than pass because the test moved the world.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderDdbIdempotencyStore } from '../src/stores/LambderDdbIdempotencyStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { LambderDdbRateLimiter } from '../src/stores/LambderDdbRateLimiter.js';
import type { LambderIdempotencyStore } from '../src/shared/contracts/LambderIdempotencyStore.js';
import type { LambderRateLimiter } from '../src/shared/contracts/LambderRateLimiter.js';
import { RATE_LIMIT_WINDOWS } from '../src/shared/contracts/LambderRateLimiter.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderDdbSessionStore } from '../src/stores/LambderDdbSessionStore.js';
import type { LambderSessionStore, LambderSessionRecord } from '../src/shared/contracts/LambderSessionStore.js';
import { MemoryDdb, MemoryDdbDocument } from './helpers.js';

const START = 1_700_000_000_000;

/** The clock every store below is built with; `setClock` is the only way time moves here. */
let clockMillis = START;
const testClock = (): number => clockMillis;
const setClock = (millis: number): void => { clockMillis = millis; };

// Fake timers for the session store, which has no injectable clock; the two
// policy stores ignore them and read testClock.
beforeEach(() => { setClock(START); vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
// LambderIdempotencyStore
// ---------------------------------------------------------------------------

/**
 * An implementation, plus the one input the rules cannot state in the
 * abstract: a body this store will not hold. The budget is the store's own
 * business (DynamoDB measures what it writes after Brotli, the memory store
 * measures the bytes), so each says what "too big" means for it.
 */
type IdempotencyImplementation = {
    name: string;
    create: () => LambderIdempotencyStore;
    oversizedBody: string;
    /** The other side of the same budget: the largest body this store does hold, so the boundary is pinned from both directions. */
    largestStorableBody: string;
};

/**
 * Near-incompressible, so the DynamoDB store cannot get it under its budget
 * with Brotli. Built once: a megabyte of it is not cheap to make.
 */
const incompressibleBody = (() => {
    // xorshift32: every step stays inside 32 bits, so the sequence does not
    // lose precision and collapse into something Brotli can crush.
    let seed = 0x9e3779b9;
    const characters: string[] = [];
    for(let i = 0; i < 600_000; i += 1){
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        characters.push(String.fromCharCode(33 + (seed % 94)));
    }
    return characters.join('');
})();

const idempotencyImplementations: IdempotencyImplementation[] = [
    {
        name: 'LambderMemoryIdempotencyStore',
        create: () => new LambderMemoryIdempotencyStore({ maxBodyBytes: 64, now: testClock }),
        oversizedBody: 'x'.repeat(200),
        largestStorableBody: 'x'.repeat(64),
    },
    {
        name: 'LambderDdbIdempotencyStore',
        create: () => new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), now: testClock }),
        oversizedBody: incompressibleBody,
        // Far past the item budget raw and far under it stored, which is the
        // thing this store's budget means: it is on the bytes written.
        largestStorableBody: 'a'.repeat(1_000_000),
    },
    {
        // The other supported edge of the same option, and the one the cache
        // and the session store both ship as their default: compress
        // everything. It is the configuration where a body the compressor
        // cannot describe (an empty one) reaches the table.
        name: 'LambderDdbIdempotencyStore (compression from the first byte)',
        create: () => new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), compression: { minBytes: 0 }, now: testClock }),
        oversizedBody: incompressibleBody,
        largestStorableBody: 'a'.repeat(1_000_000),
    },
    {
        // A supported configuration, and the one where the budget is easiest
        // to forget: with nothing to compress, the body goes to the table as
        // it is, and DynamoDB answers an oversized item with a
        // ValidationException, which is not a conditional-check failure and so
        // escapes as a store error rather than a "too-large".
        name: 'LambderDdbIdempotencyStore (compression off)',
        create: () => new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), compression: false, now: testClock }),
        oversizedBody: incompressibleBody,
        // Exactly the stored-body budget, with nothing compressing it down to fit.
        largestStorableBody: 'a'.repeat(350_000),
    },
];

/**
 * A granted claim's owner token, or a failure. Every rule below is about what
 * happens AFTER a claim is granted, so a rule that returned early on a claim
 * that was not new would pass on a store that grants nothing. A helper that
 * throws is the difference between testing the store and testing that the
 * file runs.
 */
const claimNew = async (store: LambderIdempotencyStore, scopeKey: string, pendingTtlSeconds = 60): Promise<string> => {
    const claim = await store.begin(scopeKey, { pendingTtlSeconds, fingerprint: 'request-1' });
    if(claim.state !== 'new') throw new Error(`expected a new claim on "${scopeKey}", got "${claim.state}"`);
    return claim.ownerToken;
};

describe.each(idempotencyImplementations)('LambderIdempotencyStore conformance: $name', ({ create, oversizedBody, largestStorableBody }) => {
    const answer = { statusCode: 201, headers: { 'Content-Type': ['application/json'] }, body: '{"ok":true}', fingerprint: 'request-1', ttlSeconds: 60 };

    it('keeps the request fingerprint through the claim and the settled record, so the engine can tell a retry from another request', async () => {
        const store = create();
        const owner = await claimNew(store, 'scope-f');
        expect(await store.begin('scope-f', { pendingTtlSeconds: 60, fingerprint: 'request-2' })).toEqual({ state: 'pending', fingerprint: 'request-1' });

        expect(await store.complete('scope-f', owner, { ...answer, fingerprint: 'request-1' })).toBe('stored');
        expect(await store.peek('scope-f')).toMatchObject({ statusCode: 201, fingerprint: 'request-1' });
        expect(await store.begin('scope-f', { pendingTtlSeconds: 60, fingerprint: 'request-2' })).toMatchObject({ state: 'done', fingerprint: 'request-1' });
    });

    it('claims a free scope, refuses a concurrent claim, and hides the record until it is settled', async () => {
        const store = create();

        const ownerToken = await claimNew(store, 's');
        expect(ownerToken).toBeTruthy();

        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('pending');
        expect(await store.peek('s')).toBeNull();
    });

    it('settles by the owner, then replays the answer through both peek and begin', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 's');

        expect(await store.complete('s', ownerToken, answer)).toBe('stored');

        const peeked = await store.peek('s');
        expect(peeked).toEqual({ statusCode: 201, headers: { 'Content-Type': ['application/json'] }, body: '{"ok":true}', fingerprint: 'request-1' });
        const begun = await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' });
        expect(begun).toMatchObject({ state: 'done', statusCode: 201, body: '{"ok":true}' });
    });

    it('hands back a copy, so a caller writing onto what it read cannot rewrite the record', async () => {
        // The pipeline applies the replaying call's own headers onto the answer
        // it got back. A store that returns its own map lets one call's
        // Set-Cookie become part of the record and reach every later replay.
        const store = create();
        const ownerToken = await claimNew(store, 's');
        await store.complete('s', ownerToken, answer);

        const peeked = await store.peek('s');
        peeked!.headers['Set-Cookie'] = ['sid=; Max-Age=0'];
        const begun = await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' });
        if(begun.state === 'done') begun.headers['Set-Cookie'] = ['sid=; Max-Age=0'];

        expect((await store.peek('s'))?.headers['Set-Cookie']).toBeUndefined();
    });

    it('reports a settle from a non-owner as lost, and writes nothing', async () => {
        const store = create();
        await claimNew(store, 's');

        expect(await store.complete('s', 'not-the-owner', answer)).toBe('lost');
        expect(await store.peek('s')).toBeNull();
    });

    it('reports a body it cannot hold as too-large, and writes nothing', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 's');

        expect(await store.complete('s', ownerToken, { ...answer, body: oversizedBody })).toBe('too-large');
        expect(await store.peek('s')).toBeNull();
        // The claim survives, so the caller can release it and let retries run.
        await store.abandon('s', ownerToken);
        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('new');
    });

    it('decides size before ownership, the only order a single conditional write allows', async () => {
        const store = create();
        await claimNew(store, 's');

        // A store settles in one write, so the only thing it can judge before
        // reaching the table is whether the body fits. Both answers are safe
        // for the caller; what matters is that they agree.
        expect(await store.complete('s', 'not-the-owner', { ...answer, body: oversizedBody })).toBe('too-large');
    });

    it('releases a claim only for its owner', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 's');

        await store.abandon('s', 'not-the-owner');
        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('pending');

        await store.abandon('s', ownerToken);
        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('new');
    });

    it('lets a pending claim expire, so a crashed original does not block retries forever', async () => {
        const store = create();
        await claimNew(store, 's', 30);

        setClock(START + 31_000);

        expect((await store.begin('s', { pendingTtlSeconds: 30, fingerprint: 'request-1' })).state).toBe('new');
    });

    it('reports an owner settling after its own claim expired as lost', async () => {
        // A claim that ran out is a claim the owner does not hold, whatever
        // the storage does about it. DynamoDB's TTL deletion is lazy, so a
        // store that checked only the owner token would usually still find
        // the item and say "stored", and the answer would depend on whether
        // AWS had swept yet.
        const store = create();
        const ownerToken = await claimNew(store, 's', 30);

        setClock(START + 31_000);

        expect(await store.complete('s', ownerToken, answer)).toBe('lost');
        expect(await store.peek('s')).toBeNull();
    });

    it('stops replaying a settled record once its ttl runs out', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 's');
        await store.complete('s', ownerToken, { ...answer, ttlSeconds: 60 });

        setClock(START + 61_000);

        expect(await store.peek('s')).toBeNull();
        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('new');
    });

    it('replays an empty body', async () => {
        // A 204, or a 200 with an empty body, is an answer like any other, and
        // the replay has to be the same answer. A compressed empty body must
        // not declare a length the codec refuses on the way back: peek and
        // begin would throw for the record's whole TTL, the engine would fail
        // open on each, and every retry would execute again.
        const store = create();
        const ownerToken = await claimNew(store, 's');

        expect(await store.complete('s', ownerToken, { ...answer, statusCode: 204, body: '' })).toBe('stored');

        expect(await store.peek('s')).toEqual({ statusCode: 204, headers: { 'Content-Type': ['application/json'] }, body: '', fingerprint: 'request-1' });
        expect(await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).toMatchObject({ state: 'done', statusCode: 204, body: '' });
    });

    it('keeps scopes apart', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 'a');
        await store.complete('a', ownerToken, answer);

        expect(await store.peek('b')).toBeNull();
        expect((await store.begin('b', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('new');
    });

    it('takes a copy of what it is given, so a caller writing onto the record afterwards cannot rewrite it', async () => {
        // The other half of the copy rule. The pipeline hands complete() the
        // answer object and goes on writing the call's own headers into it
        // afterwards, so a store that kept the caller's map would take one
        // request's Set-Cookie into the stored record and replay it to
        // everybody else.
        const store = create();
        const ownerToken = await claimNew(store, 's');
        const record: { statusCode: number; headers: Record<string, string[]>; body: string; fingerprint: string; ttlSeconds: number } =
            { statusCode: 201, headers: { 'Content-Type': ['application/json'] }, body: '{"ok":true}', fingerprint: 'request-1', ttlSeconds: 60 };

        expect(await store.complete('s', ownerToken, record)).toBe('stored');
        record.headers['Set-Cookie'] = ['sid=planted'];
        record.headers['Content-Type'] = ['text/plain'];
        record.statusCode = 500;

        expect(await store.peek('s')).toEqual({
            statusCode: 201,
            headers: { 'Content-Type': ['application/json'] },
            body: '{"ok":true}',
            fingerprint: 'request-1',
        });
    });

    it('holds a body that is exactly at its budget, the other side of the too-large boundary', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 's');

        expect(await store.complete('s', ownerToken, { ...answer, body: largestStorableBody })).toBe('stored');
        expect((await store.peek('s'))?.body).toBe(largestStorableBody);
    });

    it('counts the expiry second itself as expired, on the claim and on the record', async () => {
        // Whether expiry is `<=` or `<` decides what happens in the second a
        // claim runs out, and the two implementations settle it in different
        // places: one compares in the process, the other in a DynamoDB
        // condition. On the boundary second the claim is gone and the record
        // no longer replays.
        const store = create();
        await claimNew(store, 's', 30);
        setClock(START + 30_000);
        expect((await store.begin('s', { pendingTtlSeconds: 30, fingerprint: 'request-1' })).state).toBe('new');

        const second = create();
        setClock(START);
        const secondToken = await claimNew(second, 's');
        await second.complete('s', secondToken, { ...answer, ttlSeconds: 60 });
        setClock(START + 60_000);
        expect(await second.peek('s')).toBeNull();
    });

    it('lets the owner settle the same scope twice, so a retried complete is not a lost claim', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 's');

        expect(await store.complete('s', ownerToken, answer)).toBe('stored');
        expect(await store.complete('s', ownerToken, { ...answer, body: '{"ok":2}' })).toBe('stored');
        expect((await store.peek('s'))?.body).toBe('{"ok":2}');
    });

    it('keeps the settled record when its own owner abandons after completing', async () => {
        // Regression: abandon was conditional on the owner token alone, and a
        // settled record still carries it. The engine abandons after a
        // complete() that threw, and one whose response was lost may have
        // landed: deleting the stored answer handed the client's retry a free
        // scope, and the operation ran twice. Only a pending claim is released.
        const store = create();
        const ownerToken = await claimNew(store, 's');
        await store.complete('s', ownerToken, answer);

        await store.abandon('s', ownerToken);

        expect(await store.peek('s')).toMatchObject({ statusCode: 201, body: '{"ok":true}', fingerprint: 'request-1' });
        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('done');
    });

    it('treats a zero pendingTtlSeconds as a claim that is already over, rather than one that never ends', async () => {
        // The engine validates the option, so this is about what a store does
        // when one reaches it anyway: the claim expires in the second it is
        // taken, so the next request claims the scope rather than seeing a
        // pending original, and the first owner has already lost it.
        const store = create();
        const ownerToken = await claimNew(store, 's', 0);

        expect((await store.begin('s', { pendingTtlSeconds: 0, fingerprint: 'request-1' })).state).toBe('new');
        expect(await store.complete('s', ownerToken, answer)).toBe('lost');
    });

    it('grants exactly one claim when two requests claim the same scope at once', async () => {
        // The rule the whole store exists for: begin() has to be atomic, not
        // read-then-write.
        const store = create();

        const claims = await Promise.all([
            store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' }),
            store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' }),
        ]);

        expect(claims.filter((claim) => claim.state === 'new')).toHaveLength(1);
        expect(claims.filter((claim) => claim.state === 'pending')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// LambderRateLimiter
// ---------------------------------------------------------------------------

const rateLimiterImplementations: { name: string; create: () => LambderRateLimiter }[] = [
    { name: 'LambderMemoryRateLimiter', create: () => new LambderMemoryRateLimiter({ now: testClock }) },
    { name: 'LambderDdbRateLimiter', create: () => new LambderDdbRateLimiter({ tableName: 'test-table', client: new MemoryDdb(), now: testClock }) },
];

describe.each(rateLimiterImplementations)('LambderRateLimiter conformance: $name', ({ create }) => {
    it('counts attempts and refuses the one past the limit, naming the window', async () => {
        const limiter = create();

        expect(await limiter.isRateLimited('k', { perMin: 2 })).toBe(false);
        expect(await limiter.isRateLimited('k', { perMin: 2 })).toBe(false);

        const refused = await limiter.isRateLimited('k', { perMin: 2 });
        expect(refused).toMatchObject({ window: 'perMin', limit: 2 });
        if(refused === false) throw new Error('expected the third attempt to be refused');
        expect(refused.resetAt).toBeGreaterThan(Math.floor(START / 1000));
    });

    it('counts attempts rather than allowed requests, so a refusal does not reset anything', async () => {
        const limiter = create();
        await limiter.isRateLimited('k', { perMin: 1 });

        expect(await limiter.isRateLimited('k', { perMin: 1 })).not.toBe(false);
        expect(await limiter.isRateLimited('k', { perMin: 1 })).not.toBe(false);
    });

    it('does not enforce a window the policy leaves out or caps at zero', async () => {
        const limiter = create();

        for(let i = 0; i < 5; i += 1){
            expect(await limiter.isRateLimited('k', { perHour: 0 })).toBe(false);
        }
        expect(await limiter.isRateLimited('k', {})).toBe(false);
    });

    it('reports the smallest exceeded window, since that is the one evaluated first', async () => {
        const limiter = create();
        await limiter.isRateLimited('k', { perMin: 1, perHour: 10 });

        expect(await limiter.isRateLimited('k', { perMin: 1, perHour: 10 })).toMatchObject({ window: 'perMin' });
    });

    it('keeps tracker keys apart', async () => {
        const limiter = create();
        await limiter.isRateLimited('a', { perMin: 1 });

        expect(await limiter.isRateLimited('b', { perMin: 1 })).toBe(false);
    });

    it('starts a fresh count once the fixed window rolls over', async () => {
        const limiter = create();
        await limiter.isRateLimited('k', { perMin: 1 });
        expect(await limiter.isRateLimited('k', { perMin: 1 })).not.toBe(false);

        setClock(START + 61_000);

        expect(await limiter.isRateLimited('k', { perMin: 1 })).toBe(false);
    });
});

/**
 * Every window in the shared table, driven through both implementations.
 * Without it a limiter that handled perMin and perHour and ignored the rest
 * would pass every rule in this file, and the agreement would rest on the
 * shared import rather than on any assertion.
 */
describe.each(rateLimiterImplementations)('LambderRateLimiter conformance, every window: $name', ({ create }) => {
    it.each(RATE_LIMIT_WINDOWS)('enforces $key and resets after it', async ({ key, seconds }) => {
        const limiter = create();
        const policy = { [key]: 1 } as Record<string, number>;

        expect(await limiter.isRateLimited('k', policy)).toBe(false);
        expect(await limiter.isRateLimited('k', policy)).toMatchObject({ window: key, limit: 1 });

        setClock(START + (seconds + 1) * 1000);
        expect(await limiter.isRateLimited('k', policy)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// LambderSessionStore
// ---------------------------------------------------------------------------

/**
 * The whole session test file runs on the memory store while production runs
 * on DynamoDB, so this is what checks that the two agree on a missing record,
 * on partition isolation, on skipping a record that is gone, and on the
 * dataVersion every conditioned write depends on.
 */
const sessionStoreImplementations: { name: string; create: () => LambderSessionStore; isMemoryOnly: boolean }[] = [
    { name: 'LambderMemorySessionStore', create: () => new LambderMemorySessionStore(), isMemoryOnly: true },
    {
        name: 'LambderDdbSessionStore',
        create: () => new LambderDdbSessionStore({ tableName: 'test-sessions', client: new MemoryDdbDocument() as any }),
        isMemoryOnly: false,
    },
    {
        // The other supported setting, and a different item shape: the data
        // as a plain map rather than Brotli bytes, so every write that holds
        // data swaps attributes the other way round.
        name: 'LambderDdbSessionStore (compression off)',
        create: () => new LambderDdbSessionStore({ tableName: 'test-sessions', client: new MemoryDdbDocument() as any, compression: false }),
        isMemoryOnly: false,
    },
];

const sessionRecord = (over: Partial<LambderSessionRecord> = {}): LambderSessionRecord => ({
    sessionKeyHash: 'partition-a',
    secretHash: 'secret-1',
    csrfTokenHash: 'csrf-1',
    sessionKey: 'user-1',
    data: { name: 'Ada' },
    createdAt: Math.floor(START / 1000),
    expiresAt: Math.floor(START / 1000) + 3600,
    lastAccessedAt: Math.floor(START / 1000),
    ttlInSeconds: 3600,
    dataVersion: 0,
    ...over,
});

describe.each(sessionStoreImplementations)('LambderSessionStore conformance: $name', ({ create, isMemoryOnly }) => {
    it('says whether it outlives the process, which is what gates non-cryptographic hashing', () => {
        expect(create().isMemoryOnly).toBe(isMemoryOnly);
    });

    it('round-trips a record under its two hashes', async () => {
        const store = create();
        await store.create(sessionRecord());

        const read = await store.get('partition-a', 'secret-1');
        expect(read).toMatchObject({ sessionKey: 'user-1', csrfTokenHash: 'csrf-1', data: { name: 'Ada' }, dataVersion: 0 });
    });

    it('answers null for a record that is absent, never throws', async () => {
        const store = create();
        expect(await store.get('partition-a', 'nope')).toBeNull();
        expect(await store.get('no-such-partition', 'secret-1')).toBeNull();
    });

    it('refuses to create a record over an existing one: a session is minted once', async () => {
        const store = create();
        await store.create(sessionRecord());
        await expect(store.create(sessionRecord({ data: { name: 'Grace' } }))).rejects.toThrow();

        expect(await store.get('partition-a', 'secret-1')).toMatchObject({ data: { name: 'Ada' } });
        expect(await store.listSecretHashes('partition-a')).toEqual(['secret-1']);
    });

    it('lists the secret hashes of one partition and nothing from another', async () => {
        const store = create();
        await store.create(sessionRecord({ secretHash: 'secret-1' }));
        await store.create(sessionRecord({ secretHash: 'secret-2' }));
        await store.create(sessionRecord({ sessionKeyHash: 'partition-b', secretHash: 'secret-3' }));

        expect((await store.listSecretHashes('partition-a')).sort()).toEqual(['secret-1', 'secret-2']);
        expect(await store.listSecretHashes('partition-b')).toEqual(['secret-3']);
        expect(await store.listSecretHashes('partition-empty')).toEqual([]);
    });

    it('deletes one session without touching its siblings', async () => {
        const store = create();
        await store.create(sessionRecord({ secretHash: 'secret-1' }));
        await store.create(sessionRecord({ secretHash: 'secret-2' }));

        expect(await store.delete('partition-a', 'secret-1')).toMatchObject({ secretHash: 'secret-1', sessionKey: 'user-1' });

        expect(await store.get('partition-a', 'secret-1')).toBeNull();
        expect(await store.get('partition-a', 'secret-2')).not.toBeNull();
    });

    it('hands back the record as it was stored when deleted, a later write included', async () => {
        const store = create();
        await store.create(sessionRecord());
        await store.update('partition-a', 'secret-1', { data: { name: 'Grace' } });
        expect((await store.delete('partition-a', 'secret-1'))?.data).toEqual({ name: 'Grace' });
    });

    it('deleting a record that is already gone is a no-op that answers null, not an error', async () => {
        const store = create();
        await expect(store.delete('partition-a', 'never-existed')).resolves.toBeNull();
    });

    it('updates the named fields of a live record and leaves the rest', async () => {
        const store = create();
        await store.create(sessionRecord());
        const at = Math.floor(START / 1000) + 30;

        expect(await store.update('partition-a', 'secret-1', { dataExpiresAt: at })).toBe('updated');
        expect(await store.update('partition-a', 'secret-1', { data: { name: 'Grace' }, expiresAt: at + 7200, lastAccessedAt: at })).toBe('updated');

        expect(await store.get('partition-a', 'secret-1')).toMatchObject({
            data: { name: 'Grace' }, dataExpiresAt: at, expiresAt: at + 7200, lastAccessedAt: at,
            sessionKey: 'user-1', csrfTokenHash: 'csrf-1', createdAt: Math.floor(START / 1000),
        });
    });

    it('never brings back a record that vanished: an update of one answers missing', async () => {
        // A logout that lands while a renewal is in flight must stay a
        // logout, so an update of a deleted record writes nothing at all.
        const store = create();
        await store.create(sessionRecord());
        await store.delete('partition-a', 'secret-1');

        expect(await store.update('partition-a', 'secret-1', { expiresAt: Math.floor(START / 1000) + 7200 })).toBe('missing');
        expect(await store.update('partition-a', 'secret-1', { data: { name: 'Grace' } }, { dataVersion: 0 })).toBe('missing');
        expect(await store.get('partition-a', 'secret-1')).toBeNull();
    });

    it('moves dataVersion by one on each write of data or dataExpiresAt, and on no other write', async () => {
        const store = create();
        await store.create(sessionRecord());
        const at = Math.floor(START / 1000) + 30;
        const versionNow = async () => (await store.get('partition-a', 'secret-1'))?.dataVersion;

        await store.update('partition-a', 'secret-1', { lastAccessedAt: at, expiresAt: at + 3600 });
        expect(await versionNow()).toBe(0);
        await store.update('partition-a', 'secret-1', { data: { name: 'Grace' } });
        expect(await versionNow()).toBe(1);
        await store.update('partition-a', 'secret-1', { dataExpiresAt: at });
        expect(await versionNow()).toBe(2);
        // One write carrying both, and the slide beside them, is one step.
        await store.update('partition-a', 'secret-1', { data: { name: 'Lin' }, dataExpiresAt: at + 600, lastAccessedAt: at });
        expect(await versionNow()).toBe(3);
    });

    it('applies a conditioned update only while dataVersion is the one it was read with, and says stale otherwise', async () => {
        const store = create();
        await store.create(sessionRecord());
        const at = Math.floor(START / 1000) + 30;

        expect(await store.update('partition-a', 'secret-1', { data: { name: 'Grace' }, dataExpiresAt: at }, { dataVersion: 1 })).toBe('stale');
        expect(await store.update('partition-a', 'secret-1', { data: { name: 'Grace' }, dataExpiresAt: at }, { dataVersion: 0 })).toBe('updated');
        // That write moved the version, so the one it named no longer holds.
        expect(await store.update('partition-a', 'secret-1', { data: { name: 'Lin' } }, { dataVersion: 0 })).toBe('stale');
        expect(await store.update('partition-a', 'secret-1', { data: { name: 'Lin' } }, { dataVersion: 1 })).toBe('updated');

        expect(await store.get('partition-a', 'secret-1')).toMatchObject({ data: { name: 'Lin' }, dataExpiresAt: at, dataVersion: 2 });
    });

    it('answers stale after a mark that wrote the deadline already stored, in the second a refresh read it', async () => {
        // The record falls due this second, a read starts its refresh, and a
        // revocation marks it due in that same second. The deadline reads
        // exactly as the refresh read it, so a condition on the deadline let
        // the refresh land data derived before the revocation for a whole
        // data TTL. Only the version shows the mark.
        const store = create();
        const now = Math.floor(START / 1000);
        await store.create(sessionRecord({ dataExpiresAt: now }));
        const read = (await store.get('partition-a', 'secret-1'))!;

        expect(await store.update('partition-a', 'secret-1', { dataExpiresAt: now })).toBe('updated');

        expect(await store.update('partition-a', 'secret-1', { data: { name: 'Grace' }, dataExpiresAt: now + 600 }, { dataVersion: read.dataVersion })).toBe('stale');
        expect(await store.get('partition-a', 'secret-1')).toMatchObject({ data: { name: 'Ada' }, dataExpiresAt: now });
    });

    it('answers stale after a second mark in the second of the first, which a refresh of the first did not see', async () => {
        // The first revocation marks the record due, a read starts a refresh
        // that sees only that one, and a second revocation marks it again in
        // the same second. Both marks write the same deadline, so only the
        // version tells the refresh that it is one revocation behind.
        const store = create();
        const now = Math.floor(START / 1000);
        await store.create(sessionRecord({ dataExpiresAt: now + 600 }));
        await store.update('partition-a', 'secret-1', { dataExpiresAt: now });
        const read = (await store.get('partition-a', 'secret-1'))!;

        await store.update('partition-a', 'secret-1', { dataExpiresAt: now });

        expect(await store.update('partition-a', 'secret-1', { data: { name: 'Grace' }, dataExpiresAt: now + 600 }, { dataVersion: read.dataVersion })).toBe('stale');
        expect(await store.get('partition-a', 'secret-1')).toMatchObject({ data: { name: 'Ada' }, dataExpiresAt: now, dataVersion: 2 });
    });

    it('holds data with an undefined inside it the way JSON does, rather than refusing it', async () => {
        const store = create();
        await store.create(sessionRecord({ data: { name: 'Ada', nickname: undefined } }));
        await store.update('partition-a', 'secret-1', { data: { name: 'Grace', nickname: undefined } });

        expect((await store.get('partition-a', 'secret-1'))?.data).toEqual({ name: 'Grace' });
    });
});

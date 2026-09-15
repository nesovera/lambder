/**
 * One set of rules, every implementation of a store interface.
 *
 * The policy and session layers are written against interfaces, and tests run
 * against the memory implementations while production runs against the
 * DynamoDB ones. That is only sound while the two behave identically, and
 * nothing here is checked by the compiler: a method's SIGNATURE is, its
 * semantics are not. So every rule an engine relies on is asserted once and
 * driven through each implementation.
 *
 * The DynamoDB stores run against the in-memory DynamoDB from helpers, which
 * models the conditional writes they depend on. Time comes from one injected
 * clock, and the system clock deliberately does NOT move with it: every store
 * here takes a `now`, so a store that read Date.now() behind the option would
 * see time standing still and fail the expiry rules instead of passing them
 * because the test moved the world.
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
 * happens AFTER a claim is granted, and the `if(claim.state !== 'new') return`
 * each of them used to open with made it pass on a store that granted nothing:
 * with begin() mutated to always answer "pending", ten of these rules stayed
 * green. A helper that throws is the difference between testing the store and
 * testing that the file runs.
 */
const claimNew = async (store: LambderIdempotencyStore, scopeKey: string, pendingTtlSeconds = 60): Promise<string> => {
    const claim = await store.begin(scopeKey, { pendingTtlSeconds });
    if(claim.state !== 'new') throw new Error(`expected a new claim on "${scopeKey}", got "${claim.state}"`);
    return claim.ownerToken;
};

describe.each(idempotencyImplementations)('LambderIdempotencyStore conformance: $name', ({ create, oversizedBody, largestStorableBody }) => {
    const answer = { statusCode: 201, headers: { 'Content-Type': ['application/json'] }, body: '{"ok":true}', ttlSeconds: 60 };

    it('claims a free scope, refuses a concurrent claim, and hides the record until it is settled', async () => {
        const store = create();

        const ownerToken = await claimNew(store, 's');
        expect(ownerToken).toBeTruthy();

        expect((await store.begin('s', { pendingTtlSeconds: 60 })).state).toBe('pending');
        expect(await store.peek('s')).toBeNull();
    });

    it('settles by the owner, then replays the answer through both peek and begin', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 's');

        expect(await store.complete('s', ownerToken, answer)).toBe('stored');

        const peeked = await store.peek('s');
        expect(peeked).toEqual({ statusCode: 201, headers: { 'Content-Type': ['application/json'] }, body: '{"ok":true}' });
        const begun = await store.begin('s', { pendingTtlSeconds: 60 });
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
        const begun = await store.begin('s', { pendingTtlSeconds: 60 });
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
        expect((await store.begin('s', { pendingTtlSeconds: 60 })).state).toBe('new');
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
        expect((await store.begin('s', { pendingTtlSeconds: 60 })).state).toBe('pending');

        await store.abandon('s', ownerToken);
        expect((await store.begin('s', { pendingTtlSeconds: 60 })).state).toBe('new');
    });

    it('lets a pending claim expire, so a crashed original does not block retries forever', async () => {
        const store = create();
        await claimNew(store, 's', 30);

        setClock(START + 31_000);

        expect((await store.begin('s', { pendingTtlSeconds: 30 })).state).toBe('new');
    });

    it('reports an owner settling after its own claim expired as lost', async () => {
        // The case that sat between two existing rules and was covered by
        // neither, and the two implementations answered it differently: the
        // memory store drops an expired entry on read and said "lost", while
        // DynamoDB checked only the owner token and, because TTL deletion is
        // lazy, usually still had the item and said "stored". So the answer
        // depended on whether AWS had swept yet. A claim that ran out is a
        // claim the owner no longer holds, whatever the storage does about it.
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
        expect((await store.begin('s', { pendingTtlSeconds: 60 })).state).toBe('new');
    });

    it('replays an empty body', async () => {
        // A 204, or a 200 with an empty body, is an answer like any other, and
        // the replay has to be the same answer. The DynamoDB store compresses
        // from a configurable size, and compressing zero bytes wrote a record
        // declaring a length of zero, which the codec refuses on the way back:
        // peek and begin both threw for the record's whole TTL, the engine
        // failed open on each, and every retry executed again.
        const store = create();
        const ownerToken = await claimNew(store, 's');

        expect(await store.complete('s', ownerToken, { ...answer, statusCode: 204, body: '' })).toBe('stored');

        expect(await store.peek('s')).toEqual({ statusCode: 204, headers: { 'Content-Type': ['application/json'] }, body: '' });
        expect(await store.begin('s', { pendingTtlSeconds: 60 })).toMatchObject({ state: 'done', statusCode: 204, body: '' });
    });

    it('keeps scopes apart', async () => {
        const store = create();
        const ownerToken = await claimNew(store, 'a');
        await store.complete('a', ownerToken, answer);

        expect(await store.peek('b')).toBeNull();
        expect((await store.begin('b', { pendingTtlSeconds: 60 })).state).toBe('new');
    });

    it('takes a copy of what it is given, so a caller writing onto the record afterwards cannot rewrite it', async () => {
        // The other half of the copy rule, and the half nothing asserted. The
        // pipeline hands complete() the answer object and goes on writing the
        // call's own headers into it afterwards, so a store that kept the
        // caller's map would take one request's Set-Cookie into the stored
        // record and replay it to everybody else.
        const store = create();
        const ownerToken = await claimNew(store, 's');
        const record: { statusCode: number; headers: Record<string, string[]>; body: string; ttlSeconds: number } =
            { statusCode: 201, headers: { 'Content-Type': ['application/json'] }, body: '{"ok":true}', ttlSeconds: 60 };

        expect(await store.complete('s', ownerToken, record)).toBe('stored');
        record.headers['Set-Cookie'] = ['sid=planted'];
        record.headers['Content-Type'] = ['text/plain'];
        record.statusCode = 500;

        expect(await store.peek('s')).toEqual({
            statusCode: 201,
            headers: { 'Content-Type': ['application/json'] },
            body: '{"ok":true}',
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
        expect((await store.begin('s', { pendingTtlSeconds: 30 })).state).toBe('new');

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

    it('drops the settled record when its own owner abandons after completing', async () => {
        // Abandon is conditional on the owner token, and a settled record
        // still carries it, so the call that means "nothing to store" after a
        // record was stored deletes that record in both implementations. The
        // engine must therefore never abandon a claim it has completed, and a
        // third implementation must not decide to keep it instead.
        const store = create();
        const ownerToken = await claimNew(store, 's');
        await store.complete('s', ownerToken, answer);

        await store.abandon('s', ownerToken);

        expect(await store.peek('s')).toBeNull();
        expect((await store.begin('s', { pendingTtlSeconds: 60 })).state).toBe('new');
    });

    it('treats a zero pendingTtlSeconds as a claim that is already over, rather than one that never ends', async () => {
        // The engine validates the option, so this is about what a store does
        // when one reaches it anyway: the claim expires in the second it is
        // taken, so the next request claims the scope rather than seeing a
        // pending original, and the first owner has already lost it.
        const store = create();
        const ownerToken = await claimNew(store, 's', 0);

        expect((await store.begin('s', { pendingTtlSeconds: 0 })).state).toBe('new');
        expect(await store.complete('s', ownerToken, answer)).toBe('lost');
    });

    it('grants exactly one claim when two requests claim the same scope at once', async () => {
        // The rule the whole store exists for, and the one no test drove
        // concurrently: begin() has to be atomic, not read-then-write.
        const store = create();

        const claims = await Promise.all([
            store.begin('s', { pendingTtlSeconds: 60 }),
            store.begin('s', { pendingTtlSeconds: 60 }),
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
 * Every window in the shared table, driven through both implementations. The
 * suite used to exercise perMin and perHour only, so a limiter that handled
 * those two and ignored the other four passed every rule in this file: the
 * agreement rested on the shared import rather than on any assertion, which
 * is exactly the kind of drift a conformance suite exists to catch.
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
 * The session store had no conformance suite, which mattered more than for
 * the other two: the whole session test file runs on the memory store while
 * production runs on DynamoDB, so nothing checked that the two agree on a
 * missing record, on partition isolation, or on skipping a record that is
 * gone.
 */
const sessionStoreImplementations: { name: string; create: () => LambderSessionStore; isMemoryOnly: boolean }[] = [
    { name: 'LambderMemorySessionStore', create: () => new LambderMemorySessionStore(), isMemoryOnly: true },
    {
        name: 'LambderDdbSessionStore',
        create: () => new LambderDdbSessionStore({ tableName: 'test-sessions', client: new MemoryDdbDocument() as any }),
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
    ...over,
});

describe.each(sessionStoreImplementations)('LambderSessionStore conformance: $name', ({ create, isMemoryOnly }) => {
    it('says whether it outlives the process, which is what gates non-cryptographic hashing', () => {
        expect(create().isMemoryOnly).toBe(isMemoryOnly);
    });

    it('round-trips a record under its two hashes', async () => {
        const store = create();
        await store.put(sessionRecord());

        const read = await store.get('partition-a', 'secret-1');
        expect(read).toMatchObject({ sessionKey: 'user-1', csrfTokenHash: 'csrf-1', data: { name: 'Ada' } });
    });

    it('answers null for a record that is absent, never throws', async () => {
        const store = create();
        expect(await store.get('partition-a', 'nope')).toBeNull();
        expect(await store.get('no-such-partition', 'secret-1')).toBeNull();
    });

    it('replaces the record under the same hashes rather than adding a second', async () => {
        const store = create();
        await store.put(sessionRecord());
        await store.put(sessionRecord({ data: { name: 'Grace' } }));

        expect(await store.get('partition-a', 'secret-1')).toMatchObject({ data: { name: 'Grace' } });
        expect(await store.listSecretHashes('partition-a')).toEqual(['secret-1']);
    });

    it('lists the secret hashes of one partition and nothing from another', async () => {
        const store = create();
        await store.put(sessionRecord({ secretHash: 'secret-1' }));
        await store.put(sessionRecord({ secretHash: 'secret-2' }));
        await store.put(sessionRecord({ sessionKeyHash: 'partition-b', secretHash: 'secret-3' }));

        expect((await store.listSecretHashes('partition-a')).sort()).toEqual(['secret-1', 'secret-2']);
        expect(await store.listSecretHashes('partition-b')).toEqual(['secret-3']);
        expect(await store.listSecretHashes('partition-empty')).toEqual([]);
    });

    it('deletes one session without touching its siblings', async () => {
        const store = create();
        await store.put(sessionRecord({ secretHash: 'secret-1' }));
        await store.put(sessionRecord({ secretHash: 'secret-2' }));

        await store.delete('partition-a', 'secret-1');

        expect(await store.get('partition-a', 'secret-1')).toBeNull();
        expect(await store.get('partition-a', 'secret-2')).not.toBeNull();
    });

    it('deleting a record that is already gone is a no-op, not an error', async () => {
        const store = create();
        await expect(store.delete('partition-a', 'never-existed')).resolves.toBeUndefined();
    });

    it('stamps dataExpiresAt on a live record', async () => {
        const store = create();
        await store.put(sessionRecord());
        const at = Math.floor(START / 1000) + 30;

        await store.markDataExpired('partition-a', 'secret-1', at);

        expect(await store.get('partition-a', 'secret-1')).toMatchObject({ dataExpiresAt: at });
    });

    it('skips markDataExpired for a record that vanished, rather than resurrecting it', async () => {
        // The engine calls this across every session of a subject, so one that
        // logged out in between must not come back as a bare stub.
        const store = create();
        await expect(store.markDataExpired('partition-a', 'never-existed', Math.floor(START / 1000))).resolves.toBeUndefined();
        expect(await store.get('partition-a', 'never-existed')).toBeNull();
    });
});

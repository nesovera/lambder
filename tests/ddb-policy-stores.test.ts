/**
 * What the two DynamoDB policy stores do at the edges the memory ones have no
 * version of, and which therefore cannot be conformance rules: a key too long
 * for a DynamoDB partition key, a table that cannot be reached, and an item
 * that does not look like one this store wrote.
 *
 * The shared rules live in store-conformance.test.ts and are driven through
 * both implementations; these are about this storage.
 */

import { describe, it, expect } from 'vitest';
import { brotliCompressSync } from 'node:zlib';
import { LambderDdbIdempotencyStore } from '../src/stores/LambderDdbIdempotencyStore.js';
import { LambderDdbRateLimiter } from '../src/stores/LambderDdbRateLimiter.js';
import { MemoryDdb } from './helpers.js';

const START = 1_700_000_000_000;
const testClock = () => START;

describe('LambderDdbIdempotencyStore, scope keys DynamoDB will not take', () => {
    it('refuses a scope key past the partition key limit with a message that names the limit', async () => {
        // The scope carries caller data: the API name, the client's
        // idempotency key, and an identity that the docs' own example makes an
        // email. Long enough, and DynamoDB answers a ValidationException,
        // which is not a conditional-check failure, so it escapes as a store
        // error and an engine set to fail open turns it into no idempotency at
        // all: the duplicate executes and nothing says why.
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), now: testClock });
        const scopeKey = `i:${'long@example.com'.repeat(200)}`;

        await expect(store.begin(scopeKey, { pendingTtlSeconds: 60 })).rejects.toThrow(/2048-byte partition key limit/);
        await expect(store.peek(scopeKey)).rejects.toThrow(/2048-byte partition key limit/);
    });

    it('says how long the key was without printing it, since the message reaches a log', async () => {
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), now: testClock });
        const secret = 'caller-secret-key';
        const scopeKey = `i:${secret.repeat(200)}`;

        const failure = await store.begin(scopeKey, { pendingTtlSeconds: 60 }).then(() => null, (error: unknown) => error as Error);

        expect(failure?.message).toContain(`${Buffer.byteLength(`IDEM#${scopeKey}`, 'utf8')} bytes`);
        expect(failure?.message).not.toContain(secret);
    });

    it('takes a key right up to the limit', async () => {
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), now: testClock });
        // 2048 bytes once the "IDEM#" prefix is on it.
        const scopeKey = 'k'.repeat(2048 - 'IDEM#'.length);

        expect((await store.begin(scopeKey, { pendingTtlSeconds: 60 })).state).toBe('new');
    });
});

describe('LambderDdbIdempotencyStore, items it did not write', () => {
    const plant = (client: MemoryDdb, attributes: Record<string, unknown>): void => {
        const item: Record<string, unknown> = {
            pk: { S: 'IDEM#s' }, sk: { S: 'idem' },
            state: { S: 'done' },
            expiresAt: { N: String(Math.floor(START / 1000) + 600) },
            ...attributes,
        };
        // An attribute given as undefined is planted as ABSENT, which is what a
        // partial write or another writer on a shared table leaves behind, and
        // is a different thing from one DynamoDB cannot read.
        for(const [name, value] of Object.entries(item)) if(value === undefined) delete item[name];
        client.items.set('IDEM#s|idem', item as never);
    };

    it('replays a record whose status code is unreadable as 200 rather than as NaN', async () => {
        // Number(undefined) and Number("2OO") are both NaN, and a NaN status
        // code goes out as one: the answer is built from what comes back.
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { statusCode: { N: 'not-a-number' }, body: { S: '{"ok":true}' } });

        expect(await store.peek('s')).toEqual({ statusCode: 200, headers: {}, body: '{"ok":true}' });
    });

    it('ignores stored headers that are not a multi-value map', async () => {
        // The map goes to the response builder, which would ship a number or a
        // bare string as a header value.
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, {
            statusCode: { N: '200' },
            headersJson: { S: JSON.stringify({ 'Content-Type': ['application/json'], 'X-Count': 7, 'X-Flat': 'one' }) },
            body: { S: '{}' },
        });

        expect((await store.peek('s'))?.headers).toEqual({ 'Content-Type': ['application/json'] });
    });

    it('does not let a stored header named __proto__ touch the object it builds', async () => {
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, {
            statusCode: { N: '200' },
            headersJson: { S: '{"__proto__":["polluted"],"X-Ok":["yes"]}' },
            body: { S: '{}' },
        });

        const record = await store.peek('s');

        expect(record?.headers).toEqual({ 'X-Ok': ['yes'] });
        expect(Object.getPrototypeOf(record?.headers)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('replays a record with a corrupt headers attribute rather than failing the request', async () => {
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { statusCode: { N: '200' }, headersJson: { S: 'not json at all' }, body: { S: '{}' } });

        expect(await store.peek('s')).toEqual({ statusCode: 200, headers: {}, body: '{}' });
    });

    it('treats a record with no readable expiry as expired, not as immortal', async () => {
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { statusCode: { N: '200' }, body: { S: '{}' }, expiresAt: { N: 'whenever' } });

        expect(await store.peek('s')).toBeNull();
    });

    it('does not replay that record through begin either, which is the authoritative read', async () => {
        // begin is the path a retry actually takes, and it used to answer the
        // opposite of peek: DynamoDB reads a comparison against an unreadable
        // attribute as false, so the claim was refused, and begin then handed
        // the stored answer back with no expiry test of its own. The record
        // replayed for ever and no TTL could retire it.
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { statusCode: { N: '200' }, body: { S: '{}' }, expiresAt: { N: 'whenever' } });

        expect((await store.begin('s', { pendingTtlSeconds: 60 })).state).toBe('pending');
    });

    it('claims a scope whose record carries no expiry at all, so a pending one cannot deadlock it', async () => {
        // The worse half of the same shape. A claim condition that only asked
        // `expiresAt <= :now` could never be satisfied by an item with no
        // expiresAt, so every request on that scope answered 409 for ever and
        // the TTL sweeper read the same missing attribute. The condition now
        // takes an absent expiry as free.
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { state: { S: 'pending' }, ownerToken: { S: 'someone-else' }, expiresAt: undefined });

        const claim = await store.begin('s', { pendingTtlSeconds: 60 });

        expect(claim.state).toBe('new');
        if(claim.state !== 'new') throw new Error('expected the scope to be claimable');
        expect(await store.complete('s', claim.ownerToken, { statusCode: 200, headers: {}, body: '{}', ttlSeconds: 60 })).toBe('stored');
    });

    it('refuses a record whose stored body declares more bytes than the store would ever write', async () => {
        // bodyBytes is the decompression budget on the way back, so a record
        // claiming petabytes lets a few hundred kilobytes of Brotli expand
        // until the function dies. The store's own writes stay far inside it.
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, {
            statusCode: { N: '200' },
            bodyBr: { B: brotliCompressSync(Buffer.from('a'.repeat(4096), 'utf8')) },
            bodyBytes: { N: String(Number.MAX_SAFE_INTEGER) },
        });

        await expect(store.peek('s')).rejects.toThrow(/replay limit/);
    });
});

describe('LambderDdbRateLimiter, tracker keys DynamoDB will not take', () => {
    it('refuses a tracker key past the partition key limit, before counting anything', async () => {
        // A policy keyed on a payload field is the documented shape, so the
        // key carries whatever the caller posted. Left to DynamoDB, an
        // over-long one comes back as a ValidationException, which is not a
        // conditional-check failure: it escapes as a store error, an engine
        // set to fail open logs it and lets the request through, and every
        // window of every policy fails the same way, so the limit is off and
        // nothing counts. The throw is the only thing a fail-closed caller
        // can act on.
        const client = new MemoryDdb();
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });
        const trackerKey = `api|auth.requestCode|byEmail|custom:${'long@example.com'.repeat(200)}`;

        await expect(limiter.isRateLimited(trackerKey, { perMin: 3, perHour: 20 })).rejects.toThrow(/2048-byte partition key limit/);
        expect(client.items.size).toBe(0);
    });

    it('says how long the key was without printing it, since the message reaches a log', async () => {
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client: new MemoryDdb(), now: testClock });
        const secret = 'caller-secret-key';
        const trackerKey = `custom:${secret.repeat(200)}`;

        const failure = await limiter.isRateLimited(trackerKey, { perMin: 3 }).then(() => null, (error: unknown) => error as Error);

        expect(failure?.message).toContain(`${Buffer.byteLength(`RL#${trackerKey}`, 'utf8')} bytes`);
        expect(failure?.message).not.toContain(secret);
    });

    it('takes a key right up to the limit', async () => {
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client: new MemoryDdb(), now: testClock });
        // 2048 bytes once the "RL#" prefix is on it.
        const trackerKey = 'k'.repeat(2048 - 'RL#'.length);

        expect(await limiter.isRateLimited(trackerKey, { perMin: 2 })).toBe(false);
    });
});

describe('LambderDdbRateLimiter, a table it cannot reach', () => {
    it('lets the failure reach the caller instead of deciding for it', async () => {
        // The limiter used to own a failOpen option and swallow the error,
        // which put the decision in the storage and left a custom limiter with
        // no way to make it at all. Whether an unanswerable limit lets the
        // request through belongs to the application, at rateLimits.failOpen,
        // and the engine can only make it if the throw arrives.
        const client = new MemoryDdb();
        client.failAll = true;
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });

        await expect(limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 })).rejects.toThrow('ddb down');
    });

    it('rejects a nonsense ttlWindowMultiplier at construction', () => {
        expect(() => new LambderDdbRateLimiter({ tableName: 'test-table', ttlWindowMultiplier: 0 }))
            .toThrow(/ttlWindowMultiplier must be a number of 1 or more/);
    });
});

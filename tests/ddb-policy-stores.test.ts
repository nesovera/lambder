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

        await expect(store.begin(scopeKey, { pendingTtlSeconds: 60, fingerprint: 'request-1' })).rejects.toThrow(/2048-byte partition key limit/);
        await expect(store.peek(scopeKey)).rejects.toThrow(/2048-byte partition key limit/);
    });

    it('says how long the key was without printing it, since the message reaches a log', async () => {
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), now: testClock });
        const secret = 'caller-secret-key';
        const scopeKey = `i:${secret.repeat(200)}`;

        const failure = await store.begin(scopeKey, { pendingTtlSeconds: 60, fingerprint: 'request-1' }).then(() => null, (error: unknown) => error as Error);

        expect(failure?.message).toContain(`${Buffer.byteLength(`IDEM#${scopeKey}`, 'utf8')} bytes`);
        expect(failure?.message).not.toContain(secret);
    });

    it('takes a key right up to the limit', async () => {
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), now: testClock });
        // 2048 bytes once the "IDEM#" prefix is on it.
        const scopeKey = 'k'.repeat(2048 - 'IDEM#'.length);

        expect((await store.begin(scopeKey, { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('new');
    });
});

describe('LambderDdbIdempotencyStore, items it did not write', () => {
    const plant = (client: MemoryDdb, attributes: Record<string, unknown>): void => {
        const item: Record<string, unknown> = {
            pk: { S: 'IDEM#s' }, sk: { S: 'idem' },
            state: { S: 'done' },
            fingerprint: { S: 'request-1' },
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

        expect(await store.peek('s')).toEqual({ statusCode: 200, headers: {}, body: '{"ok":true}', fingerprint: 'request-1' });
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

        expect(await store.peek('s')).toEqual({ statusCode: 200, headers: {}, body: '{}', fingerprint: 'request-1' });
    });

    it('reads a record that keeps no fingerprint as another request\'s, never as a match and never as free', async () => {
        // Every claim and record this store writes keeps one, so an item
        // without it came from another writer, and no request can be shown to
        // be the one it answers. The empty fingerprint matches none (the
        // engine's are never empty), so the key is refused as reused rather
        // than replayed to whoever presents it or run over.
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { statusCode: { N: '200' }, body: { S: '{}' }, fingerprint: undefined });

        expect(await store.peek('s')).toEqual({ statusCode: 200, headers: {}, body: '{}', fingerprint: '' });
        expect(await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).toMatchObject({ state: 'done', fingerprint: '' });

        plant(client, { state: { S: 'pending' }, ownerToken: { S: 'someone-else' }, fingerprint: undefined });
        expect(await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).toEqual({ state: 'pending', fingerprint: '' });
    });

    it('treats a record with no readable expiry as expired, not as immortal', async () => {
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { statusCode: { N: '200' }, body: { S: '{}' }, expiresAt: { N: 'whenever' } });

        expect(await store.peek('s')).toBeNull();
    });

    it('does not replay that record through begin either, which is the authoritative read', async () => {
        // begin is the path a retry actually takes, and it must agree with
        // peek. DynamoDB reads a comparison against an unreadable attribute as
        // false, so the claim is refused; without an expiry test of its own,
        // begin would hand the stored answer back, and the record would replay
        // for ever with no TTL to retire it.
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { statusCode: { N: '200' }, body: { S: '{}' }, expiresAt: { N: 'whenever' } });

        expect((await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).state).toBe('pending');
    });

    it('claims a scope whose record carries no expiry at all, so a pending one cannot deadlock it', async () => {
        // The worse half of the same shape: a claim condition that only asks
        // `expiresAt <= :now` can never be satisfied by an item with no
        // expiresAt, and the TTL sweeper reads the same missing attribute, so
        // every request on that scope would answer 409 for ever. The condition
        // takes an absent expiry as free.
        const client = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client, now: testClock });
        plant(client, { state: { S: 'pending' }, ownerToken: { S: 'someone-else' }, expiresAt: undefined });

        const claim = await store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' });

        expect(claim.state).toBe('new');
        if(claim.state !== 'new') throw new Error('expected the scope to be claimable');
        expect(await store.complete('s', claim.ownerToken, { statusCode: 200, headers: {}, body: '{}', fingerprint: 'request-1', ttlSeconds: 60 })).toBe('stored');
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
        // over-long one comes back as a ValidationException, not a
        // conditional-check failure: it escapes as a store error, an engine
        // set to fail open lets the request through, and since every window
        // fails the same way, the limit is simply off. The throw is the only
        // thing a fail-closed caller can act on.
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
        // Whether an unanswerable limit lets the request through is the
        // application's decision, at rateLimits.failOpen, not the storage's,
        // and the engine can only make it if the throw arrives.
        const client = new MemoryDdb();
        client.failAll = true;
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });

        await expect(limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 })).rejects.toThrow('ddb down');
    });

    /**
     * A table that throttles counter writes for their key range, as DynamoDB
     * does to each key on a partition a flood has made hot, and serves every
     * other command from what it holds. `sent` sees each command's name and
     * input. `throttlesWrite` picks the writes it throttles (every one by
     * default), and `readThrown`, when given, throttles the reads as well.
     */
    const keyRangeThrottledTable = (
        thrown: object,
        options: { throttlesWrite?: (input: any) => boolean; readThrown?: object } = {},
    ) => {
        const table = new MemoryDdb();
        const sent: { name: string; input: any }[] = [];
        const client = {
            send: async (command: any) => {
                const name: string = command?.constructor?.name;
                sent.push({ name, input: command.input });
                if(name === 'UpdateItemCommand' && (options.throttlesWrite?.(command.input) ?? true)) throw Object.assign(new Error('slow down'), thrown);
                if(name === 'GetItemCommand' && options.readThrown) throw Object.assign(new Error('slow down, reader'), options.readThrown);
                return await table.send(command);
            },
        };
        return { table, client: client as never, sent };
    };
    const keyRange = [{ reason: 'TableWriteKeyRangeThroughputExceeded', resource: 'arn:aws:dynamodb:table/test-table' }];
    const readKeyRange = { name: 'ProvisionedThroughputExceededException', ThrottlingReasons: [{ reason: 'TableReadKeyRangeThroughputExceeded' }] };
    const minuteStart = Math.floor(START / 1000 / 60) * 60;
    const dayStart = Math.floor(START / 1000 / 86400) * 86400;
    const plantCount = (table: MemoryDdb, trackerKey: string, count: number, sortKey = `perMin#${minuteStart}`) => {
        const pk = { S: `RL#${trackerKey}` }, sk = { S: sortKey };
        table.items.set(`${pk.S}|${sk.S}`, { pk, sk, count: { N: String(count) } });
    };
    const namesOf = (sent: { name: string }[]) => sent.map((command) => command.name);

    it('counts a key at its limit on a throttled partition as over its limit, so failOpen cannot wave a flood through', async () => {
        // DynamoDB throttles a partition at about a thousand writes a second,
        // and the SDK retries before it gives up. A key whose own window is
        // full while its partition is throttled is the flood, which is an
        // answer, not an outage.
        for(const thrown of [
            { name: 'ProvisionedThroughputExceededException', ThrottlingReasons: keyRange },
            { name: 'ThrottlingException', throttlingReasons: keyRange },
            { name: 'RequestLimitExceeded', ThrottlingReasons: keyRange },
        ]){
            const { table, client, sent } = keyRangeThrottledTable(thrown);
            plantCount(table, 'ip:1.2.3.4', 5);
            const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });

            const verdict = await limiter.isRateLimited('ip:1.2.3.4', { perMin: 5, perDay: 100 });
            // Told to come back in seconds, not at the window's reset.
            expect(verdict).toEqual({ window: 'perMin', limit: 5, resetAt: Math.floor(START / 1000) + 5 });
            // Every window the attempt was not counted against, each read
            // from the leader: a lagging replica could miss the write that
            // just filled the window.
            expect(sent.filter((command) => command.name === 'GetItemCommand').map((command) => command.input)).toEqual([
                expect.objectContaining({ ConsistentRead: true, Key: expect.objectContaining({ sk: { S: `perMin#${minuteStart}` } }) }),
                expect.objectContaining({ ConsistentRead: true, Key: expect.objectContaining({ sk: { S: `perDay#${dayStart}` } }) }),
            ]);
        }
    });

    it('refuses a key over a later window\'s cap while the throttled window is under its own', async () => {
        // At every minute rollover the per-minute counter starts again from
        // zero, so a key already over its daily cap is under its limit on the
        // per-minute write the flood is throttled on. Read alone, that window
        // would pass the key to failOpen with the daily cap never consulted.
        const { table, client } = keyRangeThrottledTable({ name: 'ProvisionedThroughputExceededException', ThrottlingReasons: keyRange });
        plantCount(table, 'ip:1.2.3.4', 3);
        plantCount(table, 'ip:1.2.3.4', 100, `perDay#${dayStart}`);
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });

        expect(await limiter.isRateLimited('ip:1.2.3.4', { perMin: 1000, perDay: 100 }))
            .toEqual({ window: 'perDay', limit: 100, resetAt: Math.floor(START / 1000) + 5 });
    });

    it('reads only the windows the attempt was not counted against, since the ones before admitted it', async () => {
        // The per-minute write went through and filled that window with this
        // very attempt; read back, it would turn the attempt its own counter
        // allowed into a refusal. The daily one, under its cap, answers.
        const { table, client, sent } = keyRangeThrottledTable(
            { name: 'ProvisionedThroughputExceededException', ThrottlingReasons: keyRange },
            { throttlesWrite: (input) => input.Key.sk.S.startsWith('perDay#') },
        );
        plantCount(table, 'ip:1.2.3.4', 2);
        plantCount(table, 'ip:1.2.3.4', 40, `perDay#${dayStart}`);
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });

        await expect(limiter.isRateLimited('ip:1.2.3.4', { perMin: 3, perDay: 100 })).rejects.toThrow('slow down');
        expect(sent.filter((command) => command.name === 'GetItemCommand').map((command) => command.input.Key.sk.S)).toEqual([`perDay#${dayStart}`]);
    });

    it('refuses the flood\'s repeats from memory, without touching the table, until the partition has had time to recover', async () => {
        // Each repeat would cost the hot partition another throttled write
        // and another consistent read, until the reads throttled too and the
        // flood failed open. A count only rises within its window, so the
        // table would say the same thing.
        let now = START;
        const { table, client, sent } = keyRangeThrottledTable({ name: 'ProvisionedThroughputExceededException', ThrottlingReasons: keyRange });
        plantCount(table, 'ip:1.2.3.4', 5);
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: () => now });

        expect(await limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 })).toMatchObject({ window: 'perMin' });
        expect(namesOf(sent)).toEqual(['UpdateItemCommand', 'GetItemCommand']);

        sent.length = 0;
        now = START + 4_000;
        expect(await limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 })).toEqual({ window: 'perMin', limit: 5, resetAt: Math.floor(now / 1000) + 5 });
        expect(sent).toEqual([]);
        // A neighbour on the same partition is not answered from the flood's memory.
        await expect(limiter.isRateLimited('ip:5.6.7.8', { perMin: 5 })).rejects.toThrow('slow down');

        // Past the retry window the table is asked again.
        sent.length = 0;
        now = START + 5_000;
        expect(await limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 })).toMatchObject({ window: 'perMin' });
        expect(namesOf(sent)).toEqual(['UpdateItemCommand', 'GetItemCommand']);
    });

    it('throws a key\'s repeats the throttle its unreadable window was first answered with, without reading again', async () => {
        // The partition is throttling the reads as well, so whether this key
        // is the flood cannot be told, and the throttle goes to failOpen. The
        // repeats skip the read the partition keeps refusing, and throw the
        // same error, which the engine logs once rather than once per request.
        const { client, sent } = keyRangeThrottledTable({ name: 'ProvisionedThroughputExceededException', ThrottlingReasons: keyRange }, { readThrown: readKeyRange });
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });

        const first = await limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 }).then(() => null, (error: unknown) => error);
        expect(first).toMatchObject({ message: 'slow down' });
        expect(namesOf(sent)).toEqual(['UpdateItemCommand', 'GetItemCommand']);

        sent.length = 0;
        const repeat = await limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 }).then(() => null, (error: unknown) => error);
        expect(repeat).toBe(first);
        expect(namesOf(sent)).toEqual(['UpdateItemCommand']);
    });

    it('passes the throttle on for a neighbour under its limit, since a key range is a partition and not one key', async () => {
        // Regression: every key-range throttle counted as over the limit, so
        // a flood on one address refused every tracker key on its partition,
        // and on a shared table a session or cache spike refused every
        // rate-limited caller there. A neighbour under its limit is told
        // nothing about itself: the throttle goes on as a failure, and
        // failOpen decides.
        const { table, client } = keyRangeThrottledTable({ name: 'ProvisionedThroughputExceededException', ThrottlingReasons: keyRange });
        plantCount(table, 'ip:5.6.7.8', 2);
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });

        await expect(limiter.isRateLimited('ip:5.6.7.8', { perMin: 5 })).rejects.toThrow('slow down');
        // A key with no counter yet is under every limit.
        await expect(limiter.isRateLimited('ip:9.9.9.9', { perMin: 5 })).rejects.toThrow('slow down');
    });

    it('passes the original throttle on when the count cannot be read either', async () => {
        const client = {
            send: async (command: any) => {
                if(command?.constructor?.name === 'UpdateItemCommand') throw Object.assign(new Error('slow down'), { name: 'ThrottlingException', throttlingReasons: keyRange });
                throw new Error('read refused');
            },
        };
        const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client: client as never, now: testClock });

        await expect(limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 })).rejects.toThrow('slow down');
    });

    it('passes a throttle of the table or the account on as a failure, for failOpen to decide', async () => {
        // The table's capacity, an on-demand maximum or the account's quota
        // running out says nothing about this key: answered as over the
        // limit, it would refuse every caller of every limited endpoint.
        for(const thrown of [
            { name: 'ProvisionedThroughputExceededException', ThrottlingReasons: [{ reason: 'TableWriteProvisionedThroughputExceeded' }] },
            { name: 'ThrottlingException', throttlingReasons: [{ reason: 'TableWriteMaxOnDemandThroughputExceeded' }] },
            { name: 'RequestLimitExceeded', ThrottlingReasons: [{ reason: 'TableWriteAccountLimitExceeded' }] },
            // An SDK that names no reason.
            { name: 'ProvisionedThroughputExceededException' },
        ]){
            const client = { send: async () => { throw Object.assign(new Error('slow down'), thrown); } } as never;
            const limiter = new LambderDdbRateLimiter({ tableName: 'test-table', client, now: testClock });

            await expect(limiter.isRateLimited('ip:1.2.3.4', { perMin: 5 })).rejects.toThrow('slow down');
        }
    });

    it('rejects a nonsense ttlWindowMultiplier at construction', () => {
        expect(() => new LambderDdbRateLimiter({ tableName: 'test-table', ttlWindowMultiplier: 0 }))
            .toThrow(/ttlWindowMultiplier must be a number of 1 or more/);
    });
});

describe('LambderDdbIdempotencyStore - a claim the SDK retried', () => {
    it('recognizes its own claim when a retried write finds the one that already landed, instead of answering pending', async () => {
        // A DynamoDB 500 after the claim was applied makes the SDK send the
        // write again, and the retry meets the item the first attempt wrote.
        // Read as somebody else's claim, the original would answer itself 409.
        const table = new MemoryDdb();
        const retryingClient = {
            send: async (command: any) => {
                if(command?.constructor?.name !== 'PutItemCommand' || command.input.Item?.state?.S !== 'pending') return await table.send(command);
                await table.send(command);
                return await table.send(command);
            },
        };
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: retryingClient as never, now: testClock });

        const claim = await store.begin('scope-retried', { pendingTtlSeconds: 60, fingerprint: 'request-1' });
        expect(claim.state).toBe('new');
        // And somebody else still finds it pending.
        expect(await store.begin('scope-retried', { pendingTtlSeconds: 60, fingerprint: 'request-1' })).toEqual({ state: 'pending', fingerprint: 'request-1' });
    });

    it('answers a claim refused with no item to show for it as the caller\'s own request in flight', async () => {
        // The refusing item was gone by the time the condition was read, so
        // there is nobody else's fingerprint to report. The caller's own keeps
        // it the in-flight 409, retried under the same key, rather than a
        // key-reused 409 that would move a key scope on.
        const refusingClient = { send: async () => { throw Object.assign(new Error('conditional request failed'), { name: 'ConditionalCheckFailedException' }); } };
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: refusingClient as never, now: testClock });

        expect(await store.begin('scope-gone', { pendingTtlSeconds: 60, fingerprint: 'request-7' })).toEqual({ state: 'pending', fingerprint: 'request-7' });
    });
});

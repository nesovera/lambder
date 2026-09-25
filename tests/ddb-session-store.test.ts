/**
 * LambderDdbSessionStore: the session record mapped onto a DynamoDB item and
 * back (the table's own key names, session.data Brotli-compressed at rest),
 * the query behind listSecretHashes, and the conditional create and update
 * every write goes through. The session model itself is tests/session.test.ts, over
 * the memory store; this file is only the DynamoDB half.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import zlib from 'zlib';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambderDdbSessionStore } from '../src/stores/LambderDdbSessionStore.js';
import LambderSessionManager from '../src/session/LambderSessionManager.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import type { LambderSessionRecord } from '../src/shared/contracts/LambderSessionStore.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const nowSec = () => Math.floor(Date.now() / 1000);

const storedData = (item: Record<string, any>) =>
    item.dataBr ? JSON.parse(zlib.brotliDecompressSync(item.dataBr).toString('utf8')) : item.data;
const compressedItem = (data: unknown) => {
    const raw = Buffer.from(JSON.stringify(data), 'utf8');
    return { dataBr: zlib.brotliCompressSync(raw), dataBytes: raw.byteLength };
};

const record = (overrides: Partial<LambderSessionRecord> = {}): LambderSessionRecord => ({
    sessionKeyHash: 'hashed-key',
    secretHash: 'secret-hash',
    csrfTokenHash: 'csrf-hash',
    sessionKey: 'user-123',
    data: { role: 'user' },
    createdAt: nowSec() - 1000,
    expiresAt: nowSec() + 3600,
    lastAccessedAt: nowSec(),
    ttlInSeconds: 3600,
    dataVersion: 0,
    ...overrides,
});

const data = {
    userId: '3f1c2b6e-9d1a-4f7e-8c1b-2a9d7e6f5c4b',
    permissions: ['ORDERS.VIEW', 'ORDERS.EDIT', 'INVOICES.VIEW', 'INVOICES.EDIT'],
};
const dataJsonBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');

const makeStore = (options: Partial<ConstructorParameters<typeof LambderDdbSessionStore>[0]> = {}) =>
    new LambderDdbSessionStore({ tableName: 'test-sessions', region: 'us-east-1', ...options });

describe('LambderDdbSessionStore - items', () => {
    beforeEach(() => { ddbMock.reset(); });

    it('writes the record under the table key names with the data Brotli-compressed by default', async () => {
        ddbMock.on(PutCommand).resolves({});

        await makeStore().create(record({ data }));

        const item = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
        expect(item.pk).toBe('hashed-key');
        expect(item.sk).toBe('secret-hash');
        expect(item.sessionKeyHash).toBeUndefined();
        expect(item.secretHash).toBeUndefined();
        expect(item.data).toBeUndefined();
        expect(item.dataBytes).toBe(dataJsonBytes);
        expect(Buffer.isBuffer(item.dataBr)).toBe(true);
        expect((item.dataBr as Buffer).byteLength).toBeLessThan(dataJsonBytes);
        expect(storedData(item)).toEqual(data);
        expect(item.csrfTokenHash).toBe('csrf-hash');
        expect(item.sessionKey).toBe('user-123');
    });

    it('honours custom key attribute names', async () => {
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: { partition: 'hashed-key', sort: 'secret-hash', ...record(), data: { role: 'admin' } } });
        const store = makeStore({ partitionKey: 'partition', sortKey: 'sort' });

        await store.create(record());
        const item = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
        expect(item.partition).toBe('hashed-key');
        expect(item.sort).toBe('secret-hash');

        const read = await store.get('hashed-key', 'secret-hash');
        expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ partition: 'hashed-key', sort: 'secret-hash' });
        expect(read?.sessionKeyHash).toBe('hashed-key');
        expect(read?.secretHash).toBe('secret-hash');
        expect(read?.data).toEqual({ role: 'admin' });
    });

    it('compression: true is the default and equals { minBytes: 0 }; false stores the data plain; minBytes moves the threshold', async () => {
        ddbMock.on(PutCommand).resolves({});
        const tiny = { role: 'user' };

        await makeStore().create(record({ data: tiny }));
        await makeStore({ compression: true }).create(record({ data: tiny }));
        await makeStore({ compression: { minBytes: 0 } }).create(record({ data: tiny }));
        await makeStore({ compression: false }).create(record({ data }));
        await makeStore({ compression: { minBytes: dataJsonBytes } }).create(record({ data }));
        await makeStore({ compression: { minBytes: dataJsonBytes } }).create(record({ data: tiny }));

        const items = ddbMock.commandCalls(PutCommand).map((call) => call.args[0].input.Item!);
        for(const item of items.slice(0, 3)){
            expect(item.data).toBeUndefined();
            expect(storedData(item)).toEqual(tiny);
        }
        expect(items[3]!.data).toEqual(data);
        expect(items[3]!.dataBr).toBeUndefined();
        expect(items[4]!.dataBr).toBeDefined();
        expect(items[5]!.data).toEqual(tiny);
    });

    it('reads a compressed or a plain item back as the same record, whatever the current setting', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { pk: 'hashed-key', sk: 'secret-hash', ...record(), data: undefined, ...compressedItem(data) } });
        expect((await makeStore().get('hashed-key', 'secret-hash'))?.data).toEqual(data);
        expect((await makeStore({ compression: false }).get('hashed-key', 'secret-hash'))?.data).toEqual(data);

        ddbMock.on(GetCommand).resolves({ Item: { pk: 'hashed-key', sk: 'secret-hash', ...record({ data }) } });
        const read = await makeStore().get('hashed-key', 'secret-hash');
        expect(read?.data).toEqual(data);
        expect((read as any).dataBr).toBeUndefined();
        expect((read as any).pk).toBeUndefined();
    });

    it('a compressed item that fails to decode reads as no session, rather than failing the read', async () => {
        // A malformed record and a failed read must not answer alike. A read
        // failure is transient and surfaces as a 500, since signing somebody
        // out over a DynamoDB blip is the worse answer. A record that will not
        // decode never will, so a 500 would leave a session the visitor can
        // neither use nor clear until the TTL retires it. Ending it lets them
        // log in again.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { dataBr, dataBytes } = compressedItem(data);

        // Truncated Brotli, and a declared length that does not match.
        ddbMock.on(GetCommand).resolves({ Item: { pk: 'hashed-key', sk: 'secret-hash', ...record(), data: undefined, dataBr: dataBr.subarray(0, 8), dataBytes } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        ddbMock.on(GetCommand).resolves({ Item: { pk: 'hashed-key', sk: 'secret-hash', ...record(), data: undefined, dataBr } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        expect(warn).toHaveBeenCalled();

        // End to end: the manager reports no session, not a read error.
        const manager = new LambderSessionManager({ store: makeStore(), sessionSalt: 'salt' });
        expect(await manager.lookupSession('hashed-key:secret')).toBeNull();

        // A read that actually fails still surfaces, so a blip is never a logout.
        ddbMock.on(GetCommand).rejects(new Error('DynamoDB unavailable'));
        await expect(makeStore().get('hashed-key', 'secret-hash')).rejects.toThrow(/unavailable/);
        warn.mockRestore();
    });

    it('reads an item missing the fields a session record has as no session', async () => {
        // Checked before the cast, because everything past it trusts them: the
        // manager compares the two hashes in constant time, where a non-string
        // throws rather than answering false, and reads expiresAt as a number
        // to decide whether the session is over. An item written by hand, by an
        // older schema, or by another app sharing the table is not this store's
        // record, and it will not become one later. Nothing is logged: a
        // cookie naming such an item arrives on every request until it
        // expires.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const complete = { pk: 'hashed-key', sk: 'secret-hash', ...record() };

        for(const missing of ['csrfTokenHash', 'sessionKey', 'createdAt', 'expiresAt', 'ttlInSeconds', 'dataVersion']){
            ddbMock.on(GetCommand).resolves({ Item: { ...complete, [missing]: undefined } });
            expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        }
        ddbMock.on(GetCommand).resolves({ Item: { ...complete, expiresAt: '2099' } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        expect(warn).not.toHaveBeenCalled();

        ddbMock.on(GetCommand).resolves({ Item: complete });
        expect(await makeStore().get('hashed-key', 'secret-hash')).not.toBeNull();
        warn.mockRestore();
    });

    it('answers null for a missing item and deletes by the two hashes', async () => {
        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(DeleteCommand).resolves({});
        const store = makeStore();
        expect(await store.get('hashed-key', 'secret-hash')).toBeNull();
        await store.delete('hashed-key', 'secret-hash');
        expect(ddbMock.commandCalls(DeleteCommand)[0]!.args[0].input.Key).toEqual({ pk: 'hashed-key', sk: 'secret-hash' });
    });

    it('rejects invalid compression options and an empty table name at construction', () => {
        expect(() => makeStore({ compression: { minBytes: -1 } })).toThrow();
        expect(() => makeStore({ compression: { quality: 12 } })).toThrow();
        expect(() => makeStore({ compression: { minBytes: 0, quality: 11 } })).not.toThrow();
        expect(() => makeStore({ tableName: ' ' })).toThrow('tableName is required');
    });
});

describe('LambderDdbSessionStore - the partition', () => {
    beforeEach(() => { ddbMock.reset(); });

    it('listSecretHashes queries the partition, projecting the sort key, and follows pagination', async () => {
        ddbMock.on(QueryCommand).resolvesOnce({ Items: [{ sk: 'a' }], LastEvaluatedKey: { pk: 'hashed-key', sk: 'a' } })
            .resolvesOnce({ Items: [{ sk: 'b' }] });

        expect(await makeStore().listSecretHashes('hashed-key')).toEqual(['a', 'b']);

        const [first, second] = ddbMock.commandCalls(QueryCommand).map((call) => call.args[0].input);
        expect(first!.ExpressionAttributeValues?.[':pv']).toBe('hashed-key');
        expect(first!.ProjectionExpression).toBe('#sk');
        expect(first!.ExpressionAttributeNames).toEqual({ '#pk': 'pk', '#sk': 'sk' });
        expect(second!.ExclusiveStartKey).toEqual({ pk: 'hashed-key', sk: 'a' });
    });

    it('creates a record only where none exists, so a session is never overwritten', async () => {
        ddbMock.on(PutCommand).resolves({});
        await makeStore().create(record());
        const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
        expect(put.ConditionExpression).toBe('attribute_not_exists(#sk)');
        expect(put.ExpressionAttributeNames).toEqual({ '#sk': 'sk' });
    });

    it('updates only the named fields, only while the record exists, and moves dataVersion with the data or its deadline', async () => {
        ddbMock.on(UpdateCommand).resolves({});
        expect(await makeStore().update('hashed-key', 'secret-hash', { dataExpiresAt: 1234 })).toBe('updated');
        const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
        expect(update.Key).toEqual({ pk: 'hashed-key', sk: 'secret-hash' });
        expect(update.UpdateExpression).toBe('SET #dataExpiresAt = :dataExpiresAt ADD #dataVersion :dataVersionStep');
        expect(update.ConditionExpression).toBe('attribute_exists(#sk)');
        expect(update.ExpressionAttributeValues).toEqual({ ':dataExpiresAt': 1234, ':dataVersionStep': 1 });

        // Data in one form removes the other, and a condition names the version read.
        ddbMock.reset();
        ddbMock.on(UpdateCommand).resolves({});
        await makeStore({ compression: false }).update('hashed-key', 'secret-hash', { data: { role: 'admin' } }, { dataVersion: 7 });
        const conditioned = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
        expect(conditioned.UpdateExpression).toBe('SET #data = :data ADD #dataVersion :dataVersionStep REMOVE #dataBr, #dataBytes');
        expect(conditioned.ConditionExpression).toBe('attribute_exists(#sk) AND #dataVersion = :readDataVersion');
        expect(conditioned.ExpressionAttributeValues?.[':readDataVersion']).toBe(7);

        // A slide alone leaves the version where it is.
        ddbMock.reset();
        ddbMock.on(UpdateCommand).resolves({});
        await makeStore().update('hashed-key', 'secret-hash', { lastAccessedAt: 5, expiresAt: 3605 });
        expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.UpdateExpression).toBe('SET #lastAccessedAt = :lastAccessedAt, #expiresAt = :expiresAt');

        ddbMock.on(UpdateCommand).rejects(new Error('ddb down'));
        await expect(makeStore().update('hashed-key', 'secret-hash', { expiresAt: 1 })).rejects.toThrow('ddb down');
    });

    it('tells stale from missing by the item the refused update hands back, with no read after it', async () => {
        // ALL_OLD on the condition failure answers "is the record still
        // there" in the same call, so a refused conditioned write costs one
        // round trip rather than two.
        const refused = (item?: Record<string, unknown>) =>
            Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' }, item ? { Item: item } : {});

        ddbMock.on(UpdateCommand).rejects(refused({ pk: { S: 'hashed-key' }, sk: { S: 'secret-hash' }, dataVersion: { N: '3' } }));
        expect(await makeStore().update('hashed-key', 'secret-hash', { data: {} }, { dataVersion: 1 })).toBe('stale');
        expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');

        ddbMock.on(UpdateCommand).rejects(refused());
        expect(await makeStore().update('hashed-key', 'secret-hash', { data: {} }, { dataVersion: 1 })).toBe('missing');
        expect(await makeStore().update('hashed-key', 'secret-hash', { expiresAt: 1 })).toBe('missing');

        expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    it('writes plain data through its JSON, so an undefined inside it does not fail the write', async () => {
        // The document client refuses undefined values, so handing it the raw
        // object would fail a login with a 500 when compression is off, while
        // the memory store accepts the same data.
        ddbMock.on(PutCommand).resolves({});
        await makeStore({ compression: false }).create(record({ data: { role: 'user', nickname: undefined } as never }));
        const item = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
        expect(item.data).toEqual({ role: 'user' });
        expect(Object.keys(item.data)).toEqual(['role']);
    });
});

describe('LambderDdbSessionStore - through the manager', () => {
    beforeEach(() => { ddbMock.reset(); });

    it('a session created through the manager lands as one compressed item under the hashes', async () => {
        ddbMock.on(PutCommand).resolves({});
        const manager = new LambderSessionManager({ store: makeStore(), sessionSalt: 'salt' });

        const { session, sessionToken } = await manager.createSession('user-123', data, 3600);

        const item = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
        expect(item.pk).toBe(session.sessionKeyHash);
        expect(item.sk).toBe(session.secretHash);
        expect(sessionToken.startsWith(`${session.sessionKeyHash}:`)).toBe(true);
        expect(storedData(item)).toEqual(data);
        expect(JSON.stringify(item)).not.toContain(sessionToken.split(':')[1]);
    });

    it('serializes session.data the way the memory store does, so a test over one holds for the other', async () => {
        // Both stores copy through JSON (structuredClone would keep an
        // undefined field and clone a cycle), so a test that passes over the
        // Map passes over the table.
        ddbMock.on(PutCommand).resolves({});
        const memoryStore = new LambderMemorySessionStore();
        const withUndefined = { a: undefined, b: 1 };

        const ddbStore = makeStore();
        const ddbManager = new LambderSessionManager({ store: ddbStore, sessionSalt: 'salt' });
        await ddbManager.createSession('user-123', withUndefined, 3600);
        const ddbItem = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
        ddbMock.on(GetCommand).resolves({ Item: ddbItem });
        const fromDdb = await ddbStore.get(ddbItem.pk as string, ddbItem.sk as string);

        const memoryManager = new LambderSessionManager({ store: memoryStore, sessionSalt: 'salt' });
        const { session: memorySession } = await memoryManager.createSession('user-123', withUndefined, 3600);
        const fromMemory = await memoryStore.get(memorySession.sessionKeyHash, memorySession.secretHash);

        expect(fromDdb?.data).toEqual({ b: 1 });
        expect(Object.keys(fromDdb?.data as object)).toEqual(['b']);
        expect(fromMemory?.data).toEqual(fromDdb?.data);
        expect(Object.keys(fromMemory?.data as object)).toEqual(Object.keys(fromDdb?.data as object));

        // And a cycle is refused by both, rather than stored by one of them.
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        await expect(memoryManager.createSession('user-456', cyclic, 3600)).rejects.toThrow(TypeError);
        await expect(ddbManager.createSession('user-456', cyclic, 3600)).rejects.toThrow(TypeError);
    });

    it('a read failure surfaces as a LambderSessionReadError', async () => {
        ddbMock.on(GetCommand).rejects(new Error('ddb down'));
        const manager = new LambderSessionManager({ store: makeStore(), sessionSalt: 'salt' });
        await expect(manager.lookupSession('hash:secret')).rejects.toThrow('Session read failed: ddb down');
    });
});

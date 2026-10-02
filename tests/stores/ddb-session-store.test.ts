/**
 * LambderDdbSessionStore: the session record mapped onto a DynamoDB item and
 * back (the table's own key names, session.data Brotli-compressed at rest),
 * the query behind listSecretHashes, and the conditional create and update
 * every write goes through. The session model itself is tests/session/session.test.ts, over
 * the memory store; this file is only the DynamoDB half.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import zlib from 'zlib';
import { randomBytes } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, QueryCommand, UpdateItemCommand,
    type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { LambderDdbSessionStore } from '../../src/stores/LambderDdbSessionStore.js';
import { LambderDdbCache } from '../../src/stores/LambderDdbCache.js';
import { unmarshallJsonValue } from '../../src/stores/LambderDdbSdk.js';
import LambderSessionManager from '../../src/session/LambderSessionManager.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import type { LambderSessionRecord } from '../../src/shared/contracts/LambderSessionStore.js';

type Item = Record<string, AttributeValue>;

const ddbMock = mockClient(DynamoDBClient);
const nowSec = () => Math.floor(Date.now() / 1000);

const storedData = (item: Item) =>
    item.dataBr ? JSON.parse(zlib.brotliDecompressSync(item.dataBr.B!).toString('utf8')) : unmarshallJsonValue(item.data!);
const compressedItem = (data: unknown): Item => {
    const raw = Buffer.from(JSON.stringify(data), 'utf8');
    return { dataBr: { B: zlib.brotliCompressSync(raw) }, dataBytes: { N: String(raw.byteLength) } };
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

/** A record's fields besides its data, as the attributes the table holds them in. */
const fieldsItem = (from: LambderSessionRecord, keys = { partition: 'pk', sort: 'sk' }): Item => ({
    [keys.partition]: { S: from.sessionKeyHash },
    [keys.sort]: { S: from.secretHash },
    csrfTokenHash: { S: from.csrfTokenHash },
    sessionKey: { S: from.sessionKey },
    createdAt: { N: String(from.createdAt) },
    expiresAt: { N: String(from.expiresAt) },
    lastAccessedAt: { N: String(from.lastAccessedAt) },
    ttlInSeconds: { N: String(from.ttlInSeconds) },
    dataVersion: { N: String(from.dataVersion) },
    ...(from.dataExpiresAt !== undefined ? { dataExpiresAt: { N: String(from.dataExpiresAt) } } : {}),
});

/** A whole item with its data as a plain `data` map of `{ role }`. */
const plainItem = (from: LambderSessionRecord = record(), role = 'user'): Item =>
    ({ ...fieldsItem(from), data: { M: { role: { S: role } } } });

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
        ddbMock.on(PutItemCommand).resolves({});

        await makeStore().create(record({ data }));

        const item = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input.Item!;
        expect(item.pk).toEqual({ S: 'hashed-key' });
        expect(item.sk).toEqual({ S: 'secret-hash' });
        expect(item.sessionKeyHash).toBeUndefined();
        expect(item.secretHash).toBeUndefined();
        expect(item.data).toBeUndefined();
        expect(item.dataBytes).toEqual({ N: String(dataJsonBytes) });
        expect(Buffer.isBuffer(item.dataBr?.B)).toBe(true);
        expect(item.dataBr!.B!.byteLength).toBeLessThan(dataJsonBytes);
        expect(storedData(item)).toEqual(data);
        expect(item.csrfTokenHash).toEqual({ S: 'csrf-hash' });
        expect(item.sessionKey).toEqual({ S: 'user-123' });
    });

    it('honours custom key attribute names', async () => {
        ddbMock.on(PutItemCommand).resolves({});
        const keys = { partition: 'partition', sort: 'sort' };
        ddbMock.on(GetItemCommand).resolves({ Item: { ...fieldsItem(record(), keys), data: { M: { role: { S: 'admin' } } } } });
        const store = makeStore({ partitionKey: 'partition', sortKey: 'sort' });

        await store.create(record());
        const item = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input.Item!;
        expect(item.partition).toEqual({ S: 'hashed-key' });
        expect(item.sort).toEqual({ S: 'secret-hash' });
        expect(item.pk).toBeUndefined();

        const read = await store.get('hashed-key', 'secret-hash');
        expect(ddbMock.commandCalls(GetItemCommand)[0]!.args[0].input.Key).toEqual({ partition: { S: 'hashed-key' }, sort: { S: 'secret-hash' } });
        expect(read?.sessionKeyHash).toBe('hashed-key');
        expect(read?.secretHash).toBe('secret-hash');
        expect(read?.data).toEqual({ role: 'admin' });
    });

    it('compression: true is the default and equals { minBytes: 0 }; false stores the data plain; minBytes moves the threshold', async () => {
        ddbMock.on(PutItemCommand).resolves({});
        const tiny = { role: 'user' };

        await makeStore().create(record({ data: tiny }));
        await makeStore({ compression: true }).create(record({ data: tiny }));
        await makeStore({ compression: { minBytes: 0 } }).create(record({ data: tiny }));
        await makeStore({ compression: false }).create(record({ data }));
        await makeStore({ compression: { minBytes: dataJsonBytes } }).create(record({ data }));
        await makeStore({ compression: { minBytes: dataJsonBytes } }).create(record({ data: tiny }));

        const items = ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input.Item!);
        for(const item of items.slice(0, 3)){
            expect(item.data).toBeUndefined();
            expect(storedData(item)).toEqual(tiny);
        }
        expect(storedData(items[3]!)).toEqual(data);
        expect(items[3]!.dataBr).toBeUndefined();
        expect(items[4]!.dataBr).toBeDefined();
        expect(items[5]!.data).toEqual({ M: { role: { S: 'user' } } });
    });

    it('reads a compressed or a plain item back as the same record, whatever the current setting', async () => {
        ddbMock.on(GetItemCommand).resolves({ Item: { ...fieldsItem(record()), ...compressedItem(data) } });
        expect((await makeStore().get('hashed-key', 'secret-hash'))?.data).toEqual(data);
        expect((await makeStore({ compression: false }).get('hashed-key', 'secret-hash'))?.data).toEqual(data);

        ddbMock.on(GetItemCommand).resolves({ Item: plainItem(record(), 'admin') });
        const read = await makeStore().get('hashed-key', 'secret-hash');
        expect(read?.data).toEqual({ role: 'admin' });
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
        ddbMock.on(GetItemCommand).resolves({ Item: { ...fieldsItem(record()), dataBr: { B: dataBr!.B!.subarray(0, 8) }, dataBytes: dataBytes! } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        ddbMock.on(GetItemCommand).resolves({ Item: { ...fieldsItem(record()), dataBr: dataBr! } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        expect(warn).toHaveBeenCalled();

        // End to end: the manager reports no session, not a read error.
        const manager = new LambderSessionManager({ store: makeStore(), sessionSalt: 'salt' });
        expect(await manager.lookupSession('hashed-key:secret')).toBeNull();

        // A read that actually fails still surfaces, so a blip is never a logout.
        ddbMock.on(GetItemCommand).rejects(new Error('DynamoDB unavailable'));
        await expect(makeStore().get('hashed-key', 'secret-hash')).rejects.toThrow(/unavailable/);
        warn.mockRestore();
    });

    it('a plain data attribute JSON has no form for reads as no session, as an undecodable one does', async () => {
        // A set or a binary inside the data was not written from JSON, so the
        // record is not this store's, and handing the app a Set as session
        // data would break the first JSON.stringify of it.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        ddbMock.on(GetItemCommand).resolves({ Item: { ...fieldsItem(record()), data: { M: { tags: { SS: ['a', 'b'] } } } } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        expect(String(warn.mock.calls[0]?.[1])).toMatch(/cannot read an attribute of type SS as JSON/);
        warn.mockRestore();
    });

    it('reads an item missing the fields a session record has as no session', async () => {
        // Checked before the record is built, because everything past it
        // trusts them: the manager compares the two hashes in constant time,
        // where a non-string throws rather than answering false, and reads
        // expiresAt as a number to decide whether the session is over. An item
        // written by hand, by an older schema, or by another app sharing the
        // table is not this store's record, and it will not become one later.
        // Nothing is logged: a cookie naming such an item arrives on every
        // request until it expires.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const complete = plainItem();

        for(const missing of ['pk', 'sk', 'csrfTokenHash', 'sessionKey', 'createdAt', 'expiresAt', 'ttlInSeconds', 'dataVersion']){
            const { [missing]: _dropped, ...partial } = complete;
            ddbMock.on(GetItemCommand).resolves({ Item: partial });
            expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        }
        // The right name with the wrong type is missing too.
        ddbMock.on(GetItemCommand).resolves({ Item: { ...complete, expiresAt: { S: '2099' } } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        ddbMock.on(GetItemCommand).resolves({ Item: { ...complete, csrfTokenHash: { N: '7' } } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
        expect(warn).not.toHaveBeenCalled();

        ddbMock.on(GetItemCommand).resolves({ Item: complete });
        expect(await makeStore().get('hashed-key', 'secret-hash')).not.toBeNull();
        warn.mockRestore();
    });

    it('answers null for a missing item and deletes by the two hashes, handing back what it removed', async () => {
        ddbMock.on(GetItemCommand).resolves({});
        ddbMock.on(DeleteItemCommand).resolvesOnce({}).resolvesOnce({ Attributes: plainItem() });
        const store = makeStore();
        expect(await store.get('hashed-key', 'secret-hash')).toBeNull();
        expect(await store.delete('hashed-key', 'secret-hash')).toBeNull();
        const del = ddbMock.commandCalls(DeleteItemCommand)[0]!.args[0].input;
        expect(del.Key).toEqual({ pk: { S: 'hashed-key' }, sk: { S: 'secret-hash' } });
        expect(del.ReturnValues).toBe('ALL_OLD');

        expect(await store.delete('hashed-key', 'secret-hash')).toMatchObject({ sessionKey: 'user-123', data: { role: 'user' } });
    });

    it('rejects invalid compression options and an empty table name at construction', () => {
        expect(() => makeStore({ compression: { minBytes: -1 } })).toThrow();
        expect(() => makeStore({ compression: { quality: 12 } })).toThrow();
        expect(() => makeStore({ compression: { minBytes: 0, quality: 11 } })).not.toThrow();
        expect(() => makeStore({ tableName: ' ' })).toThrow('tableName is required');
    });
});

describe('LambderDdbSessionStore - the client', () => {
    beforeEach(() => { ddbMock.reset(); });

    it('takes the item-level client the other DynamoDB stores take, and sends through it', async () => {
        const client = new DynamoDBClient({ region: 'eu-west-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
        ddbMock.on(GetItemCommand).resolves({ Item: plainItem() });

        const read = await makeStore({ client }).get('hashed-key', 'secret-hash');

        expect(read?.data).toEqual({ role: 'user' });
        expect(ddbMock.send.thisValues[0]).toBe(client);
    });

    it('without one, sends through the default client the other stores share for its region', async () => {
        // One connection pool and credential chain for every store, rather
        // than a second client of its own for the session table.
        ddbMock.on(GetItemCommand).resolves({});
        await new LambderDdbCache({ tableName: 'test-cache', region: 'ap-northeast-2' }).get('order:1');
        await makeStore({ region: 'ap-northeast-2' }).get('hashed-key', 'secret-hash');

        const [cacheClient, sessionClient] = ddbMock.send.thisValues;
        expect(cacheClient).toBeInstanceOf(DynamoDBClient);
        expect(sessionClient).toBe(cacheClient);
    });
});

describe('LambderDdbSessionStore - items the document client wrote', () => {
    beforeEach(() => { ddbMock.reset(); });

    // A record and its item attribute for attribute as `@aws-sdk/lib-dynamodb`'s
    // document client marshals it: strings as S, every number as N text, the
    // data as a map holding lists, maps, booleans, null and an empty string.
    // Tables written that way keep reading, and the store writes the same
    // item, so a table holds one shape whichever wrote a record.
    const documentRecord: LambderSessionRecord = {
        sessionKeyHash: 'hashed-key',
        secretHash: 'secret-hash',
        csrfTokenHash: 'csrf-hash',
        sessionKey: 'user-123',
        data: {
            storeId: 'store-0042',
            cart: [{ sku: 'TICKET-1', quantity: 2, price: 19.99 }, { sku: 'ORDER-7', quantity: 1, price: 0.5 }],
            discount: -0.25,
            member: true,
            coupon: null,
            note: '',
            city: 'Zürich',
            tags: [],
            preferences: {},
        },
        createdAt: 1790000000,
        lastAccessedAt: 1790000500,
        expiresAt: 1790003600,
        ttlInSeconds: 3600,
        dataExpiresAt: 1790000900,
        dataVersion: 4,
    };
    const documentFields: Item = {
        pk: { S: 'hashed-key' },
        sk: { S: 'secret-hash' },
        csrfTokenHash: { S: 'csrf-hash' },
        sessionKey: { S: 'user-123' },
        createdAt: { N: '1790000000' },
        lastAccessedAt: { N: '1790000500' },
        expiresAt: { N: '1790003600' },
        ttlInSeconds: { N: '3600' },
        dataExpiresAt: { N: '1790000900' },
        dataVersion: { N: '4' },
    };
    const documentData: AttributeValue = {
        M: {
            storeId: { S: 'store-0042' },
            cart: {
                L: [
                    { M: { sku: { S: 'TICKET-1' }, quantity: { N: '2' }, price: { N: '19.99' } } },
                    { M: { sku: { S: 'ORDER-7' }, quantity: { N: '1' }, price: { N: '0.5' } } },
                ],
            },
            discount: { N: '-0.25' },
            member: { BOOL: true },
            coupon: { NULL: true },
            note: { S: '' },
            city: { S: 'Zürich' },
            tags: { L: [] },
            preferences: { M: {} },
        },
    };

    it('reads a record whose data is a plain map', async () => {
        ddbMock.on(GetItemCommand).resolves({ Item: { ...documentFields, data: documentData } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toEqual(documentRecord);
    });

    it('reads a record whose data is compressed', async () => {
        ddbMock.on(GetItemCommand).resolves({ Item: { ...documentFields, ...compressedItem(documentRecord.data) } });
        expect(await makeStore().get('hashed-key', 'secret-hash')).toEqual(documentRecord);
    });

    it('reads a record without the optional dataExpiresAt as one without it', async () => {
        const { dataExpiresAt: _dropped, ...fields } = documentFields;
        ddbMock.on(GetItemCommand).resolves({ Item: { ...fields, data: documentData } });
        const read = await makeStore().get('hashed-key', 'secret-hash');
        expect(read).not.toHaveProperty('dataExpiresAt');
        expect(read?.dataVersion).toBe(4);
    });

    it('writes the item the document client wrote, plain or compressed', async () => {
        ddbMock.on(PutItemCommand).resolves({});
        await makeStore({ compression: false }).create(documentRecord);
        await makeStore().create(documentRecord);

        const [plain, compressed] = ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input.Item!);
        expect(plain).toEqual({ ...documentFields, data: documentData });
        const json = Buffer.from(JSON.stringify(documentRecord.data), 'utf8');
        expect(compressed).toEqual({ ...documentFields, dataBr: { B: expect.any(Uint8Array) }, dataBytes: { N: String(json.byteLength) } });
        expect(storedData(compressed!)).toEqual(documentRecord.data);
    });

    it('updates the data and the numbers in the shapes the document client sent', async () => {
        ddbMock.on(UpdateItemCommand).resolves({});
        await makeStore({ compression: false }).update('hashed-key', 'secret-hash', { data: documentRecord.data, dataExpiresAt: 1790001800 }, { dataVersion: 4 });

        const values = ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input.ExpressionAttributeValues;
        expect(values).toEqual({
            ':data': documentData,
            ':dataExpiresAt': { N: '1790001800' },
            ':dataVersionStep': { N: '1' },
            ':readDataVersion': { N: '4' },
        });
    });
});

describe('LambderDdbSessionStore - the partition', () => {
    beforeEach(() => { ddbMock.reset(); });

    it('listSecretHashes queries the partition, projecting the sort key, and follows pagination', async () => {
        ddbMock.on(QueryCommand).resolvesOnce({ Items: [{ sk: { S: 'a' } }], LastEvaluatedKey: { pk: { S: 'hashed-key' }, sk: { S: 'a' } } })
            .resolvesOnce({ Items: [{ sk: { S: 'b' } }] });

        expect(await makeStore().listSecretHashes('hashed-key')).toEqual(['a', 'b']);

        const [first, second] = ddbMock.commandCalls(QueryCommand).map((call) => call.args[0].input);
        expect(first!.ExpressionAttributeValues?.[':pv']).toEqual({ S: 'hashed-key' });
        expect(first!.ProjectionExpression).toBe('#sk');
        expect(first!.ExpressionAttributeNames).toEqual({ '#pk': 'pk', '#sk': 'sk' });
        expect(first!.ConsistentRead).toBe(true);
        expect(second!.ExclusiveStartKey).toEqual({ pk: { S: 'hashed-key' }, sk: { S: 'a' } });
    });

    it('creates a record only where none exists, so a session is never overwritten', async () => {
        ddbMock.on(PutItemCommand).resolves({});
        await makeStore().create(record());
        const put = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input;
        expect(put.ConditionExpression).toBe('attribute_not_exists(#sk)');
        expect(put.ExpressionAttributeNames).toEqual({ '#sk': 'sk' });
    });

    it('updates only the named fields, only while the record exists, and moves dataVersion with the data or its deadline', async () => {
        ddbMock.on(UpdateItemCommand).resolves({});
        expect(await makeStore().update('hashed-key', 'secret-hash', { dataExpiresAt: 1234 })).toBe('updated');
        const update = ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input;
        expect(update.Key).toEqual({ pk: { S: 'hashed-key' }, sk: { S: 'secret-hash' } });
        expect(update.UpdateExpression).toBe('SET #dataExpiresAt = :dataExpiresAt ADD #dataVersion :dataVersionStep');
        expect(update.ConditionExpression).toBe('attribute_exists(#sk)');
        expect(update.ExpressionAttributeValues).toEqual({ ':dataExpiresAt': { N: '1234' }, ':dataVersionStep': { N: '1' } });

        // Data in one form removes the other, and a condition names the version read.
        ddbMock.reset();
        ddbMock.on(UpdateItemCommand).resolves({});
        await makeStore({ compression: false }).update('hashed-key', 'secret-hash', { data: { role: 'admin' } }, { dataVersion: 7 });
        const conditioned = ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input;
        expect(conditioned.UpdateExpression).toBe('SET #data = :data ADD #dataVersion :dataVersionStep REMOVE #dataBr, #dataBytes');
        expect(conditioned.ConditionExpression).toBe('attribute_exists(#sk) AND #dataVersion = :readDataVersion');
        expect(conditioned.ExpressionAttributeValues?.[':data']).toEqual({ M: { role: { S: 'admin' } } });
        expect(conditioned.ExpressionAttributeValues?.[':readDataVersion']).toEqual({ N: '7' });

        // Compressed, the other way round.
        ddbMock.reset();
        ddbMock.on(UpdateItemCommand).resolves({});
        await makeStore().update('hashed-key', 'secret-hash', { data: { role: 'admin' } });
        const compressed = ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input;
        expect(compressed.UpdateExpression).toBe('SET #dataBr = :dataBr, #dataBytes = :dataBytes ADD #dataVersion :dataVersionStep REMOVE #data');
        expect(compressed.ExpressionAttributeValues?.[':dataBytes']).toEqual({ N: String(Buffer.byteLength('{"role":"admin"}')) });

        // A slide alone leaves the version where it is.
        ddbMock.reset();
        ddbMock.on(UpdateItemCommand).resolves({});
        await makeStore().update('hashed-key', 'secret-hash', { lastAccessedAt: 5, expiresAt: 3605 });
        expect(ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input.UpdateExpression).toBe('SET #lastAccessedAt = :lastAccessedAt, #expiresAt = :expiresAt');

        ddbMock.on(UpdateItemCommand).rejects(new Error('ddb down'));
        await expect(makeStore().update('hashed-key', 'secret-hash', { expiresAt: 1 })).rejects.toThrow('ddb down');
    });

    it('tells stale from missing by the item the refused update hands back, with no read after it', async () => {
        // ALL_OLD on the condition failure answers "is the record still
        // there" in the same call, so a refused conditioned write costs one
        // round trip rather than two.
        const refused = (item?: Item) =>
            Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' }, item ? { Item: item } : {});

        ddbMock.on(UpdateItemCommand).rejects(refused({ pk: { S: 'hashed-key' }, sk: { S: 'secret-hash' }, dataVersion: { N: '3' } }));
        expect(await makeStore().update('hashed-key', 'secret-hash', { data: {} }, { dataVersion: 1 })).toBe('stale');
        expect(ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');

        ddbMock.on(UpdateItemCommand).rejects(refused());
        expect(await makeStore().update('hashed-key', 'secret-hash', { data: {} }, { dataVersion: 1 })).toBe('missing');
        expect(await makeStore().update('hashed-key', 'secret-hash', { expiresAt: 1 })).toBe('missing');

        expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
    });

    it('writes plain data through its JSON, so an undefined inside it does not fail the write', async () => {
        // Marshalling refuses undefined values, so handing it the raw object
        // would fail a login with a 500 when compression is off, while the
        // memory store accepts the same data.
        ddbMock.on(PutItemCommand).resolves({});
        await makeStore({ compression: false }).create(record({ data: { role: 'user', nickname: undefined } as never }));
        const item = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input.Item!;
        expect(item.data).toEqual({ M: { role: { S: 'user' } } });
    });
});

describe('LambderDdbSessionStore - size', () => {
    beforeEach(() => { ddbMock.reset(); });

    /** 450,000 random bytes as base64: text Brotli cannot get under the item budget. */
    const incompressible = () => randomBytes(450_000).toString('base64');

    it('refuses data too large for a DynamoDB item before writing, naming its size and the limit', async () => {
        // Left to DynamoDB, the item comes back as a ValidationException that
        // names neither, and a login answers 500 with nothing to go on.
        ddbMock.on(PutItemCommand).resolves({});
        ddbMock.on(UpdateItemCommand).resolves({});
        const plain = makeStore({ compression: false });
        const compressed = makeStore();
        const tooLarge = /^LambderDdbSessionStore: session\.data is \d+ bytes as stored, over the 401408 bytes a session record leaves it inside DynamoDB's 409600-byte item limit\./;

        await expect(plain.create(record({ data: { notes: 'x'.repeat(420_000) } }))).rejects.toThrow(tooLarge);
        await expect(plain.update('hashed-key', 'secret-hash', { data: { notes: 'x'.repeat(420_000) } })).rejects.toThrow(tooLarge);
        await expect(compressed.create(record({ data: { blob: incompressible() } }))).rejects.toThrow(tooLarge);
        await expect(compressed.update('hashed-key', 'secret-hash', { data: { blob: incompressible() } })).rejects.toThrow(tooLarge);
        expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
        expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('sizes plain data as DynamoDB sizes the attribute it sends', async () => {
        // "data" (4) + a map (3) + one entry: a byte, "notes" (5) and the string.
        ddbMock.on(PutItemCommand).resolves({});
        const budget = 401_408;
        const fits = budget - (4 + 3 + 1 + 5);
        await makeStore({ compression: false }).create(record({ data: { notes: 'x'.repeat(fits) } }));
        await expect(makeStore({ compression: false }).create(record({ data: { notes: 'x'.repeat(fits + 1) } })))
            .rejects.toThrow(`session.data is ${budget + 1} bytes as stored`);
        expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    });

    it('writes data that fits, plain or compressed, right up to the budget', async () => {
        ddbMock.on(PutItemCommand).resolves({});
        await makeStore({ compression: false }).create(record({ data: { notes: 'x'.repeat(390_000) } }));
        await makeStore().create(record({ data: { notes: 'x'.repeat(5_000_000) } }));
        expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(2);
    });

    it('refuses data past the ceiling it restores under, however small it compresses', async () => {
        // 32 MiB of one character compresses to almost nothing. Written, it
        // would be a record the store refuses to read back: a session that
        // reads as none on every request, with nothing logged at the write.
        ddbMock.on(PutItemCommand).resolves({});

        await expect(makeStore().create(record({ data: { blob: 'a'.repeat(32 * 1024 * 1024) } })))
            .rejects.toThrow(/^LambderDdbSessionStore: session\.data is 33554443 bytes of JSON, over the 33554432-byte limit of a session record\./);
        expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it('reads a record declaring more data than the ceiling as no session, without restoring it', async () => {
        // dataBytes bounds the decompression, so trusting a record that
        // declares more than the store writes lets a few hundred kilobytes of
        // Brotli expand into the function's memory on every request.
        const json = Buffer.from(JSON.stringify('a'.repeat(33 * 1024 * 1024)), 'utf8');
        const bomb = zlib.brotliCompressSync(json, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
        ddbMock.on(GetItemCommand).resolves({ Item: { ...fieldsItem(record()), dataBr: { B: bomb }, dataBytes: { N: String(json.byteLength) } } });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            expect(await makeStore().get('hashed-key', 'secret-hash')).toBeNull();
            const reason = warn.mock.calls[0]?.[1] as Error | undefined;
            expect(reason?.message).toMatch(/declares 34603010 bytes of text, over the 33554432-byte limit/);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('LambderDdbSessionStore - through the manager', () => {
    beforeEach(() => { ddbMock.reset(); });

    it('a session created through the manager lands as one compressed item under the hashes', async () => {
        ddbMock.on(PutItemCommand).resolves({});
        const manager = new LambderSessionManager({ store: makeStore(), sessionSalt: 'salt' });

        const { session, sessionToken } = await manager.createSession('user-123', data, 3600);

        const item = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input.Item!;
        expect(item.pk).toEqual({ S: session.sessionKeyHash });
        expect(item.sk).toEqual({ S: session.secretHash });
        expect(sessionToken.startsWith(`${session.sessionKeyHash}:`)).toBe(true);
        expect(storedData(item)).toEqual(data);
        expect(JSON.stringify(item)).not.toContain(sessionToken.split(':')[1]);
    });

    it('serializes session.data the way the memory store does, so a test over one holds for the other', async () => {
        // Both stores copy through JSON (structuredClone would keep an
        // undefined field and clone a cycle), so a test that passes over the
        // Map passes over the table.
        ddbMock.on(PutItemCommand).resolves({});
        const memoryStore = new LambderMemorySessionStore();
        const withUndefined = { a: undefined, b: 1 };

        for(const ddbStore of [makeStore(), makeStore({ compression: false })]){
            ddbMock.resetHistory();
            const ddbManager = new LambderSessionManager({ store: ddbStore, sessionSalt: 'salt' });
            await ddbManager.createSession('user-123', withUndefined, 3600);
            const ddbItem = ddbMock.commandCalls(PutItemCommand)[0]!.args[0].input.Item!;
            ddbMock.on(GetItemCommand).resolves({ Item: ddbItem });
            const fromDdb = await ddbStore.get(ddbItem.pk!.S!, ddbItem.sk!.S!);

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
        }
    });

    it('a read failure surfaces as a LambderSessionReadError', async () => {
        ddbMock.on(GetItemCommand).rejects(new Error('ddb down'));
        const manager = new LambderSessionManager({ store: makeStore(), sessionSalt: 'salt' });
        await expect(manager.lookupSession('hash:secret')).rejects.toThrow('Session read failed: ddb down');
    });
});

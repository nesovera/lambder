/**
 * What the idempotency engine hands a store and what it takes back from one:
 * a scope key that fits the store's key limit whoever the caller says they
 * are and that names nobody to a reader of the table, and a stored answer the
 * call replaying it cannot write into, whatever the store does with the
 * objects it holds.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { joinKeyFields } from '../../src/shared/util/joinKeyFields.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderDdbIdempotencyStore } from '../../src/stores/LambderDdbIdempotencyStore.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { LAMBDER_REFUSAL_CODES } from '../../src/shared/wire/LambderApiRefusal.js';
import type {
    LambderIdempotencyBeginResult,
    LambderIdempotencyDoneRecord,
    LambderIdempotencyStore,
} from '../../src/shared/contracts/LambderIdempotencyStore.js';
import { lambderTestApp } from '../../src/testing.js';
import { MemoryDdb } from '../helpers.js';

const KEY = 'order-key-0123456789abcdef';

/** A caller's field as an app with no session salt writes it: the plain SHA-256 of its kind and value, as a reader of the table would compute it. */
const unkeyedFieldDigest = (kind: string, value: string): string =>
    `${kind}:${createHash('sha256').update(joinKeyFields(kind, value), 'utf8').digest('hex')}`;

/** The same field in an app with a session salt: an HMAC under the subkey HKDF derives from the salt for this purpose alone. */
const keyedFieldDigest = (salt: string, kind: string, value: string): string => {
    const subkey = Buffer.from(hkdfSync('sha256', salt, Buffer.alloc(0), 'lambder/key-field-digest', 32));
    return `${kind}:${createHmac('sha256', subkey).update(joinKeyFields(kind, value), 'utf8').digest('hex')}`;
};

describe('The scope key a store is handed', () => {
    /**
     * A shop whose public API scopes its key by the device token the request
     * carries, over a DynamoDB store, the store with a key limit: what the
     * handler did, and the partition keys the table holds.
     */
    const createDeviceShop = () => {
        const table = new MemoryDdb();
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: table });
        const placed: number[] = [];
        const shop = initLambder().create({
            apiPath: '/api',
            idempotency: {
                store,
                callerIdentity: (_ctx, request) => request.headers['x-device-token'] ?? null,
            },
        });
        const lambder = shop.registerApiGroups(shop.defineApiGroup('order', {
            place: shop.defineApi({ input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
                async (ctx) => {
                    placed.push(ctx.apiPayload.qty);
                    return { placed: ctx.apiPayload.qty };
                }),
        }));
        const app = lambderTestApp(lambder, { idempotency: { store } });
        const partitionKeys = () => [...table.items.values()].map((item) => item.pk!.S!);
        return { app, placed, partitionKeys };
    };

    it('writes a long caller identity as its digest, so the retry replays instead of failing open into a second run', async () => {
        // A device token of 3 KB puts the scope past DynamoDB's 2048-byte
        // partition key limit. The store refuses such a key by throwing,
        // failOpen swallows the throw, and the retry runs the operation
        // again, with the token itself as the partition key on the way.
        // So is a token of 1,000 separators, which escaping doubles.
        for(const deviceToken of [`device-${'x'.repeat(3000)}`, '|'.repeat(1000)]){
            const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
            try {
                const { app, placed, partitionKeys } = createDeviceShop();
                const visitor = app.visitor({ headers: { 'X-Device-Token': deviceToken } });

                expect(await visitor.api('order.place', { qty: 3 }, { idempotencyKey: KEY })).toEqual({ placed: 3 });
                expect(await visitor.api('order.place', { qty: 3 }, { idempotencyKey: KEY })).toEqual({ placed: 3 });

                expect(placed).toEqual([3]);
                expect(errors).not.toHaveBeenCalled();
                const [partitionKey, ...others] = partitionKeys();
                expect(others).toEqual([]);
                // The digest as a reader of the table would compute it.
                expect(partitionKey).toBe(`IDEM#${joinKeyFields(unkeyedFieldDigest('i', deviceToken), 'order.place', unkeyedFieldDigest('key', KEY))}`);
            } finally {
                errors.mockRestore();
            }
        }
    });

    it('writes a short identity and the posted key as digests too, so a table read shows the API and never the caller', async () => {
        const { app, partitionKeys } = createDeviceShop();

        await app.visitor({ headers: { 'X-Device-Token': 'device-42' } }).api('order.place', { qty: 1 }, { idempotencyKey: KEY });

        expect(partitionKeys()).toEqual([`IDEM#${joinKeyFields(unkeyedFieldDigest('i', 'device-42'), 'order.place', unkeyedFieldDigest('key', KEY))}`]);
        expect(partitionKeys()[0]).not.toContain('device-42');
        expect(partitionKeys()[0]).not.toContain(KEY);
    });

    it('keys the digest with a subkey of the session salt where the app has one, so a table read cannot test a guess', async () => {
        // A signed-in user's scope, in an app whose sessions give it a
        // secret. The subkey is derived for this purpose alone: the session
        // store's partition hash, the salt's own HMAC of the sessionKey, rides
        // in the session cookie, and must not be any digest written here.
        const createSignedInShop = (sessionSalt: string) => {
            const table = new MemoryDdb();
            const store = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: table });
            const shop = initLambder<{ userId: string }>().create({
                apiPath: '/api',
                session: { store: new LambderMemorySessionStore(), sessionSalt },
                idempotency: { store },
                guards: { signedIn: { session: true, handler: async () => {} } },
            });
            const lambder = shop.registerApiGroups(shop.defineApiGroup('order', {
                place: shop.defineApi({ input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true, guards: 'signedIn' },
                    async (ctx) => ({ placed: ctx.apiPayload.qty })),
            }));
            return { app: lambderTestApp(lambder, { idempotency: { store } }), partitionKeys: () => [...table.items.values()].map((item) => item.pk!.S!) };
        };
        const placeAs = async (sessionSalt: string) => {
            const { app, partitionKeys } = createSignedInShop(sessionSalt);
            await (await app.signIn('ada@example.com', { userId: 'ada' })).api('order.place', { qty: 1 }, { idempotencyKey: KEY });
            return partitionKeys();
        };

        const [scope] = await placeAs('shop-salt');
        expect(scope).toBe(`IDEM#${joinKeyFields(keyedFieldDigest('shop-salt', 's', 'ada@example.com'), 'order.place', keyedFieldDigest('shop-salt', 'key', KEY))}`);
        expect(scope).not.toContain('ada@example.com');
        expect(scope).not.toContain(createHmac('sha256', 'shop-salt').update('ada@example.com').digest('hex'));
        // Another app's salt, another scope for the same caller and key.
        expect(await placeAs('other-salt')).not.toEqual([scope]);
    });
});

describe('The fingerprint a request is claimed under', () => {
    it('refuses a payload nested too deep to canonicalize as the caller\'s error, not as a crash', async () => {
        const crashes: unknown[] = [];
        let handlerRuns = 0;
        const shop = initLambder().create({
            apiPath: '/api',
            idempotency: { store: new LambderMemoryIdempotencyStore() },
            crashes: { report: (error) => { crashes.push(error); } },
        });
        const app = lambderTestApp(shop.registerApiGroups(shop.defineApiGroup('order', {
            place: shop.defineApi({ input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
                async (_ctx) => { handlerRuns += 1; return { placed: 1 }; }),
        })));
        // Sorting the keys recurses per level; the schema would strip the
        // field, but the fingerprint is taken before it runs.
        const depth = 200_000;
        const body = `{"payload":{"qty":1,"x":${'['.repeat(depth)}${']'.repeat(depth)}},"idempotencyKey":"${KEY}"}`;
        const answer = await app.visitor().request('POST', '/api/order/place', { body, headers: { 'content-type': 'application/json' } });
        expect(answer.statusCode).toBe(400);
        expect(answer.json()).toMatchObject({ refusal: { code: LAMBDER_REFUSAL_CODES.invalidRequestPayload } });
        expect(handlerRuns).toBe(0);
        expect(crashes).toEqual([]);
    });
});

describe('The stored answer a replay is built from', () => {
    /**
     * A store that keeps the record the engine hands it and hands back the
     * very object it keeps, as an in-process store may. The interface asks
     * for copies both ways; this one is what the engine has to survive.
     */
    class ReferenceKeepingStore implements LambderIdempotencyStore {
        readonly records = new Map<string, LambderIdempotencyDoneRecord>();
        private readonly claims = new Map<string, string>();

        async peek(scopeKey: string): Promise<LambderIdempotencyDoneRecord | null> {
            return this.records.get(scopeKey) ?? null;
        }

        async begin(scopeKey: string, options: { pendingTtlSeconds: number; fingerprint: string }): Promise<LambderIdempotencyBeginResult> {
            const record = this.records.get(scopeKey);
            if(record) return Object.assign(record, { state: 'done' as const });
            const claimed = this.claims.get(scopeKey);
            if(claimed !== undefined) return { state: 'pending', fingerprint: claimed };
            this.claims.set(scopeKey, options.fingerprint);
            return { state: 'new', ownerToken: 'owner' };
        }

        async complete(scopeKey: string, _ownerToken: string, record: LambderIdempotencyDoneRecord & { ttlSeconds: number }): Promise<'stored'> {
            this.claims.delete(scopeKey);
            this.records.set(scopeKey, record);
            return 'stored';
        }

        async abandon(scopeKey: string): Promise<void> {
            this.claims.delete(scopeKey);
        }
    }

    it('is a copy, so the replaying call\'s own Set-Cookie never joins the record replayed to the next device', async () => {
        // A hook sets a per-visit cookie on every call. The handler's answer
        // is stored without it, and each replay carries the replaying call's
        // own cookie, written into the answer's headers as the call ends.
        // Written into the store's own object, device B's cookie would be in
        // the record, and device C's replay would carry it.
        let visits = 0;
        const store = new ReferenceKeepingStore();
        const shop = initLambder().create({ apiPath: '/api', idempotency: { store } });
        const lambder = shop.registerApiGroups(shop.defineApiGroup('order', {
            place: shop.defineApi({ input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
                async (ctx) => ({ placed: ctx.apiPayload.qty })),
        }))
            .addHook('beforeRender', async (ctx, res) => {
                visits += 1;
                ctx.setCookie('visit', String(visits));
                return ctx;
            });
        const app = lambderTestApp(lambder, { idempotency: { store } });

        for(const clientIp of ['203.0.113.1', '203.0.113.2', '203.0.113.3']){
            expect(await app.visitor({ clientIp }).api('order.place', { qty: 1 }, { idempotencyKey: KEY })).toEqual({ placed: 1 });
        }

        const [record, ...others] = [...store.records.values()];
        expect(others).toEqual([]);
        expect(Object.keys(record!.headers).map((name) => name.toLowerCase())).not.toContain('set-cookie');
    });
});

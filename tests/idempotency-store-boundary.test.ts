/**
 * What the idempotency engine hands a store and what it takes back from one:
 * a scope key that fits the store's key limit whoever the caller says they
 * are, and a stored answer the call replaying it cannot write into, whatever
 * the store does with the objects it holds.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { LambderDdbIdempotencyStore } from '../src/stores/LambderDdbIdempotencyStore.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { LAMBDER_REFUSAL_CODES } from '../src/shared/wire/LambderApiRefusal.js';
import type {
    LambderIdempotencyBeginResult,
    LambderIdempotencyDoneRecord,
    LambderIdempotencyStore,
} from '../src/shared/contracts/LambderIdempotencyStore.js';
import { lambderTestApp } from '../src/testing.js';
import { MemoryDdb } from './helpers.js';

const KEY = 'order-key-0123456789abcdef';

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
        const lambder = initLambder().create({
            apiPath: '/api',
            idempotency: {
                store,
                callerIdentity: (_ctx, request) => request.headers['x-device-token'] ?? null,
            },
        }).addApi('order.place', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
            async (ctx, res) => {
                placed.push(ctx.apiPayload.qty);
                return res.api({ placed: ctx.apiPayload.qty });
            });
        const app = lambderTestApp(lambder, { idempotency: { store } });
        const partitionKeys = () => [...table.items.values()].map((item) => item.pk!.S!);
        return { app, placed, partitionKeys };
    };

    it('bounds a long caller identity, so the retry replays instead of failing open into a second run', async () => {
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
                expect(partitionKey).toBe(`IDEM#i:h:${createHash('sha256').update(deviceToken, 'utf8').digest('hex')}|order.place|${KEY}`);
            } finally {
                errors.mockRestore();
            }
        }
    });

    it('keeps an identity that fits as it is, so the table stays readable', async () => {
        const { app, partitionKeys } = createDeviceShop();

        await app.visitor({ headers: { 'X-Device-Token': 'device-42' } }).api('order.place', { qty: 1 }, { idempotencyKey: KEY });

        expect(partitionKeys()).toEqual([`IDEM#i:device-42|order.place|${KEY}`]);
    });
});

describe('The fingerprint a request is claimed under', () => {
    it('refuses a payload nested too deep to canonicalize as the caller\'s error, not as a crash', async () => {
        const crashes: unknown[] = [];
        let handlerRuns = 0;
        const app = lambderTestApp(initLambder().create({
            apiPath: '/api',
            idempotency: { store: new LambderMemoryIdempotencyStore() },
            crashes: { report: (error) => { crashes.push(error); } },
        }).addApi('order.place', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
            async (_ctx, res) => { handlerRuns += 1; return res.api({ placed: 1 }); }));
        // Sorting the keys recurses per level; the schema would strip the
        // field, but the fingerprint is taken before it runs.
        const depth = 200_000;
        const body = `{"apiName":"order.place","payload":{"qty":1,"x":${'['.repeat(depth)}${']'.repeat(depth)}},"idempotencyKey":"${KEY}"}`;
        const answer = await app.visitor().request('POST', '/api', { body, headers: { 'content-type': 'application/json' } });
        expect(answer.statusCode).toBe(400);
        expect(answer.json()).toMatchObject({ errorMessage: { code: LAMBDER_REFUSAL_CODES.invalidRequestPayload } });
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
        const lambder = initLambder().create({ apiPath: '/api', idempotency: { store } })
            .addHook('beforeRender', async (ctx, res) => {
                visits += 1;
                res.setCookie('visit', String(visits));
                return ctx;
            })
            .addApi('order.place', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
                async (ctx, res) => res.api({ placed: ctx.apiPayload.qty }));
        const app = lambderTestApp(lambder, { idempotency: { store } });

        for(const clientIp of ['203.0.113.1', '203.0.113.2', '203.0.113.3']){
            expect(await app.visitor({ clientIp }).api('order.place', { qty: 1 }, { idempotencyKey: KEY })).toEqual({ placed: 1 });
        }

        const [record, ...others] = [...store.records.values()];
        expect(others).toEqual([]);
        expect(Object.keys(record!.headers).map((name) => name.toLowerCase())).not.toContain('set-cookie');
    });
});

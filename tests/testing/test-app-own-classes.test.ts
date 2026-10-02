/**
 * lambder/testing: the Lambder classes an app builds itself, beside its
 * instance, put under test without the app handing them over.
 *
 * Every class below is built the way an application builds it, as a
 * module-level constant over AWS clients a test must never reach: any use of
 * one throws. A call that passes proves the test app put a memory twin (or,
 * for an invoke caller, a mock app) under the class in place.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { LambderDdbCache } from '../../src/stores/LambderDdbCache.js';
import { LambderDdbOneShotSecretStore } from '../../src/stores/LambderDdbOneShotSecretStore.js';
import { LambderS3UploadBucket } from '../../src/stores/LambderS3UploadBucket.js';
import { LambderOneShotSecrets } from '../../src/secrets/LambderOneShotSecrets.js';
import LambderInvokeCaller from '../../src/invoke/LambderInvokeCaller.js';
import { initLambderMock } from '../../src/mock/LambderMockApp.js';
import { sha256Base64Of } from '../../src/shared/util/LambderTextDigest.js';
import {
    lambderTestApp,
    LambderMemoryCache,
    LambderMemoryOneShotSecretStore,
    LambderMemoryUploadBucket,
} from '../../src/testing.js';

/** An AWS client standing in for production: any use is a failure. */
const unreachable = (what: string) => ({ send: async () => { throw new Error(`a test reached ${what}`); } }) as never;

type BillingContract = { 'invoice.charge': { input: { amount: number }; output: { charged: number }; mode: 'public' } };
type ShippingContract = { 'parcel.send': { input: { orderId: string }; output: { trackingId: string }; mode: 'public' } };

// The app's own classes, built before any test app exists.
const storeHours = new LambderDdbCache({ tableName: 'shop-cache', client: unreachable('DynamoDB'), defaultTtlSeconds: 60 });
const pickupCodes = new LambderOneShotSecrets({
    store: new LambderDdbOneShotSecretStore({ tableName: 'shop-secrets', client: unreachable('DynamoDB') }),
    secret: 'pickup-secret',
    kinds: { pickup: { shape: 'code', length: 6, ttlSeconds: 600, maxAttempts: 3 } },
});
const pickupCodeStore = (pickupCodes as unknown as { store: LambderDdbOneShotSecretStore }).store;
const receipts = new LambderS3UploadBucket({ bucket: 'shop-receipts', client: unreachable('S3'), uploadMethod: 'PUT', ticketLifetimeSeconds: 120 });
const billing = new LambderInvokeCaller<BillingContract>({ functionName: 'billing', client: unreachable('Lambda') });
const shipping = new LambderInvokeCaller<ShippingContract>({ functionName: 'shipping', client: unreachable('Lambda') });

/** Built by a handler on first use, after the test app exists. */
let lateCache: LambderDdbCache | null = null;

const RECEIPT_RULE = { maxBytes: 1024, mimeTypes: ['text/plain'] };

const createShop = () => {
    const shop = initLambder().create({});
    return shop.registerApiGroups(
        shop.defineApiGroup('hours', {
            write: shop.defineApi({ input: z.object({ store: z.string(), opens: z.string() }), output: z.object({ ok: z.boolean() }) },
                async (ctx) => { await storeHours.set(`hours:${ctx.apiPayload.store}`, ctx.apiPayload.opens); return { ok: true }; }),
            read: shop.defineApi({ input: z.object({ store: z.string() }), output: z.object({ opens: z.string().nullable() }) },
                async (ctx) => ({ opens: (await storeHours.get<string>(`hours:${ctx.apiPayload.store}`)) ?? null })),
            late: shop.defineApi({ input: z.object({}), output: z.object({ hits: z.number() }) }, async () => {
                lateCache ??= new LambderDdbCache({ tableName: 'shop-late', client: unreachable('DynamoDB') });
                const hits = ((await lateCache.get<number>('hits')) ?? 0) + 1;
                await lateCache.set('hits', hits);
                return { hits };
            }),
        }),
        shop.defineApiGroup('pickup', {
            issue: shop.defineApi({ input: z.object({ orderId: z.string() }), output: z.object({ code: z.string() }) }, async (ctx) => {
                const issued = await pickupCodes.issue('pickup', `order:${ctx.apiPayload.orderId}`);
                if(!issued.issued) throw new Error('not issued');
                return { code: issued.plaintext };
            }),
            redeem: shop.defineApi({ input: z.object({ orderId: z.string(), code: z.string() }), output: z.object({ state: z.string() }) },
                async (ctx) => ({ state: (await pickupCodes.redeem('pickup', `order:${ctx.apiPayload.orderId}`, ctx.apiPayload.code)).state })),
        }),
        shop.defineApiGroup('receipt', {
            requestUpload: shop.defineApi({ input: z.object({ orderId: z.string(), byteSize: z.number(), sha256Base64: z.string() }), output: z.any() },
                async (ctx) => await receipts.issueUploadTicket({
                    objectKey: `receipts/${ctx.apiPayload.orderId}.txt`,
                    fileFacts: { fileName: 'receipt.txt', mimeType: 'text/plain', byteSize: ctx.apiPayload.byteSize, sha256Base64: ctx.apiPayload.sha256Base64 },
                    uploadRule: RECEIPT_RULE,
                })),
            confirm: shop.defineApi({ input: z.object({ orderId: z.string(), byteSize: z.number(), sha256Base64: z.string() }), output: z.object({ verified: z.boolean() }) },
                async (ctx) => ({ verified: (await receipts.verifyUploadedObject({ objectKey: `receipts/${ctx.apiPayload.orderId}.txt`, fileFacts: ctx.apiPayload })).verified })),
        }),
        shop.defineApiGroup('order', {
            pay: shop.defineApi({ input: z.object({ amount: z.number() }), output: z.object({ charged: z.number() }) },
                async (ctx) => await billing.invoice.charge({ amount: ctx.apiPayload.amount })),
            ship: shop.defineApi({ input: z.object({ orderId: z.string() }), output: z.object({ trackingId: z.string() }) },
                async (ctx) => await shipping.parcel.send({ orderId: ctx.apiPayload.orderId })),
        }),
    );
};

const billingMock = initLambderMock<BillingContract>().create({});
billingMock.registerPartial(billingMock.apiSlice(
    billingMock.api('invoice.charge', async ({ payload }) => ({ charged: payload.amount })),
));

const shop = createShop();
const app = lambderTestApp(shop, { invokeMocks: { billing: billingMock } });
beforeEach(() => app.reset());

describe('lambderTestApp: the app\'s own stores', () => {
    it('puts a memory twin under a cache built before the test app, so the app\'s handlers never reach the table', async () => {
        const visitor = app.visitor();
        expect(await visitor.hours.write({ store: 'nyc-01', opens: '09:00' })).toEqual({ ok: true });
        expect(await visitor.hours.read({ store: 'nyc-01' })).toEqual({ opens: '09:00' });

        const twin = app.memoryTwinOf(storeHours);
        expect(twin).toBeInstanceOf(LambderMemoryCache);
        expect(await twin.get('hours:nyc-01')).toBe('09:00');
        // What the test seeds is what the app reads.
        await twin.set('hours:nyc-02', '10:00');
        expect(await visitor.hours.read({ store: 'nyc-02' })).toEqual({ opens: '10:00' });
    });

    it('builds the twin with the cache\'s own settings: its default TTL here', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const visitor = app.visitor();
            await visitor.hours.write({ store: 'nyc-01', opens: '09:00' });
            vi.setSystemTime(Date.now() + 61_000);
            expect(await visitor.hours.read({ store: 'nyc-01' })).toEqual({ opens: null });
        } finally {
            vi.useRealTimers();
        }
    });

    it('reaches a class built after the test app, by a handler', async () => {
        const visitor = app.visitor();
        expect(await visitor.hours.late({})).toEqual({ hits: 1 });
        expect(await visitor.hours.late({})).toEqual({ hits: 2 });
        expect(await app.memoryTwinOf(lateCache!).get('hits')).toBe(2);
    });

    it('puts a memory twin under the store of the app\'s one-shot secrets', async () => {
        const visitor = app.visitor();
        const { code } = await visitor.pickup.issue({ orderId: '1001' });
        expect(await visitor.pickup.redeem({ orderId: '1001', code })).toEqual({ state: 'accepted' });
        expect(app.memoryTwinOf(pickupCodeStore)).toBeInstanceOf(LambderMemoryOneShotSecretStore);
    });

    it('puts a memory twin under an upload bucket, signing as the bucket was configured, which a test sends the file to', async () => {
        const visitor = app.visitor();
        const body = new TextEncoder().encode('one kettle, $25.00');
        const facts = { orderId: '1001', byteSize: body.byteLength, sha256Base64: await sha256Base64Of(body) };

        const ticket = await visitor.receipt.requestUpload(facts);
        const twin = app.memoryTwinOf(receipts);
        expect(twin).toBeInstanceOf(LambderMemoryUploadBucket);
        expect(ticket.method).toBe('PUT');
        expect(ticket.uploadUrl.startsWith(twin.baseUrl)).toBe(true);
        expect(ticket.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);

        expect(await visitor.receipt.confirm(facts)).toEqual({ verified: false });
        const stored = await twin.handleStorageRequest(new Request(ticket.uploadUrl, { method: 'PUT', headers: ticket.headers, body }));
        expect(stored?.status).toBe(200);
        expect(await visitor.receipt.confirm(facts)).toEqual({ verified: true });
    });

    it('empties every twin on reset', async () => {
        const visitor = app.visitor();
        await visitor.hours.write({ store: 'nyc-01', opens: '09:00' });
        app.reset();
        expect(await visitor.hours.read({ store: 'nyc-01' })).toEqual({ opens: null });
    });

    it('refuses memoryTwinOf for what it put no twin under', () => {
        expect(() => app.memoryTwinOf({} as LambderDdbCache)).toThrow(/put no memory twin under/);
    });
});

describe('lambderTestApp: the app\'s own invoke callers', () => {
    it('answers an invoke caller from the mock app given for its function', async () => {
        expect(await app.visitor().order.pay({ amount: 2500 })).toEqual({ charged: 2500 });
    });

    it('fails every call of an invoke caller no mock answers, naming the function, rather than reaching AWS', async () => {
        await expect(app.visitor().order.ship({ orderId: '1001' })).rejects.toThrow(/order\.ship: .*reason "server"/);
        expect(app.crashes.map((crash) => crash.message)).toEqual([
            expect.stringMatching(/^shipping parcel\.send failed \(network\): lambderTestApp: no invoke mock answers the function "shipping"/),
        ]);
    });

    it('leaves a caller given its own transport alone', async () => {
        const callee = initLambder().create({});
        const billingCallee = callee.registerApiGroups(callee.defineApiGroup('invoice', {
            charge: callee.defineApi({ input: z.object({ amount: z.number() }), output: z.object({ charged: z.number() }) },
                async (ctx) => ({ charged: ctx.apiPayload.amount + 1 })),
        }));
        const local = new LambderInvokeCaller<BillingContract>({ functionName: 'billing', transport: LambderInvokeCaller.localTransport(billingCallee.getHandler()) });
        // The real callee, not the mock app invokeMocks names for the same function.
        expect(await local.invoice.charge({ amount: 2500 })).toEqual({ charged: 2501 });
    });

    it('refuses an invokeMocks entry that is not a mock app, at creation', () => {
        expect(() => lambderTestApp(createShop(), { invokeMocks: { billing: {} as never } }))
            .toThrow('lambderTestApp: invokeMocks["billing"] is not a LambderMockApp (what initLambderMock().create() returns).');
    });
});

describe('lambderTestApp: the test app created last', () => {
    it('puts its own twins under every one of the app\'s classes', async () => {
        await app.visitor().hours.write({ store: 'nyc-01', opens: '09:00' });
        const first = app.memoryTwinOf(storeHours);

        const later = lambderTestApp(initLambder().create({}));
        expect(later.memoryTwinOf(storeHours)).not.toBe(first);
        expect(await storeHours.get('hours:nyc-01')).toBeUndefined();
        await storeHours.set('hours:nyc-01', '08:00');
        expect(await later.memoryTwinOf(storeHours).get('hours:nyc-01')).toBe('08:00');
        // With no invoke mocks, a caller the first answered now fails.
        await expect(billing.invoice.charge({ amount: 1 })).rejects.toThrow(/no invoke mock answers the function "billing"/);
    });
});

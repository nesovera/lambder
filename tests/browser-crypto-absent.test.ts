/**
 * The other half of what a bundled browser build sees. package.json maps
 * crypto to `false` for the browser as it maps zlib, and a bundler honours
 * that with a STUB MODULE rather than an error, so the probe asks the module
 * for a function it would really export.
 *
 * browser-zlib-absent.test.ts pins the zlib seam; this pins the crypto seam,
 * which nothing else in the suite touches. A static `import crypto from
 * "crypto"` in either DynamoDB store passes every other test and breaks only
 * in a bundle, as "crypto.randomBytes is not a function" instead of the
 * environment error the stores mean to give.
 */

import { describe, it, expect, vi } from 'vitest';

// A webpack-shaped stub: an object with nothing on it.
vi.mock('crypto', () => ({ default: {} }));
// A page served over plain http (a phone on the LAN): random values, but no
// crypto.subtle, which a browser gives only a secure context.
const pageCrypto = globalThis.crypto;
vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(array: T): T => pageCrypto.getRandomValues(array as never) });

const { getCrypto } = await import('../src/shared/util/LambderNodeModules.js');
const { LambderDdbIdempotencyStore } = await import('../src/stores/LambderDdbIdempotencyStore.js');
const { LambderDdbCache } = await import('../src/stores/LambderDdbCache.js');
const { initLambderMock } = await import('../src/mock/LambderMockApp.js');
const { default: LambderCaller } = await import('../src/client/LambderCaller.js');
const { createIdempotencyKey } = await import('../src/shared/wire/LambderIdempotencyKeyScope.js');

describe('A runtime whose crypto is a bundler stub', () => {
    it('reports no crypto at all, rather than a module that cannot hash', async () => {
        expect(await getCrypto()).toBeNull();
    });

    it('refuses an idempotency claim with the environment error, not a TypeError', async () => {
        // The claim's owner token is 16 random bytes, and it is drawn before
        // the store ever reaches the table, so this is the first thing a
        // bundled build would hit.
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table' });

        await expect(store.begin('s', { pendingTtlSeconds: 60, fingerprint: 'request-1' }))
            .rejects.toThrow('LambderDdbIdempotencyStore requires a Node.js environment.');
    });

    it('refuses a cache read the same way, since every key is hashed into its partition', async () => {
        const cache = new LambderDdbCache({ tableName: 'test-cache' });

        await expect(cache.get('city')).rejects.toThrow('LambderDdbCache requires a Node.js environment.');
    });
});

describe('The mock on a page without crypto.subtle', () => {
    it('answers an idempotent call, and replays it under its key', async () => {
        type Contract = { 'ticket.buy': { input: { seat: string }; output: { ticketId: number }; mode: 'public'; idempotency: true } };
        const mock = initLambderMock<Contract>();
        const app = mock.create({ idempotency: true });
        let sold = 0;
        app.register(app.apiSlice(app.publicApi('ticket.buy', { idempotency: true, handler: async () => ({ ticketId: ++sold }) })));
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport: app.transport() });
        const idempotencyKey = createIdempotencyKey();

        const first = await caller.apiOutcome('ticket.buy', { seat: 'A1' }, { idempotencyKey });
        const retry = await caller.apiOutcome('ticket.buy', { seat: 'A1' }, { idempotencyKey });
        expect(first.ok && first.payload).toEqual({ ticketId: 1 });
        expect(retry.ok && retry.payload).toEqual({ ticketId: 1 });
        expect(sold).toBe(1);
    });
});

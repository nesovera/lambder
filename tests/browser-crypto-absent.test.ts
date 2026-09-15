/**
 * The other half of what a bundled browser build sees. package.json maps
 * crypto to `false` for the browser exactly as it maps zlib, and a bundler
 * honours that by resolving the import to a STUB MODULE rather than by
 * rejecting it, so the same probe decides the question: the module is asked
 * for a function it would really export.
 *
 * Its sibling browser-zlib-absent.test.ts pins the zlib seam. This one pins
 * the crypto seam, which nothing else in the suite touches: a static
 * `import crypto from "crypto"` in either DynamoDB store leaves every other
 * test green and breaks only in a bundle, where the stub's missing function
 * surfaces as "crypto.randomBytes is not a function" rather than as the
 * environment error the stores mean to give.
 */

import { describe, it, expect, vi } from 'vitest';

// A webpack-shaped stub: an object with nothing on it.
vi.mock('crypto', () => ({ default: {} }));

const { getCrypto } = await import('../src/shared/util/LambderNodeModules.js');
const { LambderDdbIdempotencyStore } = await import('../src/stores/LambderDdbIdempotencyStore.js');
const { LambderDdbCache } = await import('../src/stores/LambderDdbCache.js');

describe('A runtime whose crypto is a bundler stub', () => {
    it('reports no crypto at all, rather than a module that cannot hash', async () => {
        expect(await getCrypto()).toBeNull();
    });

    it('refuses an idempotency claim with the environment error, not a TypeError', async () => {
        // The claim's owner token is 16 random bytes, and it is drawn before
        // the store ever reaches the table, so this is the first thing a
        // bundled build would hit.
        const store = new LambderDdbIdempotencyStore({ tableName: 'test-table' });

        await expect(store.begin('s', { pendingTtlSeconds: 60 }))
            .rejects.toThrow('LambderDdbIdempotencyStore requires a Node.js environment.');
    });

    it('refuses a cache read the same way, since every key is hashed into its partition', async () => {
        const cache = new LambderDdbCache({ tableName: 'test-cache' });

        await expect(cache.get('city')).rejects.toThrow('LambderDdbCache requires a Node.js environment.');
    });
});

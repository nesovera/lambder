/**
 * The digest every caller-controlled field of a rate-limit tracker key and an
 * idempotency scope is written as: fixed length whatever the value's, keyed
 * by a subkey of the app's at-rest secret where it has one, and a plain
 * SHA-256 where it has none, each computed here the way a reader of the
 * table would.
 */

import { describe, it, expect } from 'vitest';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { LambderKeyFieldDigest } from '../../src/shared/util/LambderKeyFieldDigest.js';
import { joinKeyFields } from '../../src/shared/util/joinKeyFields.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('LambderKeyFieldDigest', () => {
    it('without a secret, writes the plain SHA-256 of the kind and the value joined', async () => {
        const digest = new LambderKeyFieldDigest(null);

        expect(digest.isKeyed).toBe(false);
        expect(await digest.digestOf('custom', 'ada@example.com')).toBe(`custom:${sha256Hex(joinKeyFields('custom', 'ada@example.com'))}`);
    });

    it('with a secret, writes an HMAC under the subkey HKDF derives for this purpose, never under the secret itself', async () => {
        const digest = new LambderKeyFieldDigest('store-salt');
        const subkey = Buffer.from(hkdfSync('sha256', 'store-salt', Buffer.alloc(0), 'lambder/key-field-digest', 32));
        const written = await digest.digestOf('session', 'ada@example.com');

        expect(digest.isKeyed).toBe(true);
        expect(written).toBe(`session:${createHmac('sha256', subkey).update(joinKeyFields('session', 'ada@example.com')).digest('hex')}`);
        // The salt keys the session store's partition hash itself, which
        // rides in every session cookie: no message under it may give this.
        expect(written).not.toContain(createHmac('sha256', 'store-salt').update('ada@example.com').digest('hex'));
        expect(written).not.toContain(createHmac('sha256', 'store-salt').update(joinKeyFields('session', 'ada@example.com')).digest('hex'));
        // Another secret, another digest: a guess cannot be tested without it.
        expect(await new LambderKeyFieldDigest('other-salt').digestOf('session', 'ada@example.com')).not.toBe(written);
        expect(await new LambderKeyFieldDigest(null).digestOf('session', 'ada@example.com')).not.toBe(written);
    });

    it('gives one value under two kinds two unrelated digests, and one length whatever the value', async () => {
        const digest = new LambderKeyFieldDigest('store-salt');
        const asSession = await digest.digestOf('s', 'ada@example.com');
        const asIdentity = await digest.digestOf('i', 'ada@example.com');

        expect(asSession.slice(2)).not.toBe(asIdentity.slice(2));
        const lengths = await Promise.all(['', 'a', 'x'.repeat(5000), '|'.repeat(1000)].map(async (value) => (await digest.digestOf('custom', value)).length));
        expect(new Set(lengths)).toEqual(new Set(['custom:'.length + 64]));
        // Separators in the value cannot shift it into another kind: the digested halves differ too.
        const hexOf = (written: string) => written.slice(written.lastIndexOf(':') + 1);
        expect(hexOf(await digest.digestOf('a', 'b|c'))).not.toBe(hexOf(await digest.digestOf('a|b', 'c')));
    });

    it('refuses an empty secret at creation, which would key nothing', () => {
        expect(() => new LambderKeyFieldDigest('')).toThrow(/at-rest secret that keys the digest of rate-limit and idempotency keys is empty/);
    });
});

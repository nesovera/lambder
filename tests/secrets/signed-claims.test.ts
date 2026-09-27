/**
 * LambderSignedClaims, and the two helpers beside it for secrets an app
 * stores: the envelope is pinned to a known token, so a change to how a
 * token is written would fail here rather than sign every link already in
 * an inbox out of existence.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LambderSignedClaims, constantTimeEquals, keyedDigest, randomSecret } from '../../src/index.js';

const SECRET = 'shop-secret';
const OTHER_SECRET = 'another-secret-entirely';
const NOW = 1_790_000_000_000;

const OrderClaimsSchema = z.object({ orderId: z.string(), exp: z.number().int() });
type OrderClaims = z.infer<typeof OrderClaimsSchema>;
const orderTokens = new LambderSignedClaims({ secret: SECRET, version: 't1', schema: OrderClaimsSchema, now: () => NOW });
const claims = (overrides: Partial<OrderClaims> = {}): OrderClaims => ({ orderId: 'order-1042', exp: Math.floor((NOW + 60_000) / 1000), ...overrides });

/** A token with one segment replaced by the base64url of `value`, the way a tamperer would edit it. */
const withSegment = (token: string, index: 0 | 1 | 2, value: string) => {
    const parts = token.split('.');
    parts[index] = value;
    return parts.join('.');
};
const base64Url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe('LambderSignedClaims', () => {
    it('writes the envelope it always has: version, base64url claims, base64url HMAC-SHA256', async () => {
        // A known token: the same secret, version and claims signed by an
        // earlier implementation of this envelope. Every token a deployed app
        // has handed out reads back only while this stays equal.
        expect(await orderTokens.sign({ orderId: 'order-1042', exp: 1_800_000_000 }))
            .toBe('t1.eyJvcmRlcklkIjoib3JkZXItMTA0MiIsImV4cCI6MTgwMDAwMDAwMH0.6rkrvquMDk8tROXJqjdH69iRYqqy4qvB3KGNv4dz5-o');
    });

    it('round-trips claims', async () => {
        const token = await orderTokens.sign(claims());
        expect(await orderTokens.verify(token)).toEqual(claims());
    });

    it('rejects a token signed under another secret, and one of another version', async () => {
        const otherSecret = new LambderSignedClaims({ secret: OTHER_SECRET, version: 't1', schema: OrderClaimsSchema, now: () => NOW });
        expect(await orderTokens.verify(await otherSecret.sign(claims()))).toBeNull();

        const otherVersion = new LambderSignedClaims({ secret: SECRET, version: 't2', schema: OrderClaimsSchema, now: () => NOW });
        expect(await orderTokens.verify(await otherVersion.sign(claims()))).toBeNull();
        expect(await orderTokens.verify(withSegment(await orderTokens.sign(claims()), 0, 't2'))).toBeNull();
    });

    it('rejects a change anywhere in the three segments', async () => {
        const token = await orderTokens.sign(claims());
        const [, body, mac] = token.split('.') as [string, string, string];
        const forged = { ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), orderId: 'order-9' };
        expect(await orderTokens.verify(withSegment(token, 1, base64Url(JSON.stringify(forged))))).toBeNull();
        expect(await orderTokens.verify(withSegment(token, 2, (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)))).toBeNull();
        expect(await orderTokens.verify(withSegment(token, 2, mac.slice(0, -1)))).toBeNull();
    });

    it('verifies the one spelling of a mac it writes, not the three others that decode to the same bytes', async () => {
        // A 32-byte mac is 43 characters, and the last one carries two bits
        // no byte uses: four characters spell the same final bits.
        const token = await orderTokens.sign(claims());
        const [, , mac] = token.split('.') as [string, string, string];
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const last = alphabet.indexOf(mac.at(-1)!);
        expect(last % 4).toBe(0);
        const spellings = [0, 1, 2, 3].map((spare) => mac.slice(0, -1) + alphabet[last + spare]);
        expect(spellings.map((spelling) => Buffer.from(spelling, 'base64url').equals(Buffer.from(mac, 'base64url')))).toEqual([true, true, true, true]);

        expect(await orderTokens.verify(withSegment(token, 2, spellings[0]!))).toEqual(claims());
        for(const spelling of spellings.slice(1)) expect(await orderTokens.verify(withSegment(token, 2, spelling))).toBeNull();
    });

    it('answers null, never throws, for malformed text', async () => {
        for(const bad of ['', 'junk', 't1', 't1.junk', 't1.junk.junk', 'a.b.c.d', 't1..', 't1.!!!.@@@', 't1.eyJ.6rkr', `t1.${base64Url('not json')}.${'A'.repeat(43)}`]){
            expect(await orderTokens.verify(bad), bad).toBeNull();
        }
    });

    it('rejects claims the schema refuses, at signing and at verifying', async () => {
        await expect(orderTokens.sign({ orderId: 42 as never, exp: 1 })).rejects.toThrow();
        const loose = new LambderSignedClaims({ secret: SECRET, version: 't1', schema: z.object({ orderId: z.unknown(), exp: z.number().optional() }) });
        expect(await orderTokens.verify(await loose.sign({ orderId: 42 }))).toBeNull();
    });

    it('judges exp, in epoch seconds, against its clock or the moment a call names', async () => {
        const expired = await orderTokens.sign(claims({ exp: Math.floor((NOW - 1_000) / 1000) }));
        expect(await orderTokens.verify(expired)).toBeNull();
        expect(await orderTokens.verify(expired, { now: NOW - 120_000 })).toEqual(await orderTokens.verify(await orderTokens.sign(claims({ exp: Math.floor((NOW - 1_000) / 1000) })), { now: NOW - 120_000 }));
        expect(await orderTokens.verify(expired, { now: NOW - 120_000 })).not.toBeNull();

        const live = await orderTokens.sign(claims());
        expect(await orderTokens.verify(live)).not.toBeNull();
        expect(await orderTokens.verify(live, { now: NOW + 3_600_000 })).toBeNull();
        // The expiry second itself is past.
        expect(await orderTokens.verify(live, { now: claims().exp * 1000 })).toBeNull();
        expect(await orderTokens.verify(live, { now: claims().exp * 1000 - 1 })).not.toBeNull();
    });

    it('lets a schema without exp declare a token that does not expire on its own', async () => {
        const links = new LambderSignedClaims({ secret: SECRET, version: 'l1', schema: z.object({ recipient: z.uuid(), issue: z.number().int() }), now: () => NOW });
        const token = await links.sign({ recipient: '9b2a1c4e-7d3f-4a51-8e6b-2f0c9d4a7b13', issue: 2 });
        expect(await links.verify(token, { now: NOW + 10 * 365 * 24 * 3_600_000 })).toEqual({ recipient: '9b2a1c4e-7d3f-4a51-8e6b-2f0c9d4a7b13', issue: 2 });
    });

    it('refuses a schema whose exp is not a number, at compile time', () => {
        // @ts-expect-error exp would be judged as an expiry and never be one.
        const wrong = new LambderSignedClaims({ secret: SECRET, version: 'x1', schema: z.object({ exp: z.string() }) });
        expect(wrong).toBeInstanceOf(LambderSignedClaims);
    });

    it('refuses a secret or a version it cannot sign with, at construction', () => {
        expect(() => new LambderSignedClaims({ secret: '', version: 't1', schema: OrderClaimsSchema })).toThrow(/needs a secret/);
        expect(() => new LambderSignedClaims({ secret: SECRET, version: 't.1', schema: OrderClaimsSchema })).toThrow(/without a dot/);
        expect(() => new LambderSignedClaims({ secret: SECRET, version: '', schema: OrderClaimsSchema })).toThrow(/without a dot/);
    });
});

describe('keyedDigest', () => {
    it('is deterministic, keyed, base64url, and never the plaintext', async () => {
        expect(await keyedDigest(SECRET, 'ABCDEFGH')).toBe('mtOZYPQKDgThbd1OG5kqlHJv_8rTzLH1Tu6dgGt_7xc');
        expect(await keyedDigest(SECRET, 'ABCDEFGH')).toBe(await keyedDigest(SECRET, 'ABCDEFGH'));
        expect(await keyedDigest(OTHER_SECRET, 'ABCDEFGH')).not.toBe(await keyedDigest(SECRET, 'ABCDEFGH'));
        expect(await keyedDigest(SECRET, 'ABCDEFGJ')).not.toBe(await keyedDigest(SECRET, 'ABCDEFGH'));
        expect(await keyedDigest(SECRET, 'ABCDEFGH')).not.toContain('ABCDEFGH');
        expect(await keyedDigest(SECRET, 'ABCDEFGH')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
});

describe('randomSecret', () => {
    it('mints distinct url-safe secrets of the size asked for', () => {
        const secrets = new Set(Array.from({ length: 500 }, () => randomSecret()));
        expect(secrets.size).toBe(500);
        for(const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(randomSecret(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });
});

describe('constantTimeEquals', () => {
    it('matches identical strings and nothing else', () => {
        expect(constantTimeEquals('abc', 'abc')).toBe(true);
        expect(constantTimeEquals('abc', 'abd')).toBe(false);
        expect(constantTimeEquals('abc', 'ab')).toBe(false);
        expect(constantTimeEquals('', '')).toBe(true);
    });
});

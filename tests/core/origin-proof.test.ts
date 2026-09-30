/**
 * The origin proof: the trusted forwarding headers are read only from a
 * request that carries the secret the proxy in front of the app sets, so a
 * request sent to the origin directly cannot pick its own address or host.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../../src/core/Lambder.js';
import { decodeBody, createMockContext, testPublicFiles } from '../helpers.js';
import { synthesizeLambdaHttpEvent } from '../../src/invoke/LambderLambdaEvent.js';

const SECRET = 'proxy-secret-0123456789abcdef-0123456789';
const PREVIOUS_SECRET = 'proxy-secret-previous-0123456789abcdef-01';

const createStore = () => new Lambder({
    files: testPublicFiles(),
    trustedClientIpHeaders: ['cf-connecting-ip'],
    trustedHostHeaders: ['x-forwarded-host'],
    originProof: { header: 'x-origin-proof', secrets: [SECRET, PREVIOUS_SECRET] },
}).addRoute({ path: '/whoami', method: 'GET' }, (ctx, res) => res.json({
    ip: ctx.ip,
    host: ctx.host,
    proofSeen: ctx.header('x-origin-proof') ?? Object.keys(ctx.headers).find((name) => name.toLowerCase() === 'x-origin-proof') ?? null,
}));

/** A request as the gateway delivers it: observed from 9.9.9.9, at the gateway's own host, with whatever headers it carried. */
const whoami = async (store: Lambder, headers: Record<string, string>) => {
    const event = synthesizeLambdaHttpEvent({ method: 'GET', path: '/whoami', host: 'origin.example', clientIp: '9.9.9.9', headers }, { invoke: false });
    return JSON.parse(decodeBody(await store.render(event, createMockContext())));
};

describe('Origin proof', () => {
    it('reads the trusted headers of a request that carries the proof', async () => {
        expect(await whoami(createStore(), { 'X-Origin-Proof': SECRET, 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-host': 'shop.example' }))
            .toEqual({ ip: '1.2.3.4', host: 'shop.example', proofSeen: null });
    });

    it('takes the previous secret too, so a rotation drops no request', async () => {
        expect(await whoami(createStore(), { 'x-origin-proof': PREVIOUS_SECRET, 'cf-connecting-ip': '1.2.3.4' })).toMatchObject({ ip: '1.2.3.4' });
    });

    it('reads the gateway\'s own address and host from a request without it, or with a wrong one', async () => {
        // Sent to the origin directly, a request's forwarding headers are
        // whatever its sender wrote: a fresh address per request would be a
        // fresh `per: "ip"` budget per request.
        for(const proof of [undefined, 'guess', SECRET.slice(0, -1)]){
            const headers: Record<string, string> = { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-host': 'shop.example', ...(proof ? { 'x-origin-proof': proof } : {}) };
            expect(await whoami(createStore(), headers)).toEqual({ ip: '9.9.9.9', host: 'origin.example', proofSeen: null });
        }
    });

    it('refuses a proof that proves nothing, at compile time where it can and at creation', () => {
        const files = testPublicFiles();
        expect(() => new Lambder({ files, trustedClientIpHeaders: ['cf-connecting-ip'], originProof: { header: 'x-origin-proof', secrets: ['short'] } }))
            .toThrow(/at least 32 characters/);
        expect(() => new Lambder({ files, trustedClientIpHeaders: ['cf-connecting-ip'], originProof: { header: 'x-origin-proof', secrets: [] } }))
            .toThrow(/originProof\.secrets must list the secret/);
        expect(() => new Lambder({ files, originProof: { header: 'x-origin-proof', secrets: [SECRET] } }))
            .toThrow(/this instance trusts none/);
        expect(() => new Lambder({ files, trustedClientIpHeaders: ['x-origin-proof'], originProof: { header: 'X-Origin-Proof', secrets: [SECRET] } }))
            .toThrow(/is also a trusted header/);
        expect(() => new Lambder({ files, trustedClientIpHeaders: ['cf-connecting-ip'], originProof: { header: 'x origin proof', secrets: [SECRET] } }))
            .toThrow(/must be a header name/);
    });
});

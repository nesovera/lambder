/**
 * The origin proof: the trusted forwarding headers are read only from a
 * request that carries the secret the proxy in front of the app sets, so a
 * request sent to the origin directly cannot pick its own address or host,
 * nor any other header only the proxy writes; ctx.arrivedVia says which way
 * a request came.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import Lambder from '../../src/core/Lambder.js';
import { createContext, type LambderRenderContext, type LambderRequestArrival } from '../../src/core/LambderContext.js';
import { decodeBody, createMockContext, createMockEvent, testPublicFiles } from '../helpers.js';
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
        expect(() => new Lambder({ files, trustedClientIpHeaders: ['x-origin-proof'], originProof: { header: 'X-Origin-Proof', secrets: [SECRET] } }))
            .toThrow(/is also a trusted or proxy header/);
        expect(() => new Lambder({ files, originProof: { header: 'x-origin-proof', secrets: [SECRET], proxyHeaders: ['X-Origin-Proof'] } }))
            .toThrow(/is also a trusted or proxy header/);
        expect(() => new Lambder({ files, trustedClientIpHeaders: ['cf-connecting-ip'], originProof: { header: 'x origin proof', secrets: [SECRET] } }))
            .toThrow(/must be a header name/);
        expect(() => new Lambder({ files, originProof: { header: 'x-origin-proof', secrets: [SECRET], proxyHeaders: ['cf ipcountry'] } }))
            .toThrow(/originProof\.proxyHeaders must list header names/);
        expect(() => new Lambder({ files, originProof: { header: 'x-origin-proof', secrets: [SECRET], proxyHeaders: 'cf-ipcountry' as any } }))
            .toThrow(/originProof\.proxyHeaders must list header names/);
        // @ts-expect-error a misspelled key is caught like every other option's
        expect(() => new Lambder({ files, originProof: { header: 'x-origin-proof', secrets: [SECRET], proxyHeader: ['cf-ipcountry'] } })).not.toThrow();
    });

    it('takes a proof with no trusted header to guard, since arrivedVia is worth having alone', async () => {
        const store = new Lambder({ files: testPublicFiles(), originProof: { header: 'x-origin-proof', secrets: [SECRET] } })
            .addRoute({ path: '/whoami', method: 'GET' }, (ctx, res) => res.json({ arrivedVia: ctx.arrivedVia }));
        expect(await whoami(store, { 'x-origin-proof': SECRET })).toEqual({ arrivedVia: 'proxy' });
        expect(await whoami(store, {})).toEqual({ arrivedVia: 'direct' });
    });
});

/** An instance behind a proxy that writes the viewer's address, host and country, with what a route reads of a request's headers. */
const createProxiedStore = (originProof: { header: string; secrets: string[]; proxyHeaders?: string[] } | null) => new Lambder({
    files: testPublicFiles(),
    trustedClientIpHeaders: ['cf-connecting-ip'],
    trustedHostHeaders: ['x-forwarded-host'],
    ...(originProof ? { originProof } : {}),
}).addRoute({ path: '/whoami', method: 'GET' }, (ctx, res) => res.json({
    arrivedVia: ctx.arrivedVia,
    read: Object.fromEntries(['cf-connecting-ip', 'x-forwarded-host', 'cf-ipcountry', 'accept-language'].map((name) => [name, ctx.header(name) ?? null])),
    // Beside the two the event builder writes on every request.
    listed: Object.keys(ctx.headers).map((name) => name.toLowerCase()).filter((name) => name !== 'host' && name !== 'accept-encoding').sort(),
}));

/** What the proxy writes, and one header the viewer's browser does. */
const PROXY_WRITTEN = { 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-Host': 'shop.example', 'CF-IPCountry': 'US' };
const VIEWER_WRITTEN = { 'Accept-Language': 'en-US' };

describe('The proxy\'s headers on a request without the proof', () => {
    const originProof = { header: 'x-origin-proof', secrets: [SECRET], proxyHeaders: ['CF-IPCountry'] };

    it('keeps every header of a request that carries the proof', async () => {
        expect(await whoami(createProxiedStore(originProof), { 'x-origin-proof': SECRET, ...PROXY_WRITTEN, ...VIEWER_WRITTEN })).toEqual({
            arrivedVia: 'proxy',
            read: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-host': 'shop.example', 'cf-ipcountry': 'US', 'accept-language': 'en-US' },
            listed: ['accept-language', 'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-host'],
        });
    });

    it('takes the trusted headers and the proxy headers off one without it, and leaves the rest', async () => {
        // A sender that reached the gateway directly wrote these itself: a
        // handler that reads a country from it reads the sender's claim.
        for(const proof of [undefined, 'guess']){
            expect(await whoami(createProxiedStore(originProof), { ...(proof ? { 'x-origin-proof': proof } : {}), ...PROXY_WRITTEN, ...VIEWER_WRITTEN })).toEqual({
                arrivedVia: 'direct',
                read: { 'cf-connecting-ip': null, 'x-forwarded-host': null, 'cf-ipcountry': null, 'accept-language': 'en-US' },
                listed: ['accept-language'],
            });
        }
    });

    it('takes them off the API request\'s headers too', () => {
        const event = synthesizeLambdaHttpEvent({
            method: 'POST', path: '/api/orders/place', host: 'origin.example', body: '{"payload":{}}',
            headers: { 'content-type': 'application/json', ...PROXY_WRITTEN },
        }, { invoke: false });
        const ctx = createContext(event, createMockContext(), {
            trustedClientIpHeaders: ['cf-connecting-ip'], trustedHostHeaders: ['x-forwarded-host'], originProof,
        });
        expect(ctx.api?.apiName).toBe('orders.place');
        expect(Object.keys(ctx.api!.headers).sort()).toEqual(['accept-encoding', 'content-type', 'host']);
    });

    it('leaves every header of every request alone with no origin proof, as unverified', async () => {
        expect(await whoami(createProxiedStore(null), { ...PROXY_WRITTEN, ...VIEWER_WRITTEN })).toEqual({
            arrivedVia: 'unverified',
            read: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-host': 'shop.example', 'cf-ipcountry': 'US', 'accept-language': 'en-US' },
            listed: ['accept-language', 'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-host'],
        });
    });
});

describe('ctx.arrivedVia', () => {
    /** The same request, delivered by a gateway or by a Lambda invoke. */
    const deliver = async (store: Lambder, headers: Record<string, string>, invoke: boolean) => {
        const event = synthesizeLambdaHttpEvent({ method: 'GET', path: '/whoami', host: 'origin.example', clientIp: '9.9.9.9', headers }, { invoke });
        return JSON.parse(decodeBody(await store.render(event, createMockContext())));
    };

    it('says "invoke" for an invoke, told by the apiId, whatever proof it carries or lacks', async () => {
        const originProof = { header: 'x-origin-proof', secrets: [SECRET], proxyHeaders: ['cf-ipcountry'] };
        expect(await deliver(createProxiedStore(null), PROXY_WRITTEN, true)).toMatchObject({ arrivedVia: 'invoke' });
        // Without the proof, what it forwards under the proxy's names is not the proxy's.
        expect(await deliver(createProxiedStore(originProof), PROXY_WRITTEN, true))
            .toMatchObject({ arrivedVia: 'invoke', read: { 'cf-connecting-ip': null, 'cf-ipcountry': null } });
        // Beside a proof its caller forwarded, they are; ctx.ip still reads no header on an invoke.
        expect(await deliver(createProxiedStore(originProof), { 'x-origin-proof': SECRET, ...PROXY_WRITTEN }, true))
            .toMatchObject({ arrivedVia: 'invoke', read: { 'cf-connecting-ip': '1.2.3.4', 'cf-ipcountry': 'US' } });
    });

    it('is never "invoke" for an HTTP request that sends the invoke marker', async () => {
        // A gateway's own event: its apiId is the gateway's, and the marker an ordinary header.
        const event = createMockEvent('/whoami', {
            headers: { Host: 'origin.example', 'X-Lambder-Invoke': '1' },
            requestContext: { apiId: 'a1b2c3d4e5', identity: { sourceIp: '9.9.9.9' } } as any,
        });
        const answer = JSON.parse(decodeBody(await createProxiedStore(null).render(event, createMockContext())));
        expect(answer).toMatchObject({ arrivedVia: 'unverified' });
    });

    it('is typed as the four arrivals and read-only', () => {
        expectTypeOf<LambderRenderContext['arrivedVia']>().toEqualTypeOf<LambderRequestArrival>();
        expectTypeOf<LambderRequestArrival>().toEqualTypeOf<'proxy' | 'direct' | 'invoke' | 'unverified'>();
        const ctx = createContext(synthesizeLambdaHttpEvent({ method: 'GET', path: '/', host: 'origin.example' }, { invoke: false }), createMockContext());
        // @ts-expect-error the arrival is read from the event, not written
        ctx.arrivedVia = 'proxy';
    });
});

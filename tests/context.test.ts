/**
 * Render context additions: rawBody, case-insensitive header(), client ip.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import { decodeBody, createMockEvent, createMockContext, testPublicFiles } from './helpers.js';
import { synthesizeLambdaHttpEvent } from '../src/invoke/LambderLambdaEvent.js';
/** What a real v1 event carries: the address the gateway observed. */
const gatewayIdentity = { identity: { sourceIp: '9.9.9.9' } } as any;

describe('Context additions', () => {
    it('exposes rawBody, case-insensitive header(), and ip', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({
                rawBody: ctx.rawBody,
                contentType: ctx.header('content-type'),
                ip: ctx.ip,
            }));

        const result = await lambder.render(
            createMockEvent('/echo', {
                httpMethod: 'POST',
                body: '{"a":1}',
                headers: { Host: 'localhost', 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
                requestContext: gatewayIdentity,
            }),
            createMockContext(),
        );
        const body = JSON.parse(decodeBody(result));
        expect(body.rawBody).toBe('{"a":1}');
        expect(body.contentType).toBe('application/json');
        // The gateway's own sourceIp, NOT the CF-Connecting-IP header the
        // request carried: a header is whatever the client wrote until
        // something in front of the app overwrites it, and ctx.ip is what
        // `per: "ip"` rate limits key off, so a caller that can choose it can
        // give itself a fresh budget per request.
        expect(body.ip).toBe('9.9.9.9');
    });

    it('reads the client address from a header only when the app says it trusts one', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            trustedClientIpHeaders: ['cf-connecting-ip'],
        }).addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({ ip: ctx.ip }));

        const result = await lambder.render(
            createMockEvent('/echo', {
                httpMethod: 'POST',
                body: '{}',
                headers: { Host: 'localhost', 'CF-Connecting-IP': '1.2.3.4' },
                requestContext: gatewayIdentity,
            }),
            createMockContext(),
        );

        expect(JSON.parse(decodeBody(result)).ip).toBe('1.2.3.4');
    });

    it('reads the host from a trusted forwarding header, the way a Function URL behind CloudFront needs', async () => {
        const app = (trustedHostHeaders?: string[]) => new Lambder({ files: testPublicFiles(), trustedHostHeaders })
            .addRoute('/host', (ctx, res) => res.json({ host: ctx.host }));
        const call = async (lambder: Lambder, headers: Record<string, string>) => JSON.parse(decodeBody(await lambder.render(
            createMockEvent('/host', { headers: { Host: 'abc123.lambda-url.us-east-1.on.aws', ...headers }, requestContext: gatewayIdentity }),
            createMockContext(),
        ))).host;

        // Nothing trusted by default: a header a client can set is a host a client picks.
        expect(await call(app(), { 'X-Forwarded-Host': 'shop.example.com' })).toBe('abc123.lambda-url.us-east-1.on.aws');
        expect(await call(app(['x-forwarded-host']), { 'X-Forwarded-Host': 'shop.example.com, cdn.internal' })).toBe('shop.example.com');
        expect(await call(app(['x-forwarded-host']), { 'X-Forwarded-Host': 'shop.example.com:8443' })).toBe('shop.example.com:8443');
        // A value that is not a host is not taken as one.
        expect(await call(app(['x-forwarded-host']), { 'X-Forwarded-Host': 'evil.example/path' })).toBe('abc123.lambda-url.us-east-1.on.aws');
        expect(await call(app(['x-forwarded-host']), {})).toBe('abc123.lambda-url.us-east-1.on.aws');
    });

    it('takes the leftmost entry of a trusted forwarding header, and falls back when it is empty', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            trustedClientIpHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
        }).addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({ ip: ctx.ip }));

        const call = (headers: Record<string, string>) => lambder.render(
            createMockEvent('/echo', { httpMethod: 'POST', body: '{}', headers: { Host: 'localhost', ...headers }, requestContext: gatewayIdentity }),
            createMockContext(),
        );

        // First trusted header that carries anything wins, leftmost entry.
        expect(JSON.parse(decodeBody(await call({ 'X-Forwarded-For': '5.5.5.5, 6.6.6.6' }))).ip).toBe('5.5.5.5');
        // Nothing trusted arrived, so the gateway's address stands.
        expect(JSON.parse(decodeBody(await call({}))).ip).toBe('9.9.9.9');
    });

    it('does not trust a forwarding header because the request claims to be an invoke', async () => {
        // x-lambder-invoke is an ordinary request header, and a gateway passes
        // custom x- headers through untouched while APPENDING to
        // x-forwarded-for. Honouring the marker would hand every HTTP caller
        // the leftmost entry, the very hole trustedClientIpHeaders exists to
        // close.
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({ ip: ctx.ip }));

        const result = await lambder.render(
            createMockEvent('/echo', {
                httpMethod: 'POST',
                body: '{}',
                headers: {
                    Host: 'localhost',
                    'X-Lambder-Invoke': '1',
                    'X-Forwarded-For': '6.6.6.6',
                },
                requestContext: gatewayIdentity,
            }),
            createMockContext(),
        );

        expect(JSON.parse(decodeBody(result)).ip).toBe('9.9.9.9');
    });

    it('tells an invoke by the apiId a gateway writes, never by the marker a client can send', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            trustedClientIpHeaders: ['cf-connecting-ip'],
            trustedHostHeaders: ['x-forwarded-host'],
        }).addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({ ip: ctx.ip, host: ctx.host }));
        const forwarded = { 'CF-Connecting-IP': '6.6.6.6', 'X-Forwarded-Host': 'evil.example' };
        const echo = async (event: Parameters<typeof lambder.render>[0]) =>
            JSON.parse(decodeBody(await lambder.render(event, createMockContext())));

        // A genuine invoke: the invoker's clientIp and host, whatever it forwarded.
        const invoke = synthesizeLambdaHttpEvent(
            { method: 'POST', path: '/echo', host: 'shop.internal', body: '{}', clientIp: '1.2.3.4', headers: forwarded },
            { invoke: true },
        );
        expect(await echo(invoke)).toEqual({ ip: '1.2.3.4', host: 'shop.internal' });

        // A gateway request wearing the marker is read as the gateway request
        // it is: the headers the app trusts still name the address and host.
        const markerOnly = createMockEvent('/echo', {
            httpMethod: 'POST',
            body: '{}',
            headers: { Host: 'abc.lambda-url.us-east-1.on.aws', 'X-Lambder-Invoke': '1', ...forwarded },
            requestContext: { ...gatewayIdentity, apiId: 'abcdefghij' },
        });
        expect(await echo(markerOnly)).toEqual({ ip: '6.6.6.6', host: 'evil.example' });
    });

    it('gives one address one rate-limit key, whatever spelling a proxy forwarded', async () => {
        // A proxy may forward the RFC 7239 bracket-and-port form or a plain
        // host:port, and IPv6 has several spellings per address. Each variant
        // reaching ctx.ip untouched would be its own counter.
        const lambder = new Lambder({
            files: testPublicFiles(),
            trustedClientIpHeaders: ['x-forwarded-for'],
        }).addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({ ip: ctx.ip }));

        const call = (forwarded: string) => lambder.render(
            createMockEvent('/echo', {
                httpMethod: 'POST',
                body: '{}',
                headers: { Host: 'localhost', 'X-Forwarded-For': forwarded },
                requestContext: gatewayIdentity,
            }),
            createMockContext(),
        );
        const ipOf = async (forwarded: string) => JSON.parse(decodeBody(await call(forwarded))).ip;

        expect(await ipOf('[2001:db8::1]:443')).toBe('2001:db8::1');
        expect(await ipOf('2001:DB8::1')).toBe('2001:db8::1');
        expect(await ipOf('1.2.3.4:5678')).toBe('1.2.3.4');
        expect(await ipOf('1.2.3.4')).toBe('1.2.3.4');
        // Not an address at any length; kept bounded rather than used as a key.
        expect((await ipOf('A'.repeat(500))).length).toBe(45);
    });

    it('reads a cookie named for an Object.prototype member as data, not as a crash', async () => {
        // On a plain-object cookie map, `__proto__=x` would resolve to
        // Object.prototype on the read, skip the `??=`, and fail on `.push`:
        // every route, API and file would answer 500, and a sibling subdomain
        // could plant the cookie at a parent domain for good, since nothing on
        // the 500 path clears cookies.
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/echo', method: 'GET' }, (ctx, res) => res.json({
                cookie: ctx.cookie,
                cookieList: ctx.cookieList,
                own: Object.prototype.hasOwnProperty.call(ctx.cookieList, '__proto__'),
            }));

        for(const name of ['__proto__', 'constructor', 'toString', 'valueOf']){
            const v1 = await lambder.render(
                createMockEvent('/echo', { headers: { Host: 'localhost', Cookie: `${name}=x; a=b` } }),
                createMockContext(),
            );
            expect(v1.statusCode).toBe(200);
            const body = JSON.parse(decodeBody(v1));
            expect(body.cookieList[name]).toEqual(['x']);
            expect(body.cookieList.a).toEqual(['b']);
            expect(body.cookie[name]).toBe('x');
        }
        expect(JSON.parse(decodeBody(await lambder.render(
            createMockEvent('/echo', { headers: { Host: 'localhost', Cookie: '__proto__=x' } }),
            createMockContext(),
        ))).own).toBe(true);
        // The v2 shape delivers the pairs pre-split; the same reading applies.
        const v2 = await lambder.render({
            version: '2.0', routeKey: '$default', rawPath: '/echo', rawQueryString: '',
            headers: { host: 'localhost' }, cookies: ['__proto__=x', 'a=b'],
            requestContext: { http: { method: 'GET', path: '/echo', sourceIp: '1.2.3.4' } },
            isBase64Encoded: false,
        } as any, createMockContext());
        expect(v2.statusCode).toBe(200);
        const v2List = JSON.parse(decodeBody(v2)).cookieList;
        expect(v2List['__proto__']).toEqual(['x']);
        expect(v2List.a).toEqual(['b']);
    });

    it('reads every Cookie header a v1 event carried, not only the last one', async () => {
        // A REST API puts a repeated header's values in multiValueHeaders and
        // only the LAST one in headers, and HTTP/2 lets a client split its
        // cookies across several Cookie headers. Reading the single header
        // alone would drop candidate sessions the session layer weighs, which
        // v2's event.cookies carries in full.
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/echo', method: 'GET' }, (ctx, res) => res.json({ cookie: ctx.cookie, cookieList: ctx.cookieList }));

        const split = await lambder.render(
            createMockEvent('/echo', {
                headers: { Host: 'localhost', Cookie: 'b=2' },
                multiValueHeaders: { Cookie: ['a=1', 'b=2'] },
            }),
            createMockContext(),
        );
        expect(JSON.parse(decodeBody(split)).cookie).toEqual({ a: '1', b: '2' });

        // Both copies of one name survive, which is what the session scan reads.
        const repeated = await lambder.render(
            createMockEvent('/echo', {
                headers: { Host: 'localhost', Cookie: 'sid=second' },
                multiValueHeaders: { Cookie: ['sid=first', 'sid=second'] },
            }),
            createMockContext(),
        );
        expect(JSON.parse(decodeBody(repeated)).cookieList.sid).toEqual(['first', 'second']);

        // An event with no multiValueHeaders still reads the single header.
        const single = await lambder.render(
            createMockEvent('/echo', { headers: { Host: 'localhost', Cookie: 'a=1; b=2' } }),
            createMockContext(),
        );
        expect(JSON.parse(decodeBody(single)).cookie).toEqual({ a: '1', b: '2' });
    });

    it('reads a header named for an Object.prototype member as data too', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/echo', method: 'GET' }, (ctx, res) => res.json({ proto: ctx.header('__proto__') ?? null, ctor: ctx.header('constructor') ?? null }));
        const result = await lambder.render(
            // JSON.parse, because an object literal with a __proto__ key sets the prototype rather than a key.
            createMockEvent('/echo', { headers: JSON.parse('{"Host":"localhost","__proto__":"x","constructor":"y"}') }),
            createMockContext(),
        );
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(decodeBody(result))).toEqual({ proto: 'x', ctor: 'y' });
    });
});

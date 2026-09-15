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
        // x-forwarded-for. Honouring the marker would therefore hand every
        // HTTP caller the leftmost entry again, which is the whole hole
        // trustedClientIpHeaders exists to close. A real invoke does not need
        // the exemption: its synthesized event carries the end user's address
        // in requestContext.http.sourceIp.
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

    it('carries a genuine invoke\'s client address through, with the marker trusted for nothing', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({ ip: ctx.ip }));

        const event = synthesizeLambdaHttpEvent(
            { method: 'POST', path: '/echo', host: 'localhost', body: '{}', clientIp: '1.2.3.4' },
            { invoke: true },
        );

        const result = await lambder.render(event as any, createMockContext());
        expect(JSON.parse(decodeBody(result)).ip).toBe('1.2.3.4');
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
        // The cookie map used to be a plain object, so `__proto__=x` resolved
        // to Object.prototype on the read, the `??=` skipped, and `.push` was
        // not a function: every route, API and file answered 500, and a
        // sibling subdomain could plant the cookie at a parent domain for
        // good, since nothing on the 500 path clears cookies.
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
        // alone dropped candidate sessions the session layer weighs; v2's
        // event.cookies already carried them all.
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

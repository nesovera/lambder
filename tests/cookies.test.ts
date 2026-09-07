/**
 * Cookies: every copy of a cookie name is kept on ctx.cookieList (a name
 * held at several scopes arrives several times), res.setCookie /
 * res.clearCookie serialize Set-Cookie headers, and the session controller
 * tolerates a stale copy of the session cookie shadowing the live one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import nodeCrypto from 'crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { z } from 'zod';
import Lambder from '../src/core/Lambder.js';
import { LambderLocalFileSource } from '../src/core/LambderFiles.js';
import { createContext } from '../src/core/LambderContext.js';
import { serializeCookie, serializeClearCookie, resolveCookieDomain } from '../src/core/LambderCookie.js';
import LambderSessionManager from '../src/session/LambderSessionManager.js';
import LambderSessionController from '../src/session/LambderSessionController.js';
import { decodeBody, createMockEvent, createMockContext } from './helpers.js';

const hashTok = (value: string) => nodeCrypto.createHash('sha256').update(value).digest('hex');

describe('ctx.cookieList', () => {
    it('keeps every value of a repeated cookie name (v1 header); ctx.cookie holds the first', () => {
        const ctx = createContext(createMockEvent('/', {
            headers: { Host: 'localhost', Cookie: 'sid=old; theme=dark; sid=new' },
        }), createMockContext(), '/api');

        expect(ctx.cookieList).toEqual({ sid: ['old', 'new'], theme: ['dark'] });
        expect(ctx.cookie).toEqual({ sid: 'old', theme: 'dark' });
    });

    it('keeps every value of a repeated cookie name (v2 cookies array)', () => {
        const event: APIGatewayProxyEventV2 = {
            version: '2.0', routeKey: '$default', rawPath: '/', rawQueryString: '',
            headers: { host: 'localhost' },
            cookies: ['sid=old', 'sid=new'],
            requestContext: {
                accountId: '1', apiId: 'api', domainName: 'localhost', domainPrefix: '',
                http: { method: 'GET', path: '/', protocol: 'HTTP/1.1', sourceIp: '9.9.9.9', userAgent: 'test' },
                requestId: 'r', routeKey: '$default', stage: '$default', time: '', timeEpoch: 0,
            },
            isBase64Encoded: false,
        };
        const ctx = createContext(event, createMockContext(), '/api');

        expect(ctx.cookieList).toEqual({ sid: ['old', 'new'] });
        expect(ctx.cookie.sid).toBe('old');
    });

    it('decodes values and skips malformed pairs like the flat map', () => {
        const ctx = createContext(createMockEvent('/', {
            headers: { Host: 'localhost', Cookie: 'a=x%3Ay; junk; b=' },
        }), createMockContext(), '/api');

        expect(ctx.cookieList).toEqual({ a: ['x:y'], b: [''] });
        expect(ctx.cookie).toEqual({ a: 'x:y', b: '' });
    });
});

describe('serializeCookie', () => {
    it('applies the defaults: Path=/, SameSite=Lax, Secure, not HttpOnly, session lifetime', () => {
        expect(serializeCookie('a', 'b')).toBe('a=b; Path=/; Secure; SameSite=Lax');
    });

    it('serializes every attribute and encodes the value', () => {
        const value = serializeCookie('t', 'x:y', {
            domain: '.example.com', path: '/app', sameSite: 'Strict', secure: false, httpOnly: true,
            maxAge: 60, expires: new Date(0),
        });
        expect(value).toBe('t=x%3Ay; Max-Age=60; Domain=.example.com; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict');
    });

    it('resolves a function-form domain against the hostname without the port', () => {
        const domain = (hostname: string) => hostname.endsWith('.example.com') ? '.example.com' : undefined;
        expect(resolveCookieDomain(domain, 'app.example.com:8443')).toBe('.example.com');
        expect(resolveCookieDomain(domain, 'localhost:3000')).toBeUndefined();
        expect(resolveCookieDomain(domain)).toBeUndefined();
        expect(serializeCookie('a', 'b', { domain }, 'app.example.com')).toContain('Domain=.example.com');
        expect(serializeCookie('a', 'b', { domain }, 'localhost')).not.toContain('Domain=');
    });

    it('rejects a value the cookie grammar forbids instead of emitting a broken header', () => {
        expect(() => serializeCookie('a', 'x;y', { encode: (v) => v })).toThrow();
    });

    it('serializeClearCookie deletes under the given scope', () => {
        expect(serializeClearCookie('a', { domain: '.example.com', path: '/app' }))
            .toBe('a=; Max-Age=0; Domain=.example.com; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax');
    });
});

describe('res.setCookie / res.clearCookie', () => {
    it('emit Set-Cookie headers, resolving a function-form domain against the request host', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
            .addRoute('/set', (ctx, res) => {
                res.setCookie('pref', 'dark', { domain: (hostname) => `.${hostname}`, maxAge: 3600 });
                res.clearCookie('legacy', { httpOnly: true });
                return res.html('ok');
            });

        const result = await lambder.render(
            createMockEvent('/set', { headers: { Host: 'example.com:8443' } }),
            createMockContext(),
        );

        expect(decodeBody(result)).toBe('ok');
        expect(result.multiValueHeaders?.['Set-Cookie']).toEqual([
            'pref=dark; Max-Age=3600; Domain=.example.com; Path=/; Secure; SameSite=Lax',
            'legacy=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
        ]);
    });

    it('work from an afterRender hook (the accumulators apply after the hooks)', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
            .addRoute('/x', (ctx, res) => res.html('ok'))
            .addHook('afterRender', async (ctx, res, response) => {
                res.setCookie('seen', '1', { secure: false });
                return response;
            });

        const result = await lambder.render(createMockEvent('/x'), createMockContext());

        expect(result.multiValueHeaders?.['Set-Cookie']).toEqual(['seen=1; Path=/; SameSite=Lax']);
    });
});

describe('Session cookies at several scopes', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    const nowSec = () => Math.floor(Date.now() / 1000);

    const liveSession = () => ({
        pk: 'hash',
        sk: hashTok('live'),
        csrfTokenHash: hashTok('csrf-token'),
        sessionKey: 'user-123',
        data: { role: 'user' },
        createdAt: nowSec(),
        expiresAt: nowSec() + 3600,
        lastAccessedAt: nowSec(),
        ttlInSeconds: 3600,
    });

    const makeCtx = (tokens: string[], host = 'app.example.com'): any => ({
        host, path: '/api', pathParams: {}, method: 'POST',
        get: {}, post: { token: 'csrf-token' },
        cookie: tokens[0] ? { sid: tokens[0] } : {},
        cookieList: tokens.length ? { sid: tokens } : {},
        session: null, apiName: 'test.api', apiPayload: {},
        headers: {}, rawBody: '', ip: '', header: () => undefined,
        event: {} as any, lambdaContext: {} as any,
        _otherInternal: {
            isApiCall: true, requestVersion: '1.0', eventFormat: 'v1' as const,
            setHeaderFnAccumulator: [], addHeaderFnAccumulator: [], logToApiResponseAccumulator: [],
        },
    });

    const makeController = (tokens: string[], domain?: string | ((hostname: string) => string | undefined)) => {
        const ctx = makeCtx(tokens);
        const controller = new LambderSessionController({
            lambderSessionManager: new LambderSessionManager({
                tableName: 'test-sessions', tableRegion: 'us-east-1',
                partitionKey: 'pk', sortKey: 'sk', sessionSalt: 'test-salt-12345',
            }),
            sessionTokenCookieKey: 'sid',
            sessionCsrfCookieKey: 'csid',
            cookieOptions: { domain },
            ctx,
        });
        return { controller, ctx };
    };

    const setCookies = (ctx: any): string[] =>
        ctx._otherInternal.addHeaderFnAccumulator.filter((h: any) => h.key === 'Set-Cookie').map((h: any) => h.value);

    beforeEach(() => {
        ddbMock.reset();
        // Only the live secret's hash finds a record; every other token is a miss.
        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(GetCommand, { Key: { pk: 'hash', sk: hashTok('live') } }).resolves({ Item: liveSession() });
        ddbMock.on(PutCommand).resolves({});
    });

    it('writes the session cookies under the configured domain, with the tokens unencoded', async () => {
        const { controller, ctx } = makeController([], (hostname) => hostname.endsWith('.example.com') ? '.example.com' : undefined);

        await controller.createSession('user-123', { role: 'user' });

        const cookies = setCookies(ctx);
        expect(cookies.length).toBe(2);
        expect(cookies[0]).toMatch(/^sid=[0-9a-f]+:[0-9a-f]+; Domain=\.example\.com; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Lax$/);
        expect(cookies[1]).toMatch(/^csid=[0-9a-f]+; Domain=\.example\.com; Path=\/; Expires=.*; Secure; SameSite=Lax$/);
    });

    it('finds the live session behind a stale copy that arrived first, and evicts the host-only twin', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController(['hash:stale', 'hash:live'], '.example.com');

        const session = await controller.fetchSession();

        expect(session.sessionKey).toBe('user-123');
        expect(ctx.session).toBe(session);
        expect(ddbMock.commandCalls(GetCommand).length).toBe(2);
        expect(setCookies(ctx)).toEqual([
            'sid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
            'csid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain('2 "sid" cookies');
        warn.mockRestore();
    });

    it('does not evict when no domain is configured: the other copy is at a parent domain this host cannot name', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController(['hash:stale', 'hash:live']);

        await controller.fetchSession();

        expect(setCookies(ctx)).toEqual([]);
        vi.restoreAllMocks();
    });

    it('skips a copy whose CSRF pairing fails even though its record exists', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // A planted or stale copy with a live record but a CSRF hash that does not match the posted token.
        ddbMock.on(GetCommand, { Key: { pk: 'hash', sk: hashTok('foreign') } }).resolves({ Item: { ...liveSession(), sk: hashTok('foreign'), csrfTokenHash: hashTok('other-csrf') } });
        const { controller } = makeController(['hash:foreign', 'hash:live'], '.example.com');

        const session = await controller.fetchSession();

        expect(session.sk).toBe(hashTok('live'));
        vi.restoreAllMocks();
    });

    it('reports no session when no copy is live, without evicting anything', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController(['hash:stale', 'hash:older'], '.example.com');

        expect(await controller.fetchSessionIfExists()).toBeNull();
        expect(setCookies(ctx)).toEqual([]);
        vi.restoreAllMocks();
    });

    it('a single cookie takes the plain path: one read, no eviction, no warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController(['hash:live'], '.example.com');

        await controller.fetchSession();

        expect(ddbMock.commandCalls(GetCommand).length).toBe(1);
        expect(setCookies(ctx)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('end-to-end: a shadowed session API call succeeds and the response evicts the host-only copy', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const lambder = new Lambder({
            files: new LambderLocalFileSource({ root: './public' }),
            apiPath: '/api',
            session: {
                tableName: 'test-sessions', tableRegion: 'us-east-1', sessionSalt: 'test-salt-12345',
                tokenCookieKey: 'sid', csrfCookieKey: 'csid',
                cookie: { domain: '.example.com' },
            },
        }).addSessionApi('whoami', { input: z.any(), output: z.any() }, async (ctx, res) => res.api({ key: ctx.session.sessionKey }));

        const result = await lambder.render(createMockEvent('/api', {
            httpMethod: 'POST',
            headers: { Host: 'app.example.com', Cookie: 'sid=hash:stale; sid=hash:live' },
            body: JSON.stringify({ apiName: 'whoami', payload: {}, token: 'csrf-token' }),
        }), createMockContext());

        expect(JSON.parse(decodeBody(result)).payload).toEqual({ key: 'user-123' });
        expect(result.multiValueHeaders?.['Set-Cookie']).toEqual([
            'sid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
            'csid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
        ]);
        vi.restoreAllMocks();
    });
});

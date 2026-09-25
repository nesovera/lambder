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
import { createContext } from '../src/core/LambderContext.js';
import { serializeCookie, serializeClearCookie, resolveCookieDomain } from '../src/shared/wire/LambderCookie.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import LambderSessionManager, { LambderSessionReadError } from '../src/session/LambderSessionManager.js';
import LambderSessionController from '../src/session/LambderSessionController.js';
import type { LambderSessionStore } from '../src/shared/contracts/LambderSessionStore.js';
import { LambderDdbSessionStore } from '../src/stores/LambderDdbSessionStore.js';
import { LambderAnswerHeaders } from '../src/shared/wire/LambderAnswerHeaders.js';
import { decodeBody, createMockEvent, createMockContext, testPublicFiles } from './helpers.js';

const hashTok = (value: string) => nodeCrypto.createHash('sha256').update(value).digest('hex');

describe('Prefixed session cookie names', () => {
    const create = (session: Record<string, any>) => () => new Lambder({
        files: testPublicFiles(),
        apiPath: '/api',
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt', ...session },
    });

    it('rejects the prefix beside anything a browser would silently drop it for', () => {
        // The prefix is the real defence against a sibling subdomain planting a
        // session cookie, and it fails silently: a browser handed __Host- with
        // a Domain just discards the cookie, and the app looks like it has no
        // sessions rather than like it is misconfigured.
        const keys = { tokenCookieKey: '__Host-TK', csrfCookieKey: '__Host-CS' };
        expect(create({ ...keys, cookie: { domain: '.example.com' } })).toThrow(/only without a Domain/);
        expect(create({ ...keys, cookie: { path: '/app' } })).toThrow(/only at Path=\//);
        expect(create({ ...keys, cookie: { secure: false } })).toThrow(/only on a Secure cookie/);
    });

    it('rejects a __Secure- name on a cookie the app turned Secure off for', () => {
        // The weaker prefix, and the same silent failure: __Secure- is
        // accepted only on a Secure cookie, and a browser handed one without
        // it discards the cookie rather than complaining. Unlike __Host-, it
        // says nothing about Domain or Path, so those stay legal.
        const keys = { tokenCookieKey: '__Secure-TK', csrfCookieKey: '__Secure-CS' };
        expect(create({ ...keys, cookie: { secure: false } })).toThrow(/discards the cookie silently/);
        expect(create({ ...keys, cookie: { domain: '.example.com', path: '/app' } })).not.toThrow();
    });

    it('accepts either prefix on its own, which is the whole configuration it needs', () => {
        expect(create({ tokenCookieKey: '__Host-TK', csrfCookieKey: '__Host-CS' })).not.toThrow();
        expect(create({ tokenCookieKey: '__Secure-TK', csrfCookieKey: '__Secure-CS' })).not.toThrow();
    });
});

describe('ctx.cookieList', () => {
    it('keeps every value of a repeated cookie name (v1 header); ctx.cookie holds the first', () => {
        const ctx = createContext(createMockEvent('/', {
            headers: { Host: 'localhost', Cookie: 'sid=old; theme=dark; sid=new' },
        }), createMockContext(), { apiPath: '/api' });

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
        const ctx = createContext(event, createMockContext(), { apiPath: '/api' });

        expect(ctx.cookieList).toEqual({ sid: ['old', 'new'] });
        expect(ctx.cookie.sid).toBe('old');
    });

    it('decodes values and skips malformed pairs like the flat map', () => {
        const ctx = createContext(createMockEvent('/', {
            headers: { Host: 'localhost', Cookie: 'a=x%3Ay; junk; b=' },
        }), createMockContext(), { apiPath: '/api' });

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
        const lambder = new Lambder({ files: testPublicFiles() })
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
        const lambder = new Lambder({ files: testPublicFiles() })
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

    // Hex stand-ins for the two halves of a token: the controller checks every
    // candidate against the minted format before it reads anything, so a
    // cookie shaped like "hash:live" never reaches the store at all.
    const PARTITION = 'deadbeef';
    const LIVE_SECRET = '11fe';
    const FOREIGN_SECRET = 'f0e19';
    const OTHER_SECRET = '07be5';
    const LIVE_TOKEN = `${PARTITION}:${LIVE_SECRET}`;
    const STALE_TOKEN = `${PARTITION}:57a1e`;
    const FOREIGN_TOKEN = `${PARTITION}:${FOREIGN_SECRET}`;
    const OTHER_TOKEN = `${PARTITION}:${OTHER_SECRET}`;

    const liveSession = () => ({
        pk: PARTITION,
        sk: hashTok(LIVE_SECRET),
        csrfTokenHash: hashTok('csrf-token'),
        sessionKey: 'user-123',
        data: { role: 'user' },
        createdAt: nowSec(),
        expiresAt: nowSec() + 3600,
        lastAccessedAt: nowSec(),
        ttlInSeconds: 3600,
        dataVersion: 0,
    });

    /** The call context the controller reads onto and writes cookies into. */
    const makeCtx = (): any => ({ session: null, guardData: {}, responseHeaders: new LambderAnswerHeaders(), logList: [] });

    /**
     * The six deleting headers the everywhere-clear emits from
     * app.example.com: the host-only scope, the configured one, and every
     * parent domain of the request host, because a deletion reaches only a
     * cookie carrying the same Domain.
     */
    const everywhereClears = [
        'sid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
        'csid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
        'sid=; Max-Age=0; Domain=app.example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
        'csid=; Max-Age=0; Domain=app.example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
        'sid=; Max-Age=0; Domain=example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
        'csid=; Max-Age=0; Domain=example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
    ];

    const makeController = (tokens: string[], domain?: string | ((hostname: string) => string | undefined), host = 'app.example.com', csrfToken: string | null = 'csrf-token', csrfCookies: string[] = []) => {
        const ctx = makeCtx();
        const controller = new LambderSessionController({
            manager: new LambderSessionManager({
                store: new LambderDdbSessionStore({ tableName: 'test-sessions', region: 'us-east-1', partitionKey: 'pk', sortKey: 'sk' }),
                sessionSalt: 'test-salt-12345',
            }),
            tokenCookieKey: 'sid',
            csrfCookieKey: 'csid',
            cookieOptions: { domain },
            ctx,
            request: {
                host,
                cookies: { ...(tokens.length ? { sid: tokens } : {}), ...(csrfCookies.length ? { csid: csrfCookies } : {}) },
                csrfToken,
            },
        });
        return { controller, ctx };
    };

    /** The Set-Cookie values written so far, read by applying them onto a scratch header map. */
    const setCookies = (ctx: { responseHeaders: LambderAnswerHeaders }): string[] => {
        const headers: Record<string, string[]> = {};
        ctx.responseHeaders.applyInto(headers);
        return headers['Set-Cookie'] ?? [];
    };

    beforeEach(() => {
        ddbMock.reset();
        // Only the live secret's hash finds a record; every other token is a miss.
        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(GetCommand, { Key: { pk: PARTITION, sk: hashTok(LIVE_SECRET) } }).resolves({ Item: liveSession() });
        ddbMock.on(PutCommand).resolves({});
    });

    it('writes the session cookies under the configured domain, with the tokens unencoded', async () => {
        const { controller, ctx } = makeController([], (hostname) => hostname.endsWith('.example.com') ? '.example.com' : undefined);

        await controller.createSession('user-123', { role: 'user' });

        const cookies = setCookies(ctx);
        expect(cookies.length).toBe(2);
        expect(cookies[0]).toMatch(/^sid=[0-9a-f]+:[0-9a-f]+; Max-Age=\d+; Domain=\.example\.com; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Lax$/);
        expect(cookies[1]).toMatch(/^csid=[0-9a-f]+; Max-Age=\d+; Domain=\.example\.com; Path=\/; Expires=.*; Secure; SameSite=Lax$/);
    });

    it('finds the live session behind a stale copy that arrived first, and evicts the host-only twin', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController([STALE_TOKEN, LIVE_TOKEN], '.example.com');

        const session = await controller.fetchSession();

        expect(session.sessionKey).toBe('user-123');
        expect(ctx.session).toBe(session);
        expect(ddbMock.commandCalls(GetCommand).length).toBe(2);
        // The eviction of the host-only twin, and then the resolved session
        // re-issued at the configured scope, which is what keeps the eviction
        // from being a sign-out when the twin was the live copy.
        expect(setCookies(ctx)).toEqual([
            'sid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
            'csid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
            expect.stringMatching(new RegExp(`^sid=${LIVE_TOKEN}; Max-Age=\\d+; Domain=\\.example\\.com; Path=/;`)),
            expect.stringMatching(/^csid=csrf-token; Max-Age=\d+; Domain=\.example\.com; Path=\/;/),
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain('2 "sid" cookies');
        warn.mockRestore();
    });

    it('never deletes a live host-only cookie without shipping its replacement', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The eviction assumes the host-only copy is the stale one, and the
        // request carries no scope to check that with. An app that configured
        // a domain after running host-only has users whose LIVE cookie is the
        // host-only one, and any sibling host can plant a well-formed DEAD
        // cookie at the parent domain to make the twin arrive. Without the
        // re-issue the response is two deletions and nothing else, and an
        // ordinary successful request signs the visitor out. No sliding write
        // is due (the record was just accessed), so the re-issue is the
        // eviction's own.
        const planted = 'deadbeef:0a1';
        const { controller, ctx } = makeController([LIVE_TOKEN, planted], '.example.com');

        const session = await controller.fetchSession();

        expect(session.sessionKey).toBe('user-123');
        expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
        const cookies = setCookies(ctx);
        expect(cookies.filter((cookie) => cookie.includes('Max-Age=0')).length).toBe(2);
        expect(cookies.some((cookie) => new RegExp(`^sid=${LIVE_TOKEN}; Max-Age=\\d+; Domain=\\.example\\.com;`).test(cookie))).toBe(true);
        expect(cookies.some((cookie) => /^csid=csrf-token; Max-Age=\d+; Domain=\.example\.com;/.test(cookie))).toBe(true);
        warn.mockRestore();
    });

    it('does not evict when no domain is configured: the other copy is at a parent domain this host cannot name', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController([STALE_TOKEN, LIVE_TOKEN]);

        await controller.fetchSession();

        expect(setCookies(ctx)).toEqual([]);
        vi.restoreAllMocks();
    });

    it('refuses two live records rather than letting the posted CSRF token pick the winner', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Two live records, each with its own CSRF hash: the shape a planted
        // cookie really has, since a sibling subdomain plants its own CSRF
        // cookie beside the session it planted. Whichever CSRF token the
        // browser happens to send would otherwise select that session and the
        // ambiguity would be invisible, so neither is used.
        ddbMock.on(GetCommand, { Key: { pk: PARTITION, sk: hashTok(FOREIGN_SECRET) } }).resolves({ Item: { ...liveSession(), sk: hashTok(FOREIGN_SECRET), sessionKey: 'attacker', csrfTokenHash: hashTok('other-csrf') } });
        const { controller } = makeController([FOREIGN_TOKEN, LIVE_TOKEN], '.example.com');

        await expect(controller.fetchSession()).rejects.toThrow(/ambiguous/);
        vi.restoreAllMocks();
    });

    it('refuses the same pair when the planted CSRF token is the one posted', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The attack as it actually runs: js-cookie hands the caller the FIRST
        // CSRF cookie in document.cookie, and RFC 6265 orders a longer Path
        // first, which the planting site chooses. So the token posted is the
        // attacker's. Selecting on it would sign this visitor into the
        // attacker's account.
        ddbMock.on(GetCommand, { Key: { pk: PARTITION, sk: hashTok(FOREIGN_SECRET) } }).resolves({ Item: { ...liveSession(), sk: hashTok(FOREIGN_SECRET), sessionKey: 'attacker', csrfTokenHash: hashTok('other-csrf') } });
        const { controller } = makeController([FOREIGN_TOKEN, LIVE_TOKEN], '.example.com', 'app.example.com', 'other-csrf');

        await expect(controller.fetchSession()).rejects.toThrow(/ambiguous/);
        vi.restoreAllMocks();
    });

    it('still reports no session when the one live copy is not paired with the posted CSRF token', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // One live record and one stale cookie: unambiguous, so the pairing
        // check runs, and a caller that posted the wrong token has no session.
        const { controller } = makeController([STALE_TOKEN, LIVE_TOKEN], '.example.com', 'app.example.com', 'wrong-csrf');

        expect(await controller.fetchSessionIfExists()).toBeNull();
        vi.restoreAllMocks();
    });

    it('refuses more cookies than it will weigh, without reading the store', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Trimming to the first few would let anyone who can plant cookies at
        // a parent domain push the visitor's own copy out of the read: a
        // longer Path sorts ahead of it, nothing validates, no eviction is
        // emitted, and the logout never heals.
        const planted = ['deadbeef:0a1', 'deadbeef:0a2', 'deadbeef:0a3', 'deadbeef:0a4', 'deadbeef:0a5'];
        const { controller, ctx } = makeController([...planted, LIVE_TOKEN], '.example.com');

        await expect(controller.fetchSession()).rejects.toThrow(/ambiguous/);
        expect(ddbMock.commandCalls(GetCommand).length).toBe(0);
        expect(setCookies(ctx).length).toBeGreaterThan(0);
        // And nothing announced the reads: the line that says the store is
        // about to be read once per copy belongs after the cap, where reading
        // actually happens.
        expect(warn.mock.calls.some(([message]) => String(message).includes('Reading each'))).toBe(false);
        vi.restoreAllMocks();
    });

    it('reports no session when no copy is live, and leaves the cookies alone', async () => {
        // A deletion matches a cookie by name, whatever its value, so
        // clearing here would also delete a session another response set
        // after this request left the browser (a login, a rotation).
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController([STALE_TOKEN, 'deadbeef:01de5'], '.example.com');

        expect(await controller.fetchSessionIfExists()).toBeNull();
        expect(setCookies(ctx)).toEqual([]);
        vi.restoreAllMocks();
    });

    it('a single cookie takes the plain path: one read, no eviction, no warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController([LIVE_TOKEN], '.example.com');

        await controller.fetchSession();

        expect(ddbMock.commandCalls(GetCommand).length).toBe(1);
        expect(setCookies(ctx)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('refuses every cookie when two of them are live, and says so', async () => {
        // Two LIVE sessions under one name means one of them was planted: any
        // sibling subdomain can set a cookie at the parent domain, and it
        // arrives beside the real one with its own CSRF cookie, so the pairing
        // check does not catch it. Taking either would sign the visitor into
        // an account that is not theirs.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        ddbMock.on(GetCommand, { Key: { pk: PARTITION, sk: hashTok(OTHER_SECRET) } })
            .resolves({ Item: { ...liveSession(), sk: hashTok(OTHER_SECRET), sessionKey: 'attacker', csrfTokenHash: hashTok('attacker-csrf') } });
        const { controller, ctx } = makeController([OTHER_TOKEN, LIVE_TOKEN], '.example.com');

        await expect(controller.fetchSession()).rejects.toThrow(/ambiguous/);
        expect(ctx.session).toBe(null);
        expect(await controller.fetchSessionIfExists()).toBe(null);

        // Cleared at every scope this host may write, not just the one the
        // app configured. The planted copy is the whole reason: it sits at a
        // parent domain, and a deletion matches only a cookie carrying the
        // same Domain, so clearing the configured scope alone would evict
        // this visitor's own cookie and leave the planted one as the only
        // survivor, finishing the takeover instead of stopping it.
        expect(setCookies(ctx)).toEqual(everywhereClears);
        expect(warn.mock.calls.some(([message]) => String(message).includes('Refusing all of them'))).toBe(true);
        warn.mockRestore();
    });

    // ── A planted CSRF cookie ────────────────────────────────────────────────
    //
    // The session cookie is not the only plantable half. The browser client
    // reads its CSRF token with js-cookie, whose get() returns the FIRST copy
    // in document.cookie, and a browser orders a longer Path first, so a
    // sibling host that plants one CSRF cookie at a parent domain with a
    // deeper Path decides which token every call posts. The session cookie
    // then resolves and the pairing fails on every request, for ever: the
    // ordinary no-session answer emits no Set-Cookie at all, and the client
    // can only clear the scopes it knows, which are not the planted ones.

    it('refuses, and clears every scope, when the posted CSRF token came from a planted cookie', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController([LIVE_TOKEN], '.example.com', 'app.example.com', 'junk', ['junk', 'csrf-token']);

        await expect(controller.fetchSession()).rejects.toThrow(/ambiguous/);

        // Not a silent sessionExpired: the clearing headers are what heals the
        // state, and without them the visitor signs in again into the same loop.
        expect(setCookies(ctx)).toEqual(everywhereClears);
        expect(warn.mock.calls.some(([message]) => String(message).includes('Refusing all of them'))).toBe(true);
        warn.mockRestore();
    });

    it('resolves the same pair of CSRF cookies when the client picked the real one', async () => {
        // The planted cookie is inert here: whichever scope it sits at, the
        // browser handed the caller the real token, so it paired. Refusing on
        // the count alone would sign out a visitor whose state works.
        const { controller, ctx } = makeController([LIVE_TOKEN], '.example.com', 'app.example.com', 'csrf-token', ['csrf-token', 'junk']);

        const session = await controller.fetchSession();

        expect(session.sessionKey).toBe('user-123');
        expect(setCookies(ctx)).toEqual([]);
    });

    it('refuses when the posted token matches none of the CSRF cookies that arrived', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller, ctx } = makeController([LIVE_TOKEN], '.example.com', 'app.example.com', 'from-somewhere-else', ['junk']);

        await expect(controller.fetchSession()).rejects.toThrow(/ambiguous/);
        expect(setCookies(ctx)).toEqual(everywhereClears);
        warn.mockRestore();
    });

    it('answers no session, without clearing, for the stale CSRF cookie the client itself posted', async () => {
        // One CSRF cookie, and it is the token posted: nothing here says
        // another host is writing cookies, and the visitor's own client can
        // clear this one. The everywhere-clear is for the state it cannot.
        const { controller, ctx } = makeController([LIVE_TOKEN], '.example.com', 'app.example.com', 'stale-csrf', ['stale-csrf']);

        expect(await controller.fetchSessionIfExists()).toBeNull();
        expect(setCookies(ctx)).toEqual([]);
    });

    it('answers no session, without clearing, for a caller that sends no CSRF cookie at all', async () => {
        // The invoke caller's shape: the CSRF value rides in the envelope and
        // no cookie carries it, so "matches none of the cookies" is true of
        // every call it makes, right one included.
        const { controller, ctx } = makeController([LIVE_TOKEN], '.example.com', 'app.example.com', 'wrong-csrf', []);

        expect(await controller.fetchSessionIfExists()).toBeNull();
        expect(setCookies(ctx)).toEqual([]);

        const { controller: rightToken } = makeController([LIVE_TOKEN], '.example.com', 'app.example.com', 'csrf-token', []);
        expect((await rightToken.fetchSession()).sessionKey).toBe('user-123');
    });

    // ── An oversized planted session cookie ──────────────────────────────────

    it('never sends an oversized candidate to the store, and resolves the live session beside it', async () => {
        // A cookie may carry 4000 characters and DynamoDB refuses a partition
        // key over 2048 bytes, so an unchecked candidate turns a live session
        // into a 500 on every request: the store throws, the read error is not
        // "no session", and the pipeline crashes with the victim's own token
        // sitting right there.
        const reads: string[] = [];
        const liveRecord = {
            sessionKeyHash: PARTITION,
            secretHash: hashTok(LIVE_SECRET),
            csrfTokenHash: hashTok('csrf-token'),
            sessionKey: 'user-123',
            data: { role: 'user' },
            createdAt: nowSec(), expiresAt: nowSec() + 3600, lastAccessedAt: nowSec(), ttlInSeconds: 3600, dataVersion: 0,
        };
        const boundedStore: LambderSessionStore<any> = {
            isMemoryOnly: false,
            get: async (sessionKeyHash, secretHash) => {
                reads.push(sessionKeyHash);
                if(sessionKeyHash.length > 2048 || secretHash.length > 2048) throw new Error('DynamoDB: key too long');
                return sessionKeyHash === PARTITION && secretHash === hashTok(LIVE_SECRET) ? { ...liveRecord } : null;
            },
            create: async () => {}, update: async () => 'missing', delete: async () => null,
            listSecretHashes: async () => [],
        };
        const ctx = makeCtx();
        const controller = new LambderSessionController({
            manager: new LambderSessionManager({ store: boundedStore, sessionSalt: 'test-salt-12345' }),
            tokenCookieKey: 'sid', csrfCookieKey: 'csid', ctx,
            request: {
                host: 'app.example.com',
                cookies: { sid: [`${'f'.repeat(3000)}:${'e'.repeat(64)}`, 'not-hex-at-all:0123', LIVE_TOKEN] },
                csrfToken: 'csrf-token',
            },
        });

        expect((await controller.fetchSession()).sessionKey).toBe('user-123');
        // Only the well-formed candidate was read: a malformed one is no
        // session, decided before the store is touched.
        expect(reads).toEqual([PARTITION]);
    });

    // ── The candidate list itself ────────────────────────────────────────────

    it('treats one value arriving twice as one session, not as an ambiguity', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { controller } = makeController([LIVE_TOKEN, LIVE_TOKEN], '.example.com');

        expect((await controller.fetchSession()).sessionKey).toBe('user-123');
        expect(ddbMock.commandCalls(GetCommand).length).toBe(1);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('surfaces a store failure on one candidate as a read error, not as no session', async () => {
        // The distinction the whole layer rests on: "no session" makes the
        // caller clear the client's cookies, so a DynamoDB blip answering it
        // would be a forced logout.
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        ddbMock.on(GetCommand, { Key: { pk: PARTITION, sk: hashTok('bad') } }).rejects(new Error('ddb down'));
        const { controller } = makeController([`${PARTITION}:bad`, LIVE_TOKEN], '.example.com');

        await expect(controller.fetchSession()).rejects.toBeInstanceOf(LambderSessionReadError);
        await expect(controller.fetchSessionIfExists()).rejects.toBeInstanceOf(LambderSessionReadError);
        vi.restoreAllMocks();
    });

    it('end-to-end: a shadowed session API call succeeds and the response evicts the host-only copy beside the replacement', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
            session: {
                store: new LambderDdbSessionStore({ tableName: 'test-sessions', region: 'us-east-1', partitionKey: 'pk', sortKey: 'sk' }),
                sessionSalt: 'test-salt-12345',
                tokenCookieKey: 'sid', csrfCookieKey: 'csid',
                cookie: { domain: '.example.com' },
            },
        }).addSessionApi('whoami', { input: z.any(), output: z.any() }, async (ctx, res) => res.api({ key: ctx.session.sessionKey }));

        const result = await lambder.render(createMockEvent('/api', {
            httpMethod: 'POST',
            headers: { Host: 'app.example.com', 'Content-Type': 'application/json', Cookie: `sid=${STALE_TOKEN}; sid=${LIVE_TOKEN}` },
            body: JSON.stringify({ apiName: 'whoami', payload: {}, token: 'csrf-token' }),
        }), createMockContext());

        expect(JSON.parse(decodeBody(result)).payload).toEqual({ key: 'user-123' });
        expect(result.multiValueHeaders?.['Set-Cookie']).toEqual([
            'sid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
            'csid=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
            expect.stringMatching(new RegExp(`^sid=${LIVE_TOKEN}; Max-Age=\\d+; Domain=\\.example\\.com; Path=/;`)),
            expect.stringMatching(/^csid=csrf-token; Max-Age=\d+; Domain=\.example\.com; Path=\/;/),
        ]);
        vi.restoreAllMocks();
    });
});

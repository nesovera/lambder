/**
 * The transports: the browser caller through a real Lambder handler in
 * process (lambderHandlerTransport), sessions carried across calls by the
 * cookie-jar decorator, the fetch transport's request and answer mapping,
 * the mock app as a callee of LambderInvokeCaller, and the mock app behind
 * one MSW handler.
 */

import { testPublicFiles } from './helpers.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import LambderCaller from '../src/client/LambderCaller.js';
import LambderInvokeCaller from '../src/invoke/LambderInvokeCaller.js';
import { apiNameKeyOf } from '../src/shared/wire/LambderApiSignature.js';
import { lambderHandlerTransport } from '../src/invoke/lambderHandlerTransport.js';
import { lambderFetchTransport } from '../src/client/lambderFetchTransport.js';
import type { LambderApiTransport, LambderApiTransportRequest } from '../src/shared/transport/LambderApiTransport.js';
import { lambderCookieJarTransport } from '../src/shared/transport/lambderCookieJarTransport.js';
import { LambderCookieJar } from '../src/shared/transport/LambderCookieJar.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { initLambderMock } from '../src/mock/LambderMockApp.js';
import { lambderMockInvokeTransport } from '../src/mock/lambderMockInvokeTransport.js';
import { lambderMockMswHandler } from '../src/mock/lambderMockMswHandler.js';

type SessionData = { userId: string };

const createServer = () => {
    const app = initLambder<SessionData>().create({
        files: testPublicFiles(),
        apiPath: '/api',
        apiVersion: '1',
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    })
        .addApi('echo', { input: z.object({ text: z.string() }), output: z.object({ text: z.string(), ip: z.string(), host: z.string() }) },
            async (ctx, res) => res.api({ text: ctx.apiPayload.text, ip: ctx.ip, host: ctx.host }))
        .addApi('big', { input: z.object({}), output: z.object({ rows: z.array(z.string()) }) },
            async (_ctx, res) => res.api({ rows: Array.from({ length: 400 }, (_, i) => `row-${i} of the same text`) }))
        .addApi('login', { input: z.object({ user: z.string() }), output: z.object({ ok: z.boolean() }) },
            async (ctx, res) => { await app.getSessionController(ctx).createSession(ctx.apiPayload.user, { userId: ctx.apiPayload.user }); return res.api({ ok: true }); })
        .addSessionApi('me', { input: z.object({}), output: z.object({ userId: z.string() }) },
            async (ctx, res) => res.api({ userId: ctx.session.data.userId }))
        .addApi('slow', { input: z.object({}), output: z.object({ ok: z.boolean() }) },
            async (_ctx, res) => { await new Promise((resolve) => setTimeout(resolve, 300)); slowHandlerFinished = true; return res.api({ ok: true }); })
        .addApi('crash', { input: z.object({}), output: z.any() }, async () => { throw new Error('boom'); });
    return app;
};

/** Set by the `slow` handler when its 300ms run ends: the timeout test proves the caller answered before that. */
let slowHandlerFinished = false;
let server = createServer();
type Contract = typeof server.ApiContract;

describe('lambderHandlerTransport', () => {
    afterEach(() => { server = createServer(); slowHandlerFinished = false; });

    it('carries a browser-shaped call into a real handler and decodes the answer, compressed or not', async () => {
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: '1', transport: lambderHandlerTransport(server.getHandler(), { host: 'app.test', clientIp: '5.6.7.8' }) });
        expect(await caller.api('echo', { text: 'hi' })).toEqual({ text: 'hi', ip: '5.6.7.8', host: 'app.test' });
        const big = await caller.api('big', {});
        expect(big?.rows.length).toBe(400);
    });

    it('a caller built against another shape of the endpoint is answered versionExpired by the real gate', async () => {
        const stale = { ...await server.apiSignatures(), [await apiNameKeyOf('echo')]: 'an-older-shape' };
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: '1', apiSignatures: stale, transport: lambderHandlerTransport(server.getHandler()) });
        const outcome = await caller.apiOutcome('echo', { text: 'hi' });
        expect(outcome.ok).toBe(false);
        if(!outcome.ok) expect(outcome.reason).toBe('versionExpired');
    });

    it('a cookie jar keeps a real session across calls, and a fresh jar is a stranger', async () => {
        const jar = new LambderCookieJar();
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport: lambderCookieJarTransport(lambderHandlerTransport(server.getHandler()), { jar }) });
        expect(await caller.api('login', { user: 'ada' })).toEqual({ ok: true });
        expect(jar.size).toBe(2);
        expect(await caller.api('me', {})).toEqual({ userId: 'ada' });

        const stranger = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport: lambderCookieJarTransport(lambderHandlerTransport(server.getHandler()), { jar: new LambderCookieJar() }) });
        const outcome = await stranger.apiOutcome('me', {});
        expect(outcome.ok).toBe(false);
        if(!outcome.ok) expect(outcome.reason).toBe('sessionExpired');
    });

    it('a crash inside the app is its 500 envelope; a handler that throws outright is the error itself', async () => {
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport: lambderHandlerTransport(server.getHandler()) });
        const crash = await caller.apiOutcome('crash', {});
        expect(crash.ok).toBe(false);
        if(!crash.ok){ expect(crash.reason).toBe('server'); expect(crash.status).toBe(500); }

        // This used to assert a 502, which the transport synthesized because
        // API Gateway would have. A synthetic status was then the only thing
        // the caller got: the handler's error was attached to a field
        // LambderApiHttpAnswer does not declare and nobody read it. A handler
        // that threw answered nothing, so the call fails as a transport
        // failure, which is the one channel that carries a cause.
        const broken = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport: lambderHandlerTransport(async () => { throw new Error('init failed'); }) });
        const outcome = await broken.apiOutcome('echo', { text: 'x' });
        expect(outcome.ok).toBe(false);
        if(!outcome.ok && outcome.reason === 'server'){
            expect(outcome.error.message).toContain('init failed');
            expect((outcome.error.cause as Error).message).toBe('init failed');
        }else{
            throw new Error(`expected a server failure, got ${outcome.ok ? 'a success' : outcome.reason}`);
        }
    });

    it('routes an absolute apiPath by its path, which is the apiPath a caller outside a browser is told to configure', async () => {
        // lambderFetchTransport's own error tells a Node caller to give the
        // caller an absolute apiPath. Taken verbatim as the event's rawPath,
        // "https://api.test/api" matches no route, so a correctly wired app
        // answered 404 to every call.
        const caller = new LambderCaller<Contract>({ apiPath: 'https://api.test/api', isCorsEnabled: false, apiVersion: '1', transport: lambderHandlerTransport(server.getHandler(), { clientIp: '5.6.7.8' }) });
        expect(await caller.api('echo', { text: 'hi' })).toEqual({ text: 'hi', ip: '5.6.7.8', host: 'api.test' });
    });

    it('stops waiting when the caller\'s timeout fires, rather than answering long after it', async () => {
        // The handler cannot be cancelled and runs its 300ms out regardless;
        // what the timeout buys is the caller's answer. Ignoring the signal
        // made timeoutMs a no-op here: a 20ms timeout reported success at 306ms.
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, timeoutMs: 20, transport: lambderHandlerTransport(server.getHandler()) });

        const outcome = await caller.apiOutcome('slow', {});

        expect(outcome.ok).toBe(false);
        if(!outcome.ok) expect(outcome.reason).toBe('timeout');
        // The caller answered while the handler was still running, which is
        // what the timeout buys; a wall-clock bound says the same thing less
        // reliably on a loaded machine.
        expect(slowHandlerFinished).toBe(false);
    });

    it('refuses a call whose signal had already aborted, without running the handler', async () => {
        let handlerRan = false;
        const handler = server.getHandler();
        const controller = new AbortController();
        controller.abort();
        const caller = new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false,
            // `any` on the wrapper's parameters: lambderHandlerTransport takes
            // a LambderHandler, whose two overloads a wrapper cannot satisfy
            // with narrower ones.
            transport: lambderHandlerTransport((event: any, context: any) => { handlerRan = true; return handler(event, context); }),
        });

        const outcome = await caller.apiOutcome('echo', { text: 'hi' }, { signal: controller.signal });

        expect(outcome.ok).toBe(false);
        if(!outcome.ok) expect(outcome.reason).toBe('network');
        expect(handlerRan).toBe(false);
    });
});

describe('lambderHandlerTransport failures', () => {
    it('keeps the handler\'s own error, and keeps it out of the user-facing message', async () => {
        // The old version of this called an api that crashes INSIDE the app,
        // which render() answers with its own 500 envelope: the handler never
        // threw, so nothing here was exercised. A handler that throws is a
        // broken app, a failed import or a dead pool at construction time.
        const messages: unknown[] = [];
        const caller = new LambderCaller<Contract>({
            apiPath: '/api', apiVersion: '1', isCorsEnabled: false,
            messageHandler: (message) => { messages.push(message); },
            transport: lambderHandlerTransport(async () => { throw new Error('the connection pool is empty'); }),
        });

        const outcome = await caller.apiOutcome('echo', { text: 'hi' });

        expect(outcome.ok).toBe(false);
        if(!outcome.ok && outcome.reason === 'server'){
            expect(outcome.error.message).toContain('the connection pool is empty');
            expect((outcome.error.cause as Error).message).toBe('the connection pool is empty');
        }else{
            throw new Error(`expected a server failure, got ${outcome.ok ? 'a success' : outcome.reason}`);
        }
        // It used to survive only as the envelope's `message`, which is the
        // field the caller hands messageHandler as text for a user to read.
        expect(messages).toEqual([]);
    });

    it('calls a callee that did not answer with an HTTP result a server fault, not a network one', async () => {
        const caller = new LambderCaller<Contract>({
            apiPath: '/api', apiVersion: '1', isCorsEnabled: false,
            transport: lambderHandlerTransport((async () => ({ notAnHttpResult: true })) as never),
        });

        const outcome = await caller.apiOutcome('echo', { text: 'hi' });

        expect(outcome.ok).toBe(false);
        if(!outcome.ok && outcome.reason === 'server'){
            expect(outcome.error.message).toContain('HTTP response');
        }else{
            throw new Error(`expected a server failure, got ${outcome.ok ? 'a success' : outcome.reason}`);
        }
    });
});

describe('lambderFetchTransport', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('posts the envelope to the api path with the browser fetch options and maps the Response', async () => {
        const fetchMock = vi.fn(async () => ({
            status: 201, statusText: 'Created',
            headers: { get: (name: string) => name === 'retry-after' ? '4' : null, getSetCookie: () => ['a=1; Path=/'] },
            json: async () => ({ apiVersion: '1', payload: 1 }),
            text: async () => '{"apiVersion":"1","payload":1}',
        }));
        vi.stubGlobal('fetch', fetchMock);
        const transport = lambderFetchTransport({ cors: true });
        const signal = new AbortController().signal;
        const answer = await transport({ apiPath: '/secure', apiName: 'x', version: '1', token: 't', siteHost: 'h', payload: { a: 1 }, guardInputs: { g: 1 }, idempotencyKey: 'k', headers: { 'X-Extra': 'e' }, signal });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('/secure');
        expect(init.method).toBe('POST');
        expect(init.mode).toBe('cors');
        expect(init.credentials).toBe('include');
        expect(init.signal).toBe(signal);
        expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Extra': 'e' });
        expect(JSON.parse(init.body as string)).toEqual({ apiName: 'x', version: '1', token: 't', siteHost: 'h', payload: { a: 1 }, guardInputs: { g: 1 }, idempotencyKey: 'k' });
        expect(answer.status).toBe(201);
        expect(answer.header('retry-after')).toBe('4');
        expect(await answer.json()).toEqual({ apiVersion: '1', payload: 1 });
        expect(answer.setCookies).toEqual(['a=1; Path=/']);
    });

    it('sends the compressed pair in place of the payload, and same-origin credentials without cors', async () => {
        const fetchMock = vi.fn(async () => ({ status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' }));
        vi.stubGlobal('fetch', fetchMock);
        await lambderFetchTransport()({ apiPath: '/api', apiName: 'x', token: '', siteHost: '', compressed: { payloadGz: 'zz', payloadBytes: 3 } });
        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.credentials).toBe('same-origin');
        expect(JSON.parse(init.body as string)).toEqual({ apiName: 'x', token: '', siteHost: '', payloadGz: 'zz', payloadBytes: 3 });
    });

    it('sends the request\'s cookies as one Cookie header, so a jar over fetch is not write-only', async () => {
        // The jar collected every Set-Cookie and sent none of them back: a
        // Node script against a deployed app got its CSRF token filled in and
        // sessionExpired on every session call. A browser drops the header
        // silently (Cookie is a forbidden header name) and uses its own
        // store; undici sends it, which is where a jar is used.
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['LMDRSESSIONTKID=tok; Path=/; HttpOnly', 'LMDRSESSIONCSTK=csrf; Path=/'], { host: 'api.test' });
        const fetchMock = vi.fn(async () => ({ status: 200, statusText: 'OK', headers: { get: () => null }, json: async () => ({ apiVersion: '1', payload: null }), text: async () => '{}' }));
        vi.stubGlobal('fetch', fetchMock);

        const caller = new LambderCaller<Contract>({
            apiPath: 'https://api.test/api', isCorsEnabled: true,
            transport: lambderCookieJarTransport(lambderFetchTransport({ cors: true }), { jar }),
        });
        await caller.apiOutcome('echo', { text: 'hi' });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect((init.headers as Record<string, string>).Cookie).toBe('LMDRSESSIONTKID=tok; LMDRSESSIONCSTK=csrf');
        // And the CSRF value the jar holds went into the envelope, as a
        // page's script would have read it from document.cookie.
        expect(JSON.parse(init.body as string).token).toBe('csrf');
    });

    it('does not let a per-call Cookie or Content-Type header displace the ones it owns', async () => {
        // The caller's headers go on first now, so the two this transport owns
        // still stand. With the spread last, a call that added one cookie of
        // its own (a Node script, a test) replaced the whole Cookie header the
        // jar had just built: the session went missing and the answer was
        // sessionExpired with nothing pointing at the cause.
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['LMDRSESSIONTKID=tok; Path=/; HttpOnly', 'LMDRSESSIONCSTK=csrf; Path=/'], { host: 'api.test' });
        const fetchMock = vi.fn(async () => ({ status: 200, statusText: 'OK', headers: { get: () => null }, json: async () => ({ apiVersion: '1', payload: null }), text: async () => '{}' }));
        vi.stubGlobal('fetch', fetchMock);

        const caller = new LambderCaller<Contract>({
            apiPath: 'https://api.test/api', isCorsEnabled: true,
            transport: lambderCookieJarTransport(lambderFetchTransport({ cors: true }), { jar }),
        });
        await caller.apiOutcome('echo', { text: 'hi' }, { headers: { Cookie: 'planted=1', 'Content-Type': 'text/plain', 'X-Extra': 'kept' } });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers.Cookie).toBe('LMDRSESSIONTKID=tok; LMDRSESSIONCSTK=csrf');
        expect(headers['Content-Type']).toBe('application/json');
        // Everything else the call asked for still travels.
        expect(headers['X-Extra']).toBe('kept');
    });

    it('sends no Cookie header when the request carries no cookies', async () => {
        const fetchMock = vi.fn(async () => ({ status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' }));
        vi.stubGlobal('fetch', fetchMock);
        await lambderFetchTransport()({ apiPath: '/api', apiName: 'x', token: '', siteHost: '', cookies: [] });
        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    });
});

describe('The cookie jar as a browser would keep it', () => {
    // What a jar accepts and where it then sends it lives in cookie-jar.test.ts.
    it('reads the CSRF token under the name the caller uses, not the default', async () => {
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['MYCSRF=token-from-the-jar; Path=/']);
        const seen: unknown[] = [];
        const inner: LambderApiTransport = async (request) => { seen.push(request); return { status: 200, statusText: '', header: () => null, json: async () => ({ apiVersion: '1', payload: null }), text: async () => '', setCookies: [] }; };
        const caller = new LambderCaller<Contract>({ apiPath: '/api', apiVersion: '1', isCorsEnabled: false, transport: lambderCookieJarTransport(inner, { jar }) });
        caller.setSessionCookieKey('MYTOKEN', 'MYCSRF');

        await caller.apiOutcome('echo', { text: 'hi' });

        expect(seen[0]).toMatchObject({ token: 'token-from-the-jar' });
    });
});

describe('lambderFetchTransport outside a browser', () => {
    it('says the apiPath is the problem, rather than reporting the network as down', async () => {
        // `fetch("/api")` in Node throws "Failed to parse URL from /api",
        // which the caller would otherwise classify as `network`: the one
        // reading it goes looking at their connection.
        const caller = new LambderCaller<Contract>({ apiPath: '/api', apiVersion: '1', isCorsEnabled: false });

        const outcome = await caller.apiOutcome('echo', { text: 'hi' });

        expect(outcome.ok).toBe(false);
        if(!outcome.ok && outcome.reason === 'server'){
            expect(outcome.error.message).toContain('absolute apiPath');
        }else{
            throw new Error(`expected a server failure, got ${outcome.ok ? 'a success' : outcome.reason}`);
        }
    });
});

describe('lambderCookieJarTransport', () => {
    it('sends the jar\'s cookies, fills the CSRF token from the jar, and stores Set-Cookie from the answer', async () => {
        const jar = new LambderCookieJar();
        jar.storeSetCookies(['LMDRSESSIONTKID=tok; Path=/; HttpOnly', 'LMDRSESSIONCSTK=csrf; Path=/']);
        const seen: unknown[] = [];
        const inner: LambderApiTransport = async (request) => {
            seen.push(request);
            return { status: 200, header: () => null, json: async () => ({}), text: async () => '{}', setCookies: ['extra=1; Path=/'] };
        };
        await lambderCookieJarTransport(inner, { jar })({ apiPath: '/api', apiName: 'x', token: '', siteHost: '', cookies: ['theme=dark'] });
        expect(seen[0]).toMatchObject({ token: 'csrf', cookies: ['theme=dark', 'LMDRSESSIONTKID=tok', 'LMDRSESSIONCSTK=csrf'] });
        expect(jar.get('extra')).toBe('1');

        // A token the caller read itself wins over the jar's.
        await lambderCookieJarTransport(inner, { jar })({ apiPath: '/api', apiName: 'x', token: 'own', siteHost: '' });
        expect(seen[1]).toMatchObject({ token: 'own' });
    });

    it('scopes the jar to where the call goes, host and path read off an absolute apiPath', async () => {
        // The scoping used to be inert in every shipped configuration: the
        // decorator passed `request.siteHost`, which is "" outside a browser
        // and became undefined, so every cookie was stored unscoped and sent
        // to every host, and the path was never passed at all.
        const jar = new LambderCookieJar();
        const seen: LambderApiTransportRequest[] = [];
        const inner: LambderApiTransport = async (request) => {
            seen.push(request);
            return { status: 200, header: () => null, json: async () => ({}), text: async () => '{}', setCookies: ['sid=api-host; Path=/'] };
        };
        const transport = lambderCookieJarTransport(inner, { jar });

        await transport({ apiPath: 'https://api.test/v1/api', apiName: 'x', token: '', siteHost: 'app.test' });

        // Stored against the host the request reached, which is whose cookie
        // it is, rather than the page the caller happens to be served from.
        expect(jar.cookiePairs({ host: 'api.test', path: '/v1/api' })).toEqual(['sid=api-host']);
        expect(jar.cookiePairs({ host: 'app.test', path: '/v1/api' })).toEqual([]);
        await transport({ apiPath: 'https://api.test/v1/api', apiName: 'x', token: '', siteHost: 'app.test' });
        expect(seen[1]?.cookies).toEqual(['sid=api-host']);
        // A call to another host carries nothing of this one's.
        await transport({ apiPath: 'https://other.test/v1/api', apiName: 'x', token: '', siteHost: 'app.test' });
        expect(seen[2]?.cookies).toEqual([]);
    });

    it('takes the host from the apiPath first, then the option, then the caller\'s site host', async () => {
        const inner: LambderApiTransport = async () => ({ status: 200, header: () => null, json: async () => ({}), text: async () => '{}', setCookies: ['sid=1; Path=/'] });

        // Nothing but the page the caller is on: that is the last fallback.
        const fromPage = new LambderCookieJar();
        await lambderCookieJarTransport(inner, { jar: fromPage })({ apiPath: '/api', apiName: 'x', token: '', siteHost: 'page.test' });
        expect(fromPage.cookiePairs({ host: 'page.test' })).toEqual(['sid=1']);
        expect(fromPage.cookiePairs({ host: 'elsewhere.test' })).toEqual([]);

        // A relative apiPath names no host, so the option is what scopes it.
        const pinned = new LambderCookieJar();
        await lambderCookieJarTransport(inner, { jar: pinned, host: 'api.internal' })({ apiPath: '/api', apiName: 'x', token: '', siteHost: 'page.test' });
        expect(pinned.cookiePairs({ host: 'api.internal' })).toEqual(['sid=1']);
        expect(pinned.cookiePairs({ host: 'page.test' })).toEqual([]);

        // An apiPath that names its own host is a fact about where this call
        // goes, and it outranks the option: the other way round, a transport
        // configured with one host sent that host's session to another.
        const crossOrigin = new LambderCookieJar();
        await lambderCookieJarTransport(inner, { jar: crossOrigin, host: 'app.example.com' })({ apiPath: 'https://api.other.com/api', apiName: 'x', token: '', siteHost: 'page.test' });
        expect(crossOrigin.cookiePairs({ host: 'api.other.com' })).toEqual(['sid=1']);
        expect(crossOrigin.cookiePairs({ host: 'app.example.com' })).toEqual([]);
    });
});

describe('LambderCaller in-flight state', () => {
    it('holds one tracker per call in flight and drops it the moment the call settles', async () => {
        // Nothing removed a tracker, so 50 settled calls left 50 entries and
        // every handler call filtered the whole list: a long-lived page paid
        // more per call the longer it had been open.
        const activeCounts: number[] = [];
        const caller = new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false,
            transport: lambderHandlerTransport(server.getHandler()),
            fetchStartedHandler: ({ activeFetchList }) => { activeCounts.push(activeFetchList.length); },
        });

        expect(caller.isLoading).toBe(false);
        const pending = [caller.apiOutcome('slow', {}), caller.apiOutcome('slow', {})];
        expect(caller.fetchTrackerList.map((tracker) => tracker.apiName)).toEqual(['slow', 'slow']);
        expect(caller.isLoading).toBe(true);
        await Promise.all(pending);
        expect(caller.fetchTrackerList).toEqual([]);
        expect(caller.isLoading).toBe(false);

        for(let i = 0; i < 5; i += 1) await caller.apiOutcome('echo', { text: 'x' });
        expect(caller.fetchTrackerList).toEqual([]);
        expect(activeCounts).toEqual([1, 2, 1, 1, 1, 1, 1]);
    });

    it('does not report success for an answer that arrived after its own timeout', async () => {
        // Honouring request.signal is the transport's obligation, but the
        // caller cannot assume every transport does: believing a late answer
        // hands a call site the data it had already given up on, under a
        // timeout it set itself.
        const errors: Error[] = [];
        const deafToAbort: LambderApiTransport = async () => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            return { status: 200, statusText: '', header: () => null, json: async () => ({ apiVersion: '1', payload: { text: 'late' } }), text: async () => '{}' };
        };
        const caller = new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false, timeoutMs: 10,
            errorHandler: (err) => { errors.push(err); },
            transport: deafToAbort,
        });

        const outcome = await caller.apiOutcome('echo', { text: 'hi' });

        expect(outcome.ok).toBe(false);
        if(!outcome.ok) expect(outcome.reason).toBe('timeout');
        expect(errors.length).toBe(1);
    });
});

describe('The mock app as a callee', () => {
    const mock = initLambderMock<Contract, SessionData>();
    const createMockApp = () => {
        const mockApp = mock.create({ apiVersion: '1', sessions: true });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.publicApi('echo', async ({ payload, request }) => ({ text: payload.text, ip: request.ip, host: request.host })),
            mockApp.sessionApi('me', async ({ session }) => ({ userId: session.data.userId })),
        ));
        return mockApp;
    };

    it('answers a LambderInvokeCaller through the invoke-shaped transport, sessions included', async () => {
        const mockApp = createMockApp();
        const created = await mockApp.signIn('ada', { userId: 'ada' });
        const caller = new LambderInvokeCaller<Contract>({ functionName: 'callee', apiVersion: '1', host: 'callee.internal', transport: lambderMockInvokeTransport(mockApp) });
        expect(await caller.api('echo', { text: 'hi' }, { clientIp: '10.0.0.1' })).toEqual({ text: 'hi', ip: '10.0.0.1', host: 'callee.internal' });
        expect(await caller.api('me', {}, { session: { token: created.sessionToken, csrf: created.csrfToken } })).toEqual({ userId: 'ada' });
        const stranger = await caller.apiOutcome('me', {});
        expect(stranger.ok).toBe(false);
        if(!stranger.ok) expect(stranger.reason).toBe('sessionExpired');
        const unknown = await (caller as LambderInvokeCaller<any>).apiOutcome('nope', {});
        expect(unknown.ok).toBe(false);
        if(!unknown.ok) expect(unknown.errorMessage?.code).toBe('lambder/api-not-found');
    });

    it('serves one MSW handler for the whole api path, cookies riding on the request and the response', async () => {
        const mockApp = createMockApp();
        const created = await mockApp.signIn('ada', { userId: 'ada' });
        const registered: { path: string; resolver: (info: { request: Request }) => Promise<unknown> }[] = [];
        class FakeHttpResponse extends Response {
            static error(): Response { return new Response(null, { status: 599 }); }
        }
        const msw = { http: { post: (path: string, resolver: (info: { request: Request }) => Promise<unknown>) => { registered.push({ path, resolver }); return 'handler'; } }, HttpResponse: FakeHttpResponse };
        expect(lambderMockMswHandler(mockApp, { msw, apiPath: '/secure' })).toBe('handler');
        expect(registered[0]!.path).toBe('/secure');
        const resolve = registered[0]!.resolver;

        const call = (body: unknown, cookie?: string) => resolve({ request: new Request('http://app.test/secure', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }) });

        const echo = await call({ apiName: 'echo', payload: { text: 'hi' }, token: '', version: '1' }) as Response;
        expect(echo.status).toBe(200);
        expect(JSON.parse(await echo.text())).toEqual({ apiVersion: '1', payload: { text: 'hi', ip: '127.0.0.1', host: 'app.test' } });

        const me = await call({ apiName: 'me', payload: {}, token: created.csrfToken }, `LMDRSESSIONTKID=${created.sessionToken}`) as Response;
        expect(JSON.parse(await me.text()).payload).toEqual({ userId: 'ada' });

        expect(await call({ notAnEnvelope: true })).toBeUndefined();
        expect(await resolve({ request: new Request('http://app.test/secure', { method: 'POST', body: 'not json' }) })).toBeUndefined();

        mockApp.setOffline(true);
        expect(((await call({ apiName: 'echo', payload: { text: 'x' }, token: '' })) as Response).status).toBe(599);
        expect(() => lambderMockMswHandler(mockApp, { msw: {} as never, apiPath: '/x' })).toThrow(/requires the msw module/);
    });

    it('carries a session across calls itself, because an MSW response never reaches the browser cookie store', async () => {
        // The browser does not hold these cookies and cannot be made to: a
        // response a service worker synthesizes never reaches the cookie
        // store, and MSW's own jar comma-joins the Set-Cookie headers before
        // parsing them, which drops every cookie after the first. So no
        // request below carries a Cookie header, exactly as in a browser, and
        // the session still has to survive from one call to the next.
        const mockApp = mock.create({ apiVersion: '1', sessions: true });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.publicApi('login', async ({ payload, sessions }) => {
                await sessions.createSession(payload.user, { userId: payload.user });
                return { ok: true };
            }),
            mockApp.sessionApi('me', async ({ session }) => ({ userId: session.data.userId })),
        ));
        const jar = new LambderCookieJar();
        const registered: ((info: { request: Request }) => Promise<unknown>)[] = [];
        class FakeHttpResponse extends Response {
            static error(): Response { return new Response(null, { status: 599 }); }
        }
        const msw = { http: { post: (_path: string, resolver: (info: { request: Request }) => Promise<unknown>) => { registered.push(resolver); return 'handler'; } }, HttpResponse: FakeHttpResponse };
        lambderMockMswHandler(mockApp, { msw, apiPath: '/api', cookieJar: jar });
        const call = (body: unknown) => registered[0]!({ request: new Request('http://app.test/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }) as Promise<Response>;

        const login = await call({ apiName: 'login', payload: { user: 'ada' }, token: '', version: '1' });
        expect(login.status).toBe(200);

        // Both cookies survived. A comma-joined read keeps only the first,
        // and the one it drops is the CSRF cookie every session call needs.
        expect(jar.size).toBe(2);
        const csrf = jar.get('LMDRSESSIONCSTK');
        expect(csrf).toBeTruthy();
        expect(jar.get('LMDRSESSIONTKID', { includeHttpOnly: true })).toBeTruthy();
        // The session cookie stays invisible to page scripts, as it is HttpOnly.
        expect(jar.get('LMDRSESSIONTKID')).toBeUndefined();

        const me = await call({ apiName: 'me', payload: {}, token: csrf, version: '1' });
        expect(JSON.parse(await me.text()).payload).toEqual({ userId: 'ada' });
    });
});

/**
 * lambder/testing: a built Lambder instance put under test in place.
 *
 * The app below is written the way an application is: one module-level
 * instance over stores a test must never reach, whose handlers close over it.
 * Every store it is created with throws on any use, so a call that passes
 * proves the memory stores are under the instance, and under the closures
 * too.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import { refuse, LAMBDER_REFUSAL_CODES } from '../src/shared/wire/LambderApiRefusal.js';
import { LambderLocalFileSource } from '../src/stores/LambderLocalFileSource.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import type { LambderSessionStore } from '../src/shared/contracts/LambderSessionStore.js';
import type { LambderRateLimiter } from '../src/shared/contracts/LambderRateLimiter.js';
import type { LambderIdempotencyStore } from '../src/shared/contracts/LambderIdempotencyStore.js';
import LambderCaller from '../src/client/LambderCaller.js';
import { lambderHandlerTransport } from '../src/invoke/lambderHandlerTransport.js';
import { lambderTestApp, assertApiSuccess, assertApiFailure } from '../src/testing.js';

type SessionData = { userId: string; role: 'admin' | 'member'; refreshed?: boolean };

const productionStoreTouched = (what: string) => (): never => {
    throw new Error(`a test reached the production ${what}`);
};

/** A session store standing in for the production table: any use is a failure. */
const productionSessionStore: LambderSessionStore<any> = {
    isMemoryOnly: false,
    get: productionStoreTouched('session store'),
    create: productionStoreTouched('session store'),
    update: productionStoreTouched('session store'),
    delete: productionStoreTouched('session store'),
    listSecretHashes: productionStoreTouched('session store'),
};
const productionRateLimiter: LambderRateLimiter = { isRateLimited: productionStoreTouched('rate limiter') };
const productionIdempotencyStore = new Proxy({}, { get: () => productionStoreTouched('idempotency store') }) as LambderIdempotencyStore;

let ordersCreated = 0;
let scheduledRuns: unknown[] = [];

const createApp = () => {
    const app = initLambder<SessionData>().create({
        files: new LambderLocalFileSource({ root: './tests/fixtures/public' }),
        apiPath: '/secure',
        apiVersion: '1.0.0',
        session: {
            store: productionSessionStore,
            sessionSalt: 'salt',
            dataRefresh: { ttlSeconds: 3600, refresh: async (session) => ({ ...session.data, refreshed: true }) },
        },
        // failOpen off on both: left on, a throwing production store would be
        // waved through and the swap would prove nothing.
        rateLimits: { limiter: productionRateLimiter, failOpen: false, policies: { oncePerMinute: { perMin: 1, per: 'ip' } } },
        idempotency: { store: productionIdempotencyStore, failOpen: false },
        guards: {
            role: lambderGuard({
                session: true,
                handler: (ctx, _input, wanted: 'admin' | 'member') => {
                    if(ctx.session.data.role !== wanted) refuse('Wrong role.', { code: 'app/wrong-role', notAuthorized: true });
                    return { role: ctx.session.data.role };
                },
            }),
            tenant: lambderGuard({
                guardInput: z.object({ tenantId: z.string() }),
                handler: (_ctx, input, _param: true) => ({ tenantId: input.tenantId }),
            }),
        },
    })
        .addApi('echo', { input: z.object({ text: z.string() }), output: z.object({ text: z.string(), ip: z.string(), host: z.string(), country: z.string().nullable() }) },
            async (ctx, res) => res.api({ text: ctx.apiPayload.text, ip: ctx.ip, host: ctx.host, country: ctx.headers['x-country'] ?? null }))
        // The handler closes over the instance, as an app's login does.
        .addApi('login', { input: z.object({ user: z.string() }), output: z.object({ ok: z.boolean() }) },
            async (ctx, res) => { await app.getSessionController(ctx).createSession(ctx.apiPayload.user, { userId: ctx.apiPayload.user, role: 'member' }); return res.api({ ok: true }); })
        .addSessionApi('me', { input: z.object({}), output: z.object({ userId: z.string(), refreshed: z.boolean() }) },
            async (ctx, res) => res.api({ userId: ctx.session.data.userId, refreshed: ctx.session.data.refreshed === true }))
        .addSessionApi('admin.only', { input: z.object({}), output: z.object({ ok: z.boolean() }), guards: { role: 'admin' } },
            async (_ctx, res) => res.api({ ok: true }))
        .addApi('tenant.name', { input: z.object({}), output: z.object({ tenantId: z.string() }), guards: { tenant: true } },
            async (ctx, res) => res.api({ tenantId: ctx.guardData.tenant.tenantId }))
        .addApi('limited', { input: z.object({}), output: z.object({ ok: z.boolean() }), rateLimit: 'oncePerMinute' },
            async (_ctx, res) => res.api({ ok: true }))
        .addApi('order.create', { input: z.object({ sku: z.string() }), output: z.object({ orderNumber: z.number() }), idempotency: true },
            async (_ctx, res) => { ordersCreated += 1; return res.api({ orderNumber: ordersCreated }); })
        .addApi('crash', { input: z.object({}), output: z.any() }, async () => { throw new Error('boom'); })
        .addApi('slow.ok', { input: z.object({}), output: z.object({ ok: z.boolean() }) },
            async (_ctx, res) => { await new Promise((resolve) => setTimeout(resolve, 20)); return res.api({ ok: true }); })
        .addRoute('/broken', () => { throw new Error('the page broke'); })
        .addRoute('/hello/:name', (ctx, res) => res.html(`<p>Hello ${ctx.pathParams.name}, q=${ctx.get.q ?? ''}, country=${ctx.headers['x-country'] ?? ''}</p>`))
        .addRoute('/old', (_ctx, res) => res.redirect('/hello/moved'))
        .addRoute('/remember', (_ctx, res) => { res.setCookie('theme', 'dark'); return res.html('ok'); })
        .addRoute('/theme', (ctx, res) => res.json({ theme: ctx.cookie.theme ?? null }))
        .addRoute({ method: 'POST', path: '/form' }, (ctx, res) => res.json({ got: ctx.post }))
        .addSessionRoute('/account', (ctx, res) => res.html(`account of ${ctx.session.data.userId}`))
        .addAction((event) => (event as { source?: string } | null)?.source === 'aws.events', async (event, tools) => {
            scheduledRuns.push(event);
            return { ran: true, functionName: tools.lambdaContext.functionName };
        })
        .servePublicFiles();
    return app;
};

const lambder = createApp();
const app = lambderTestApp(lambder);

beforeEach(() => { app.reset(); ordersCreated = 0; scheduledRuns = []; });

describe('lambderTestApp: the stores under the instance', () => {
    it('puts memory stores under a built instance, so no call reaches the ones it was created with', async () => {
        const visitor = app.visitor();
        // Rate limits, idempotency and sessions each ran over a store that
        // throws on any use, with failOpen off.
        expect(await visitor.api('limited', {})).toEqual({ ok: true });
        expect(await visitor.api('order.create', { sku: 'a' }, { idempotencyKey: 'key-0123456789abcdef' })).toEqual({ orderNumber: 1 });
        expect(await visitor.api('login', { user: 'ada' })).toEqual({ ok: true });
        expect(await visitor.api('me', {})).toEqual({ userId: 'ada', refreshed: false });
    });

    it('is what stands between a test and those stores: the same instance, never put under test, reaches them', async () => {
        // The control for the test above. Without it, a production store that
        // silently did nothing would let that one pass and prove nothing.
        const untested = new LambderCaller<typeof lambder.ApiContract>({ apiPath: '/secure', isCorsEnabled: false, transport: lambderHandlerTransport(createApp().getHandler()) });
        const crashed = await untested.apiOutcome('limited', {});
        assertApiFailure(crashed, 'server', { status: 500 });
    });

    it('hands out the stores it put there, for assertions', async () => {
        await app.signIn('ada', { userId: 'ada', role: 'member' });
        expect(app.sessionStore).toBeInstanceOf(LambderMemorySessionStore);
        expect((app.sessionStore as LambderMemorySessionStore<SessionData>).list().map((record) => record.sessionKey)).toEqual(['ada']);
        expect(app.rateLimiter).not.toBeNull();
        expect(app.idempotencyStore).not.toBeNull();
    });

    it('reports null for a subsystem the app never configured, and refuses signIn without sessions', async () => {
        const bare = lambderTestApp(initLambder().create({}).addApi('ping', { input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (_ctx, res) => res.api({ ok: true })));
        expect(bare.sessionStore).toBeNull();
        expect(bare.rateLimiter).toBeNull();
        expect(bare.idempotencyStore).toBeNull();
        expect(await bare.visitor().api('ping', {})).toEqual({ ok: true });
        await expect(bare.signIn('ada', {})).rejects.toThrow(/needs an app with sessions/);
    });

    it('takes a store of the test\'s own, and leaves it alone on reset', async () => {
        const ownStore = new LambderMemorySessionStore<SessionData>();
        const own = lambderTestApp(createApp(), { session: { store: ownStore } });
        await own.signIn('ada', { userId: 'ada', role: 'member' });
        own.reset();
        expect(ownStore.size).toBe(1);
    });

    it('refuses what is not a Lambder instance, in its own words', () => {
        expect(() => lambderTestApp({} as never)).toThrow(/expected a Lambder instance/);
    });
});

describe('lambderTestApp: visitors', () => {
    it('signs a visitor in without a login endpoint, under the app\'s own session model', async () => {
        const admin = await app.signIn('ada', { userId: 'ada', role: 'admin' });
        expect(await admin.api('me', {})).toEqual({ userId: 'ada', refreshed: false });
        expect(await admin.api('admin.only', {})).toEqual({ ok: true });
    });

    it('keeps visitors apart: each has its own cookies, and a stranger has none', async () => {
        const admin = await app.signIn('ada', { userId: 'ada', role: 'admin' });
        const member = await app.signIn('bob', { userId: 'bob', role: 'member' });
        const guest = app.visitor();

        expect(await admin.api('me', {})).toMatchObject({ userId: 'ada' });
        expect(await member.api('me', {})).toMatchObject({ userId: 'bob' });
        assertApiFailure(await member.apiOutcome('admin.only', {}), 'notAuthorized', { code: 'app/wrong-role' });
        assertApiFailure(await guest.apiOutcome('me', {}), 'sessionExpired');
    });

    it('posts the CSRF token of its own jar, not one a page\'s document.cookie holds', async () => {
        const ada = await app.signIn('ada', { userId: 'ada', role: 'member' });
        // A test with a DOM: the caller would read this and post it over the jar's.
        (globalThis as { document?: unknown }).document = { cookie: 'LMDRSESSIONCSTK=a-token-of-the-page' };
        try {
            assertApiSuccess(await ada.apiOutcome('me', {}));
        } finally {
            delete (globalThis as { document?: unknown }).document;
        }
    });

    it('gives each visitor an address of its own, so a per-ip limit counts them apart', async () => {
        const first = app.visitor();
        const second = app.visitor();
        expect(first.clientIp).not.toBe(second.clientIp);

        expect(await first.api('limited', {})).toEqual({ ok: true });
        assertApiFailure(await first.apiOutcome('limited', {}), 'errorMessage', { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
        expect(await second.api('limited', {})).toEqual({ ok: true });

        // The same address is the same counter, which is how a shared one is tested.
        const sharing = app.visitor({ clientIp: second.clientIp });
        assertApiFailure(await sharing.apiOutcome('limited', {}), 'errorMessage', { code: LAMBDER_REFUSAL_CODES.rateLimited });
    });

    it('shows the handler the visitor\'s host, address and headers', async () => {
        const visitor = app.visitor({ host: 'shop.test', clientIp: '198.51.100.9', headers: { 'x-country': 'US' } });
        expect(await visitor.api('echo', { text: 'hi' })).toEqual({ text: 'hi', ip: '198.51.100.9', host: 'shop.test', country: 'US' });
        // A call's own header wins over the visitor's.
        expect(await visitor.api('echo', { text: 'hi' }, { headers: { 'x-country': 'CA' } })).toMatchObject({ country: 'CA' });
    });

    it('supplies guard inputs from a provider, as LambderCaller does', async () => {
        const visitor = app.visitor<'tenant'>({ guardInputsProvider: () => ({ tenant: { tenantId: 'acme' } }) });
        expect(await visitor.api('tenant.name', {})).toEqual({ tenantId: 'acme' });
    });

    it('hands out its caller, for code under test that takes one', async () => {
        const visitor = await app.signIn('ada', { userId: 'ada', role: 'member' });
        expect(visitor.caller).toBeInstanceOf(LambderCaller);
        const readUserId = async (caller: typeof visitor.caller) => (await caller.api('me', {}))?.userId;
        expect(await readUserId(visitor.caller)).toBe('ada');
    });

    it('replays an idempotent call rather than running it twice', async () => {
        const visitor = app.visitor();
        const idempotencyKey = 'key-0123456789abcdef';
        expect(await visitor.api('order.create', { sku: 'a' }, { idempotencyKey })).toEqual({ orderNumber: 1 });
        expect(await visitor.api('order.create', { sku: 'a' }, { idempotencyKey })).toEqual({ orderNumber: 1 });
        expect(ordersCreated).toBe(1);
    });
});

describe('lambderTestApp: sessions from outside a request', () => {
    it('signOut ends the subject\'s sessions, and the visitor finds out the way a browser does', async () => {
        const visitor = await app.signIn('ada', { userId: 'ada', role: 'member' });
        await app.signOut('ada');
        assertApiFailure(await visitor.apiOutcome('me', {}), 'sessionExpired');
    });

    it('expireSessionData makes the next read renew through the app\'s dataRefresh', async () => {
        const visitor = await app.signIn('ada', { userId: 'ada', role: 'member' });
        expect(await visitor.api('me', {})).toEqual({ userId: 'ada', refreshed: false });
        await app.expireSessionData('ada');
        expect(await visitor.api('me', {})).toEqual({ userId: 'ada', refreshed: true });
    });

    it('lets a faked Date move the framework, the stores and the app together', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const visitor = await app.signIn('ada', { userId: 'ada', role: 'member' }, { ttlSeconds: 60 });
            const limited = app.visitor();
            expect(await limited.api('limited', {})).toEqual({ ok: true });
            assertApiFailure(await limited.apiOutcome('limited', {}), 'errorMessage');

            vi.setSystemTime(Date.now() + 61_000);

            // The rate-limit window passed, and so did the session's TTL.
            expect(await limited.api('limited', {})).toEqual({ ok: true });
            assertApiFailure(await visitor.apiOutcome('me', {}), 'sessionExpired');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('lambderTestApp: what the app threw', () => {
    it('hands a crashed call the error the app threw, as the cause of the failure any client would get', async () => {
        const crashed = await app.visitor().apiOutcome('crash', {});

        // The answer is the app's own, untouched: a 500 that says nothing.
        assertApiFailure(crashed, 'server', { status: 500 });
        expect(crashed.errorMessage).toEqual({ type: 'error', content: 'Internal server error.' });
        // What was thrown travels beside it, stack and all.
        expect(crashed.error.cause).toBeInstanceOf(Error);
        expect((crashed.error.cause as Error).message).toBe('boom');
        expect((crashed.error.cause as Error).stack).toContain('test-app.test.ts');
        expect(app.crashes.map((error) => error.message)).toEqual(['boom']);
    });

    it('names the thrown error in a failed assertion, and chains it for the runner to print', async () => {
        const crashed = await app.visitor().apiOutcome('crash', {});
        let thrown: Error | undefined;
        try { assertApiSuccess(crashed); } catch(err){ thrown = err as Error; }

        expect(thrown?.message).toContain('reason "server", status 500');
        expect(thrown?.message).toContain('(cause: boom)');
        expect(((thrown?.cause as Error).cause as Error).message).toBe('boom');
    });

    it('gives a crash to the call it happened under, with others in flight', async () => {
        const visitor = app.visitor();
        const [fine, crashed, alsoFine] = await Promise.all([
            visitor.apiOutcome('slow.ok', {}),
            visitor.apiOutcome('crash', {}),
            visitor.apiOutcome('slow.ok', {}),
        ]);

        assertApiSuccess(fine);
        assertApiSuccess(alsoFine);
        assertApiFailure(crashed, 'server');
        expect((crashed.error.cause as Error).message).toBe('boom');
        expect(app.crashes.length).toBe(1);
    });

    it('records what a route threw, under whatever page answered it', async () => {
        const broken = await app.visitor().request('GET', '/broken');
        expect(broken.statusCode).toBe(500);
        expect(app.crashes.map((error) => error.message)).toEqual(['the page broke']);
    });

    it('leaves what the app\'s own error handler answers alone, and still says what was thrown', async () => {
        const handled = lambderTestApp(initLambder().create({})
            .addApi('crash', { input: z.object({}), output: z.any() }, async () => { throw new Error('boom'); })
            .setGlobalErrorHandler((_err, _ctx, res) => res.api(null, { errorMessage: 'Something went wrong on our side.' })));

        const outcome = await handled.visitor().apiOutcome('crash', {});
        assertApiFailure(outcome, 'errorMessage');
        expect(outcome.errorMessage).toEqual({ type: 'error', content: 'Something went wrong on our side.' });
        expect(handled.crashes.map((error) => error.message)).toEqual(['boom']);
    });

    it('counts a refusal as an answer rather than a crash, and forgets crashes on reset', async () => {
        assertApiFailure(await app.visitor().apiOutcome('me', {}), 'sessionExpired');
        expect(app.crashes).toEqual([]);

        await app.visitor().apiOutcome('crash', {});
        app.reset();
        expect(app.crashes).toEqual([]);
    });
});

describe('lambderTestApp: reset', () => {
    afterEach(() => app.reset());

    it('rewinds sessions, counters, replay records and every visitor\'s cookies', async () => {
        const visitor = await app.signIn('ada', { userId: 'ada', role: 'member' });
        expect(await visitor.api('limited', {})).toEqual({ ok: true });
        expect(await visitor.api('order.create', { sku: 'a' }, { idempotencyKey: 'key-0123456789abcdef' })).toEqual({ orderNumber: 1 });
        expect(visitor.jar.size).toBe(2);

        app.reset();

        expect(visitor.jar.size).toBe(0);
        expect((app.sessionStore as LambderMemorySessionStore<SessionData>).size).toBe(0);
        expect(await visitor.api('limited', {})).toEqual({ ok: true });
        // A new run rather than a replay: the record went with the reset.
        expect(await visitor.api('order.create', { sku: 'a' }, { idempotencyKey: 'key-0123456789abcdef' })).toEqual({ orderNumber: 2 });
        assertApiFailure(await visitor.apiOutcome('me', {}), 'sessionExpired');
    });

    it('lets a visitor made before a reset sign in again after it', async () => {
        const visitor = await app.signIn('ada', { userId: 'ada', role: 'member' });
        app.reset();
        await visitor.signIn('bob', { userId: 'bob', role: 'member' });
        expect(await visitor.api('me', {})).toMatchObject({ userId: 'bob' });
    });
});

describe('LambderTestVisitor.request: everything that is not an API call', () => {
    it('reaches a route with its path params, the path\'s own query and the visitor\'s headers', async () => {
        const visitor = app.visitor({ headers: { 'x-country': 'US' } });
        const page = await visitor.request('GET', '/hello/ada?q=one');
        expect(page.statusCode).toBe(200);
        expect(page.headers['content-type']).toContain('text/html');
        expect(page.text()).toBe('<p>Hello ada, q=one, country=US</p>');

        const overridden = await visitor.request('GET', '/hello/ada?q=one', { query: { q: 'two' }, headers: { 'x-country': 'CA' } });
        expect(overridden.text()).toBe('<p>Hello ada, q=two, country=CA</p>');
    });

    it('hands back a redirect rather than following it', async () => {
        const moved = await app.visitor().request('GET', '/old');
        expect(moved.statusCode).toBe(302);
        expect(moved.headers.location).toBe('/hello/moved');
    });

    it('keeps the cookies a route sets and presents them on the next request', async () => {
        const visitor = app.visitor();
        expect((await visitor.request('GET', '/theme')).json()).toEqual({ theme: null });
        await visitor.request('GET', '/remember');
        expect(visitor.jar.get('theme')).toBe('dark');
        expect((await visitor.request('GET', '/theme')).json()).toEqual({ theme: 'dark' });
        // Another visitor is another browser.
        expect((await app.visitor().request('GET', '/theme')).json()).toEqual({ theme: null });
    });

    it('presents a signed-in visitor\'s session to a session route, and a stranger none', async () => {
        const visitor = await app.signIn('ada', { userId: 'ada', role: 'member' });
        const account = await visitor.request('GET', '/account');
        expect(account.text()).toBe('account of ada');
        expect((await app.visitor().request('GET', '/account')).statusCode).not.toBe(200);
    });

    it('shares one jar between api calls and requests', async () => {
        const visitor = app.visitor();
        await visitor.api('login', { user: 'ada' });
        expect((await visitor.request('GET', '/account')).text()).toBe('account of ada');
    });

    it('sends a body', async () => {
        const posted = await app.visitor().request('POST', '/form', { body: JSON.stringify({ name: 'Ada' }) });
        expect(posted.json()).toEqual({ got: { name: 'Ada' } });
    });

    it('serves the app\'s public files, decompressed', async () => {
        const css = await app.visitor().request('GET', '/main.css');
        expect(css.statusCode).toBe(200);
        expect(css.headers['content-type']).toContain('text/css');
        expect(css.text().length).toBeGreaterThan(0);
    });
});

describe.each(['v2', 'v1'] as const)('lambderTestApp on %s events', (eventFormat) => {
    // Everything that travels differently in the two gateway shapes: cookies
    // (an array, or a Cookie header), the query, headers, the body, the
    // address the gateway observed, and the answer's own cookies on the way
    // back (a cookies array, or a multi-value Set-Cookie header).
    const formatted = lambderTestApp(createApp(), { eventFormat });

    it('calls the handler with the shape asked for', async () => {
        const seen = lambderTestApp(initLambder().create({}).addRoute('/shape', (ctx, res) => res.json({ format: ctx.eventFormat, version: (ctx.event as { version?: string }).version ?? null })), { eventFormat });
        expect((await seen.visitor().request('GET', '/shape')).json()).toEqual({ format: eventFormat, version: eventFormat === 'v2' ? '2.0' : null });
    });

    it('carries a session through api calls and session routes alike', async () => {
        const visitor = await formatted.signIn('ada', { userId: 'ada', role: 'admin' });
        expect(await visitor.api('me', {})).toMatchObject({ userId: 'ada' });
        expect(await visitor.api('admin.only', {})).toEqual({ ok: true });
        expect((await visitor.request('GET', '/account')).text()).toBe('account of ada');
        assertApiFailure(await formatted.visitor().apiOutcome('me', {}), 'sessionExpired');
    });

    it('keeps the cookies an answer sets, from a login api and from a route', async () => {
        const visitor = formatted.visitor();
        await visitor.api('login', { user: 'bob' });
        expect(visitor.jar.size).toBe(2);
        expect((await visitor.request('GET', '/account')).text()).toBe('account of bob');

        await visitor.request('GET', '/remember');
        expect((await visitor.request('GET', '/theme')).json()).toEqual({ theme: 'dark' });
    });

    it('delivers the query, the headers, the body, the host and the address', async () => {
        const visitor = formatted.visitor({ host: 'shop.test', clientIp: '198.51.100.9', headers: { 'x-country': 'US' } });
        expect((await visitor.request('GET', '/hello/ada?q=one')).text()).toBe('<p>Hello ada, q=one, country=US</p>');
        expect((await visitor.request('POST', '/form', { body: JSON.stringify({ name: 'Ada' }) })).json()).toEqual({ got: { name: 'Ada' } });
        expect(await visitor.api('echo', { text: 'hi' })).toEqual({ text: 'hi', ip: '198.51.100.9', host: 'shop.test', country: 'US' });
    });

    it('decodes what comes back: a redirect, a compressed file, a refusal with its status', async () => {
        const visitor = formatted.visitor();
        expect((await visitor.request('GET', '/old')).headers.location).toBe('/hello/moved');
        expect((await visitor.request('GET', '/main.css')).headers['content-type']).toContain('text/css');
        await visitor.api('limited', {});
        assertApiFailure(await visitor.apiOutcome('limited', {}), 'errorMessage', { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
    });

    it('decodes the path once whatever host the visitor browses, a Function URL\'s included', async () => {
        // Regression: a 2.0 event arrives with its path decoded, and the app
        // told a Function URL's event (whose path arrives encoded) by its
        // domain alone, so a visitor on a lambda-url host had the path
        // decoded again: `/%2561dmin` reached `/admin`.
        const seenPaths: string[] = [];
        const guarded = lambderTestApp(initLambder().create({})
            .addRoute('/admin', (ctx, res) => res.text('admin'))
            .setRouteFallbackHandler((ctx, res) => { seenPaths.push(ctx.path); return res.text('other', { statusCode: 404 }); }),
        { eventFormat, host: 'abc.lambda-url.us-east-1.on.aws' });
        const answer = await guarded.visitor().request('GET', '/%2561dmin');
        expect(answer.statusCode).toBe(404);
        expect(seenPaths).toEqual(['/%2561dmin']);
    });
});

describe('LambderTestApp.event: what is not an HTTP request', () => {
    it('runs the matching action with a Lambda context filled in, and resolves to what it returned', async () => {
        const event = { source: 'aws.events', 'detail-type': 'Scheduled Event' };
        expect(await app.event(event)).toEqual({ ran: true, functionName: 'lambder-test' });
        expect(scheduledRuns).toEqual([event]);
        expect(await app.event(event, { functionName: 'nightly' })).toMatchObject({ functionName: 'nightly' });
    });

    it('rejects as the handler does when no action matches', async () => {
        await expect(app.event({ source: 'nobody.listens' })).rejects.toThrow();
    });
});

describe('lambderTestApp: hosts, cookie domains and cookie names', () => {
    const createScopedApp = () => {
        const scoped = initLambder<SessionData>().create({
            session: {
                store: productionSessionStore,
                sessionSalt: 'salt',
                cookie: { domain: '.example.com' },
                tokenCookieKey: 'APPSESSION',
                csrfCookieKey: 'APPCSRF',
            },
        }).addSessionApi('me', { input: z.object({}), output: z.object({ userId: z.string() }) },
            async (ctx, res) => res.api({ userId: ctx.session.data.userId }));
        return scoped;
    };

    it('signs in on a host the app\'s cookie domain covers, under the app\'s own cookie names', async () => {
        const scoped = lambderTestApp(createScopedApp(), { host: 'app.example.com' });
        const visitor = await scoped.signIn('ada', { userId: 'ada', role: 'member' });
        expect(visitor.jar.list().map((cookie) => cookie.name).sort()).toEqual(['APPCSRF', 'APPSESSION']);
        expect(await visitor.api('me', {})).toEqual({ userId: 'ada' });
        // One session across the app's subdomains, which is what the domain is for.
        expect(visitor.jar.cookiePairs({ host: 'admin.example.com' }).length).toBe(2);
    });

    it('says why when the cookies do not stick, instead of answering sessionExpired for ever', async () => {
        const scoped = lambderTestApp(createScopedApp());
        await expect(scoped.signIn('ada', { userId: 'ada', role: 'member' })).rejects.toThrow(/did not stick for host "localhost"/);
        // A visitor may name the host itself.
        const visitor = await scoped.signIn('ada', { userId: 'ada', role: 'member' }, { host: 'app.example.com' });
        expect(await visitor.api('me', {})).toEqual({ userId: 'ada' });
    });
});

describe('lambderTestApp: the files option', () => {
    it('puts another source under an app whose own one a test cannot read', async () => {
        const unreachable = { read: async (): Promise<never> => { throw new Error('a test reached the production bucket'); } };
        const served = initLambder().create({ files: unreachable }).servePublicFiles();
        // Read once through the production source first, so the swap has a warm reader to replace.
        const before = await lambderTestApp(served).visitor().request('GET', '/main.css');
        expect(before.statusCode).toBe(500);

        const fixtures = lambderTestApp(served, { files: new LambderLocalFileSource({ root: './tests/fixtures/public' }) });
        const css = await fixtures.visitor().request('GET', '/main.css');
        expect(css.statusCode).toBe(200);
    });

    it('refuses the option on an app that reads no files', () => {
        expect(() => lambderTestApp(initLambder().create({}), { files: new LambderLocalFileSource({ root: './tests/fixtures/public' }) }))
            .toThrow(/created without one/);
    });
});

describe('assertApiSuccess / assertApiFailure', () => {
    it('narrow the outcome, so what it carries reads on the next line', async () => {
        const visitor = app.visitor();
        const echoed = await visitor.apiOutcome('echo', { text: 'hi' });
        assertApiSuccess(echoed);
        expect(echoed.payload?.text).toBe('hi');

        const invalid = await visitor.apiOutcome('echo', { text: 42 as unknown as string });
        assertApiFailure(invalid, 'validation');
        expect(invalid.zodError.issues[0]?.path).toEqual(['text']);

        const crashed = await visitor.apiOutcome('crash', {});
        assertApiFailure(crashed, 'server', { status: 500 });
        expect(crashed.error).toBeInstanceOf(Error);

        const refused = await visitor.apiOutcome('me', {});
        assertApiFailure(refused);
        expect(refused.reason).toBe('sessionExpired');
    });

    it('say what the outcome was when it is not what was expected', async () => {
        const visitor = app.visitor();
        const member = await app.signIn('bob', { userId: 'bob', role: 'member' });

        const success = await visitor.apiOutcome('echo', { text: 'hi' });
        expect(() => assertApiFailure(success, 'notAuthorized'))
            .toThrow('Expected the call to fail with reason "notAuthorized", but it was a success carrying {"text":"hi"');

        const refused = await member.apiOutcome('admin.only', {});
        expect(() => assertApiSuccess(refused))
            .toThrow(/Expected the call to succeed, but it was a failure with reason "notAuthorized", status 200, errorMessage .*"code":"app\/wrong-role"/);
        expect(() => assertApiFailure(refused, 'sessionExpired')).toThrow(/reason "sessionExpired", but it was a failure with reason "notAuthorized"/);
        expect(() => assertApiFailure(refused, 'notAuthorized', { code: 'app/other' })).toThrow(/code "app\/other"/);
        expect(() => assertApiFailure(refused, 'notAuthorized', { status: 403 })).toThrow(/status 403/);

        const crashed = await visitor.apiOutcome('crash', {});
        expect(() => assertApiSuccess(crashed)).toThrow(/reason "server", status 500/);
    });
});

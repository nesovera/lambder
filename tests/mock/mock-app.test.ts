/**
 * LambderMockApp at runtime, driven through a real LambderCaller over the
 * mock transport: answers, refusals, crashes, sessions carried by a cookie
 * jar, guards, rate limits, idempotency, the version gate, compressed
 * payloads, failure injection, latency, overrides, reset, the subscription
 * and the call log.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { apiNameKeyOf, type LambderApiSignatureMap } from '../../src/shared/wire/LambderApiSignatureMap.js';
import { LambderMockTransportError } from '../../src/mock/LambderMockFailureInjector.js';
import { z } from 'zod';
import LambderCaller from '../../src/client/LambderCaller.js';
import { createIdempotencyKey } from '../../src/shared/wire/LambderIdempotencyKeyScope.js';
import { initLambderMock } from '../../src/mock/LambderMockApp.js';
import { lambderMockMswHandler } from '../../src/mock/lambderMockMswHandler.js';
import { lambderMockInvokeTransport } from '../../src/mock/lambderMockInvokeTransport.js';
import type { LambderMockCallEvent } from '../../src/mock/LambderMockTypes.js';
import { LambderCookieJar } from '../../src/shared/transport/LambderCookieJar.js';
import { refuse, LAMBDER_REFUSAL_CODES } from '../../src/shared/wire/LambderApiRefusal.js';
import { LambderPlainSessionCrypto } from '../../src/session/LambderSessionCrypto.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import type { LambderSessionStore } from '../../src/shared/contracts/LambderSessionStore.js';
import type { LambderApiTransport } from '../../src/shared/transport/LambderApiTransport.js';
import { assertApiSuccess, assertApiFailure, assertApiRefusal } from '../../src/shared/wire/LambderOutcomeAssertions.js';
import type { LambderApiOptionEntry, LambderGuardDeclarationEntry } from '../../src/shared/wire/LambderApiOptionEntries.js';
import { apiCallPath } from '../../src/shared/wire/LambderApiNames.js';

type SessionData = { userId: string; tenants: { tenantId: string; role: 'reader' | 'writer' }[] };

/** The contract as a consuming app imports it: a type, nothing else. */
type Contract = {
    'user.get': { input: { userId: string }; output: { id: string; name: string }; mode: 'public'; refusals: { 'app/user-archived': { data: { since: string; by: string; days: number } } } };
    'account.login': { input: { user: string }; output: { ok: boolean }; mode: 'public' };
    'account.logout': { input: {}; output: { ok: boolean }; mode: 'session'; guards: 'signedIn' };
    'account.me': { input: {}; output: { userId: string }; mode: 'session'; guards: 'signedIn' };
    'order.create': {
        input: { qty: number }; output: { orderId: string; qty: number }; mode: 'session';
        refusals: { 'app/not-a-member': {}; 'app/read-only': {} };
        guards: { tenant: 'writer' }; guardInputs: { tenant: { tenantId: string } }; idempotency: true;
    };
    'tools.limited': { input: {}; output: { n: number }; mode: 'public'; rateLimit: 'tight' };
    'ticket.buy': { input: { seat: string }; output: { ticketId: string }; mode: 'public'; idempotency: true };
    'tools.echo': { input: { notes: string[] }; output: { count: number }; mode: 'public' };
    'admin.run': { input: {}; output: {}; mode: 'public' };
    'admin.audit': { input: {}; output: {}; mode: 'session'; guards: 'signedIn' };
};

const mock = initLambderMock<Contract, SessionData>();

/**
 * The guard map every app in this file declares. The contract names guards,
 * so the `guards` option is not optional: a mock that leaves it out cannot run
 * the guard the server runs, which is the whole point of restating it. Both
 * need a session, so an entry restating either is a session endpoint, as on
 * the server.
 */
const mockGuards = {
    signedIn: mock.guard({ session: true, handler: () => {} }),
    tenant: mock.guard({
        guardInput: z.object({ tenantId: z.string() }),
        session: true,
        handler: (ctx, { tenantId }, role: 'reader' | 'writer') => {
            const membership = ctx.session.data.tenants.find((tenant) => tenant.tenantId === tenantId);
            if(!membership) refuse('Not a member.', { code: 'app/not-a-member', notAuthorized: true });
            if(role === 'writer' && membership.role !== 'writer') refuse('Read-only member.', { code: 'app/read-only' });
            return membership;
        },
    }),
};

/**
 * What the contract makes create() require beside the guard map: it has
 * session, idempotent and rate-limited endpoints. An app built without one on
 * purpose, to pin the runtime refusal a plain-JS caller still meets, says so
 * with @ts-expect-error.
 */
const requiredOptions = {
    guards: mockGuards,
    sessions: true,
    idempotency: true,
    rateLimits: { policies: { tight: { perMin: 2, per: 'ip' } } },
} as const;

/**
 * The table writeApiOptions would write for this file's contract: `as const`,
 * as the generated module is. Given it, the mock reads every entry's mode off
 * it, a notMocked entry's and a rest answer's included, which nothing else can
 * tell the mock at runtime.
 */
const contractOptions = {
    'user.get': { mode: 'public', refusals: 'app/user-archived' },
    'account.login': { mode: 'public' },
    'account.logout': { mode: 'session', guards: 'signedIn' },
    'account.me': { mode: 'session', guards: 'signedIn' },
    'order.create': { mode: 'session', guards: { tenant: 'writer' }, idempotency: true },
    'tools.limited': { mode: 'public', rateLimit: 'tight' },
    'ticket.buy': { mode: 'public', idempotency: true },
    'tools.echo': { mode: 'public' },
    'admin.run': { mode: 'public' },
    'admin.audit': { mode: 'session', guards: 'signedIn' },
} as const satisfies Record<string, LambderApiOptionEntry>;

/** The guard declarations writeApiOptions would write beside the table: the two session guards, and the codes the tenant guard refuses with. */
const contractGuardDeclarations = {
    signedIn: { input: 'none', session: true, runAt: 'beforeInputValidation' },
    tenant: { input: 'guardInput', session: true, runAt: 'beforeInputValidation', refusals: ['app/not-a-member', 'app/read-only'] },
} as const satisfies Record<string, LambderGuardDeclarationEntry>;

/**
 * The generated map the callers under test carry, filled once the names are
 * hashed. Three endpoints are enough to exercise the gate; a caller given
 * this map calls only these.
 */
const mockSignatures: LambderApiSignatureMap = {};
beforeAll(async () => {
    for(const name of ['user.get', 'admin.run', 'tools.limited']) mockSignatures[await apiNameKeyOf(name)] = `mock-signature-of-${name}`;
});

const createMockApp = (options: { apiVersion?: string; latency?: number } = {}) => {
    const mockApp = mock.create({
        apiVersion: options.apiVersion,
        apiSignatures: mockSignatures,
        latency: options.latency,
        sessions: true,
        idempotency: true,
        rateLimits: { policies: { tight: { perMin: 2, per: 'ip' } } },
        guards: mockGuards,
    });
    let orderRuns = 0;
    mockApp.register(
        mockApp.apiSlice(
            mockApp.api('user.get', async ({ payload }) => ({ id: payload.userId, name: 'Ada' })),
            mockApp.api('account.login', async ({ payload, sessionController }) => {
                await sessionController.createSession(payload.user, { userId: payload.user, tenants: [{ tenantId: 't1', role: payload.user === 'ada' ? 'writer' : 'reader' }] });
                return { ok: true };
            }),
            mockApp.api('account.logout', { guards: 'signedIn', handler: async ({ sessionController }) => { await sessionController.endSession(); return { ok: true }; } }),
            mockApp.api('account.me', { guards: 'signedIn', handler: async ({ session }) => ({ userId: session.data.userId }) }),
            mockApp.api('order.create', {
                guards: { tenant: 'writer' },
                idempotency: true,
                handler: async ({ payload, guardData }) => {
                    orderRuns += 1;
                    return { orderId: `o-${guardData.tenant.tenantId}-${orderRuns}`, qty: payload.qty };
                },
            }),
            mockApp.api('tools.limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) }),
            mockApp.api('ticket.buy', { idempotency: true, handler: async ({ payload }) => ({ ticketId: `t-${payload.seat}` }) }),
            mockApp.api('tools.echo', async ({ payload }) => ({ count: payload.notes.length })),
        ),
        mockApp.apiSlice(
            mockApp.notMocked('admin.run', 'operator endpoint, no client calls it'),
            mockApp.notMocked('admin.audit', { reason: 'operator endpoint, no client calls it', guards: 'signedIn' }),
        ),
    );
    return { mockApp, orderRuns: () => orderRuns };
};

const callerFor = (mockApp: Pick<ReturnType<typeof createMockApp>['mockApp'], 'transport'>, options: { jar?: LambderCookieJar; apiVersion?: string; apiSignatures?: LambderApiSignatureMap; timeoutMs?: number } = {}) =>
    new LambderCaller<Contract>({
        apiPath: '/api', isCorsEnabled: false, apiVersion: options.apiVersion, apiSignatures: options.apiSignatures, timeoutMs: options.timeoutMs,
        transport: mockApp.transport(options.jar ? { cookies: options.jar } : {}),
    });

describe('LambderMockApp - answers', () => {
    it('answers a mocked endpoint with the contract envelope, the payload typed both ways', async () => {
        const { mockApp } = createMockApp({ apiVersion: '3' });
        const caller = callerFor(mockApp, { apiVersion: '3' });
        const outcome = await caller.apiOutcome('user.get', { userId: '42' });
        assertApiSuccess(outcome);
        expect(outcome.payload).toEqual({ id: '42', name: 'Ada' });
        expect(outcome.response.apiVersion).toBe('3');
    });

    it('a name the registry does not know answers the apiNotFound refusal, as the server does', async () => {
        const { mockApp } = createMockApp();
        const outcome = await (callerFor(mockApp) as LambderCaller<any>).apiOutcome('user.unknown', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) return;
        expect(outcome.reason).toBe('refusal');
        expect(outcome.refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.apiNotFound });
        expect(mockApp.calls.at(-1)?.outcome).toBe('unknownApi');
    });

    it('a notMocked endpoint answers a refusal naming the reason', async () => {
        const { mockApp } = createMockApp();
        const outcome = await callerFor(mockApp).apiOutcome('admin.run', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) return;
        expect(outcome.refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.notMocked, content: expect.stringContaining('operator endpoint') });
        expect(mockApp.calls.at(-1)?.outcome).toBe('notMocked');
    });

    it('a registration that throws leaves nothing registered, so the retry sees the real problem', async () => {
        // Adding slices one entry at a time would leave the earlier ones
        // registered when a later one fails a check, and a caller that fixed
        // its slices and called again would hit a duplicate-name error from
        // its own first attempt instead of the problem it fixed.
        const bare = mock.create({ ...requiredOptions });
        const good = bare.apiSlice(bare.api('tools.echo', async ({ payload }) => ({ count: payload.notes.length })));
        const clashing = bare.apiSlice(bare.api('tools.echo', async ({ payload }) => ({ count: payload.notes.length })));

        expect(() => bare.registerPartial(good, clashing)).toThrow(/more than one slice/);
        expect(bare.registeredNames).toEqual([]);
        // And the fixed call goes through, rather than tripping on the remains.
        expect(() => bare.registerPartial(good)).not.toThrow();
        expect(bare.registeredNames).toEqual(['tools.echo']);
    });

    it('a session endpoint left unmocked is still refused for having no session, its mode read off the apiOptions table or the guards it restates', async () => {
        // The refusal runs through the pipeline so the steps before dispatch
        // still happen, and the session read is one of them. With the table,
        // the table is what makes it a session endpoint: read as public, this
        // would answer "not mocked" where the server answers sessionExpired,
        // a different bug to go looking for.
        const app = mock.create({ ...requiredOptions, apiOptions: contractOptions, guardDeclarations: contractGuardDeclarations });
        app.registerPartial(app.apiSlice(app.notMocked('admin.audit', 'operator endpoint, no client calls it')));

        const outcome = await callerFor(app).apiOutcome('admin.audit', {});

        assertApiFailure(outcome, 'sessionExpired');
        expect(app.calls.at(-1)?.outcome).toBe('sessionExpired');
        // And the mode it reports is the endpoint's own.
        expect(app.calls.at(-1)?.mode).toBe('session');

        // Without the table the entry restates its guards, which say it by
        // the server's rule: signedIn needs a session.
        const { mockApp } = createMockApp();
        assertApiFailure(await callerFor(mockApp).apiOutcome('admin.audit', {}), 'sessionExpired');
        expect(mockApp.calls.at(-1)?.mode).toBe('session');
        // Restated beside the table, the guards would be a second copy of the declaration.
        expect(() => app.notMocked('admin.audit', { reason: 'operator endpoint', guards: 'signedIn' } as never))
            .toThrow('LambderMockApp: "admin.audit" restates its guards option, which the apiOptions table given to create() already declares. Leave it out of the entry.');
    });

    it('a notMocked endpoint still meets the protocol steps that run before dispatch', async () => {
        // It refuses where the handler would have run rather than ahead of
        // the pipeline, so a stale caller hears what it hears from the
        // server (reload, not "not mocked yet"), and the compressed payload
        // is restored in time to appear on the call log.
        const { mockApp } = createMockApp({ apiVersion: '2' });
        const stale = await callerFor(mockApp, { apiSignatures: { ...mockSignatures, [await apiNameKeyOf('admin.run')]: 'an-older-shape' } }).apiOutcome('admin.run', {});
        assertApiFailure(stale, 'versionExpired');
        expect(mockApp.calls.at(-1)?.outcome).toBe('versionExpired');

        const current = await callerFor(mockApp, { apiSignatures: mockSignatures }).apiOutcome('admin.run', {});
        assertApiFailure(current);
        expect(current.refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.notMocked });

        const compressing = new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false, apiVersion: '2', requestCompression: true, transport: mockApp.transport(),
        });
        const notes = Array.from({ length: 300 }, (_, i) => `note-${i} on the main line`);
        await compressing.apiOutcome('admin.run', { notes } as never);
        expect(mockApp.calls.at(-1)?.payload).toEqual({ notes });
    });

    it('a handler that throws crashes the call: a 500 envelope for the caller, the error on the event', async () => {
        const { mockApp } = createMockApp();
        mockApp.override('user.get', async () => { throw new Error('boom'); });
        const outcome = await callerFor(mockApp).apiOutcome('user.get', { userId: '1' });
        expect(outcome.ok).toBe(false);
        if(outcome.ok) return;
        expect(outcome.reason).toBe('server');
        expect(outcome.status).toBe(500);
        const last = mockApp.calls.at(-1)!;
        expect(last.outcome).toBe('crash');
        expect(last.error?.message).toBe('boom');
    });

    it('a handler that refuses answers the refusal envelope, status and headers included', async () => {
        const { mockApp } = createMockApp();
        mockApp.override('user.get', async () => refuse('Gone.', { code: 'app/gone', statusCode: 410, headers: { 'X-Reason': 'deleted' } }));
        const answer = await mockApp.handle({ apiPath: '/api', apiName: 'user.get', token: '', siteHost: '', payload: { userId: '1' } });
        expect(answer.statusCode).toBe(410);
        expect(answer.headers['X-Reason']).toEqual(['deleted']);
        expect(JSON.parse(answer.body).refusal).toEqual({ type: 'warning', code: 'app/gone', content: 'Gone.' });
        expect(mockApp.calls.at(-1)?.outcome).toBe('refusal');
    });

    it('a handler answering anything but an object or an array crashes, as on the server', async () => {
        const { mockApp } = createMockApp();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        for(const answered of [undefined, null, 'Ada']){
            mockApp.override('user.get', async () => answered as never);
            const outcome = await callerFor(mockApp).apiOutcome('user.get', { userId: '1' });
            expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 500 });
            expect(mockApp.calls.at(-1)).toMatchObject({ outcome: 'crash', error: { name: 'LambderApiOutputValidationError' } });
        }
        vi.restoreAllMocks();
    });

    it('a compressed request payload is restored before the handler sees it', async () => {
        const { mockApp } = createMockApp();
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, requestCompression: true, transport: mockApp.transport() });
        const notes = Array.from({ length: 300 }, (_, i) => `note-${i} on the main line`);
        expect(await caller.api('tools.echo', { notes })).toEqual({ count: 300 });
        expect(mockApp.calls.at(-1)?.payload).toEqual({ notes });
    });
});

describe('LambderMockApp - sessions', () => {
    it('a login handler creates a session through ctx.sessionController and the jar carries it into the next call', async () => {
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        expect((await callerFor(mockApp).apiOutcome('account.me', {})).ok).toBe(false);

        expect(await caller.api('account.login', { user: 'ada' })).toEqual({ ok: true });
        expect(await caller.api('account.me', {})).toEqual({ userId: 'ada' });
        expect(mockApp.sessionStore?.size).toBe(1);
    });

    it('two transports are two browsers: each holds its own session', async () => {
        const { mockApp } = createMockApp();
        const ada = callerFor(mockApp);
        const bob = callerFor(mockApp);
        await ada.api('account.login', { user: 'ada' });
        await bob.api('account.login', { user: 'bob' });
        expect(await ada.api('account.me', {})).toEqual({ userId: 'ada' });
        expect(await bob.api('account.me', {})).toEqual({ userId: 'bob' });

        const stranger = await callerFor(mockApp).apiOutcome('account.me', {});
        assertApiFailure(stranger, 'sessionExpired');
    });

    it('logout ends the session and clears the cookies, so the next call is signed out', async () => {
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        await caller.api('account.login', { user: 'ada' });
        expect(await caller.api('account.logout', {})).toEqual({ ok: true });
        const after = await caller.apiOutcome('account.me', {});
        assertApiFailure(after, 'sessionExpired');
        expect(mockApp.sessionStore?.size).toBe(0);
    });

    it('signIn plants a session into a jar without a login endpoint; signOut ends it everywhere', async () => {
        const { mockApp } = createMockApp();
        const jar = new LambderCookieJar();
        const created = await mockApp.signIn('ada', { userId: 'ada', tenants: [] }, { jar });
        expect(created.sessionToken).toMatch(/:/);
        expect(jar.get(mockApp.csrfCookieKey)).toBe(created.csrfToken);
        expect(jar.get(mockApp.tokenCookieKey)).toBeUndefined();
        expect(jar.get(mockApp.tokenCookieKey, { includeHttpOnly: true })).toBe(created.sessionToken);

        const caller = callerFor(mockApp, { jar });
        expect(await caller.api('account.me', {})).toEqual({ userId: 'ada' });

        await mockApp.signOut('ada');
        const after = await caller.apiOutcome('account.me', {});
        expect(after.ok).toBe(false);
    });

    it('signIn plants a cookie carrying a Domain, so an app with a cookie domain still signs in', async () => {
        // A jar checks every Domain against the host that sent it and refuses
        // one it cannot check, so cookies planted without naming that host
        // would be dropped and the session would never carry.
        const domained = mock.create({ ...requiredOptions, cookieHost: 'app.example.com', sessions: { cookieOptions: { domain: 'example.com' } } });
        domained.registerPartial(domained.apiSlice(
            domained.api('account.me', { guards: 'signedIn', handler: async ({ session }) => ({ userId: session.data.userId }) }),
        ));
        const jar = new LambderCookieJar();
        await domained.signIn('ada', { userId: 'ada', tenants: [] }, { jar, host: 'app.example.com' });
        expect(jar.list().map((cookie) => cookie.domain)).toEqual(['example.com', 'example.com']);

        const caller = new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false, transport: domained.transport({ cookies: jar }),
        });
        expect(await caller.api('account.me', {})).toEqual({ userId: 'ada' });
    });

    it('every session member names the mock\'s own sessions option when it is off', async () => {
        // The pipeline's own message names the SERVER's option ("the session
        // option"). The mock's option is `sessions`, and a reader who goes
        // looking for `session` on create() would not find it.
        // @ts-expect-error the contract has session endpoints; built without sessions on purpose, as a plain-JS caller could
        const bare = mock.create({ ...requiredOptions, sessions: false });

        await expect(bare.signIn('ada', { userId: 'ada', tenants: [] }))
            .rejects.toThrow('LambderMockApp: signIn() needs the sessions option at creation.');
        await expect(bare.signOut('ada'))
            .rejects.toThrow('LambderMockApp: signOut() needs the sessions option at creation.');
        await expect(bare.expireSessionData('ada'))
            .rejects.toThrow('LambderMockApp: expireSessionData() needs the sessions option at creation.');
        expect(() => bare.sessionManager)
            .toThrow('LambderMockApp: sessionManager needs the sessions option at creation.');
    });

    it('picks the plain crypto for a memory-only store the app supplied, not only for one it created', async () => {
        // The store's own isMemoryOnly decides, not whether this runtime
        // created the store. Otherwise an app passing its own memory store on
        // a plain-http page (device testing on a LAN, no crypto.subtle) would
        // get WebCrypto and throw on its first session call, where the
        // default path degrades.
        const globals = globalThis as unknown as { crypto?: unknown };
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: undefined }, configurable: true, writable: true });
        let plain: ReturnType<typeof mock.create>;
        try {
            plain = mock.create({ ...requiredOptions, sessions: { store: new LambderMemorySessionStore<SessionData>() } });
        } finally {
            if(descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globals.crypto;
        }

        const created = await plain.signIn('ada', { userId: 'ada', tenants: [] });

        // The stand-in hex-encodes the value as it is rather than hashing it,
        // which is what makes "this store is nothing anyone can leak" the
        // precondition for using it at all.
        const [sessionKeyHash] = created.sessionToken.split(':');
        expect(Buffer.from(sessionKeyHash!, 'hex').toString('utf8')).toBe('["lambder-mock","ada"]');
    });

    it('a session endpoint on a mock without sessions is refused at registration', () => {
        // @ts-expect-error the contract has session endpoints; built without sessions on purpose, as a plain-JS caller could
        const bare = mock.create({ ...requiredOptions, sessions: false });
        expect(() => bare.api('account.me', { guards: 'signedIn', handler: async () => ({ userId: 'x' }) })).toThrow(/needs the sessions option at creation/);
    });

    it('runs on the plain crypto stand-in where asked to', async () => {
        const plain = mock.create({ ...requiredOptions, sessions: { crypto: new LambderPlainSessionCrypto() } });
        plain.registerPartial(plain.apiSlice(
            plain.api('account.login', async ({ payload, sessionController }) => { await sessionController.createSession(payload.user, { userId: payload.user, tenants: [] }); return { ok: true }; }),
            plain.api('account.me', { guards: 'signedIn', handler: async ({ session }) => ({ userId: session.data.userId }) }),
        ));
        const caller = callerFor(plain);
        await caller.api('account.login', { user: 'ada' });
        expect(await caller.api('account.me', {})).toEqual({ userId: 'ada' });
    });
});

describe('LambderMockApp - guards, rate limits, idempotency, version', () => {
    it('runs the mock guard with the restated param: guardData lands typed, a refusal is rendered, a missing input is a 422', async () => {
        const { mockApp, orderRuns } = createMockApp();
        const ada = callerFor(mockApp);
        await ada.api('account.login', { user: 'ada' });

        const ok = await ada.apiOutcome('order.create', { qty: 2 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: 'k-order-one-abcdefabcdef' });
        expect(ok.ok).toBe(true);
        if(ok.ok) expect(ok.payload).toEqual({ orderId: 'o-t1-1', qty: 2 });
        expect(mockApp.calls.at(-1)?.guardsRun).toEqual(['tenant']);

        const notMember = await ada.apiOutcome('order.create', { qty: 2 }, { guardInputs: { tenant: { tenantId: 't9' } }, idempotencyKey: 'k-order-two-abcdefabcdef' });
        assertApiFailure(notMember, 'notAuthorized');

        const missing = await ada.apiOutcome('order.create', { qty: 2 }, { guardInputs: { tenant: {} as never }, idempotencyKey: 'k-order-three-abcdefabcdef' });
        expect(missing.ok).toBe(false);
        expect(missing.ok ? '' : missing.reason).toBe('validation');
        // Narrowed on the reason, which is what makes zodError readable
        // without a `!`: the failure arm carries the fields its own reason has.
        if(!missing.ok && missing.reason === 'validation') expect(missing.zodError.issues[0]?.path).toEqual(['tenantId']);
        expect(mockApp.calls.at(-1)?.outcome).toBe('validation');

        const bob = callerFor(mockApp);
        await bob.api('account.login', { user: 'bob' });
        const readOnly = await bob.apiOutcome('order.create', { qty: 1 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: 'k-order-four-abcdefabcdef' });
        assertApiFailure(readOnly);
        expect(readOnly.refusal).toMatchObject({ code: 'app/read-only' });
        expect(orderRuns()).toBe(1);
    });

    it('charges a policy from a handler through ctx.rateLimit, as a server handler does', async () => {
        const mockApp = mock.create({ ...requiredOptions, rateLimits: { policies: { tight: { perMin: 2, per: 'ip' }, perUser: { perMin: 1 } } } });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.api('user.get', async (ctx) => {
                await ctx.rateLimit('perUser', ctx.payload.userId);
                return { id: ctx.payload.userId, name: 'Ada' };
            }),
        ));
        const caller = callerFor(mockApp);
        expect(await caller.api('user.get', { userId: 'u1' })).toEqual({ id: 'u1', name: 'Ada' });
        assertApiFailure(await caller.apiOutcome('user.get', { userId: 'u1' }), 'refusal', { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
        expect(await caller.api('user.get', { userId: 'u2' })).toEqual({ id: 'u2', name: 'Ada' });
    });

    it('rate limits through the memory limiter, with Retry-After on the refusal', async () => {
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        expect(await caller.api('tools.limited', {})).toEqual({ n: 1 });
        expect(await caller.api('tools.limited', {})).toEqual({ n: 1 });
        const third = await caller.apiOutcome('tools.limited', {});
        expect(third.ok).toBe(false);
        if(third.ok) return;
        expect(third.status).toBe(429);
        expect(third.refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.rateLimited });
        expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(mockApp.calls.at(-1)?.outcome).toBe('rateLimited');
        expect(mockApp.rateLimiter?.countOf('api|tools.limited|tight|ip:127.0.0.1', 'perMin')).toBe(2);
    });

    it('replays an idempotent answer for a repeated key without running the handler again', async () => {
        const { mockApp, orderRuns } = createMockApp();
        const caller = callerFor(mockApp);
        await caller.api('account.login', { user: 'ada' });
        const key = createIdempotencyKey();
        const first = await caller.api('order.create', { qty: 5 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: key });
        const second = await caller.api('order.create', { qty: 5 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: key });
        expect(second).toEqual(first);
        expect(orderRuns()).toBe(1);
        expect(mockApp.calls.at(-1)?.outcome).toBe('replayed');
        expect(mockApp.idempotencyStore?.size).toBe(1);
    });

    it('an endpoint the contract declares no guards for still carries its idempotency restatement', async () => {
        // These two endpoints declare no guards, but a bare handler would still
        // leave them with no restatement: the handler would run twice for one
        // key where the server replays, and a rate-limited endpoint would
        // never answer 429. So the options form is the only form they have.
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        const key = createIdempotencyKey();

        const first = await caller.api('ticket.buy', { seat: 'A1' }, { idempotencyKey: key });
        const replay = await caller.api('ticket.buy', { seat: 'A1' }, { idempotencyKey: key });

        expect(replay).toEqual(first);
        expect(mockApp.calls.at(-1)?.outcome).toBe('replayed');

        // The same key for a different seat is another request, refused
        // rather than handed the first seat's ticket.
        const other = await caller.apiOutcome('ticket.buy', { seat: 'A2' }, { idempotencyKey: key });
        assertApiFailure(other, 'refusal', { code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused, status: 409 });
    });

    it('carries rateLimits.failOpen to the engine, so a limiter that throws can refuse the call', async () => {
        // A mock that failed open whatever the server it stands in for is
        // configured with would answer 200 here and 500 there for a failing
        // limiter of the app's own. Only observable with a limiter that
        // throws, which the memory limiter never does.
        const failingLimiter = { isRateLimited: async () => { throw new Error('the limiter is down'); } };
        const build = (failOpen?: boolean) => {
            const app = mock.create({
                ...requiredOptions,
                rateLimits: { limiter: failingLimiter, failOpen, policies: { tight: { perMin: 2, per: 'ip' } } },
            });
            app.registerPartial(app.apiSlice(app.api('tools.limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) })));
            return callerFor(app);
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(await build().api('tools.limited', {})).toEqual({ n: 1 });
        const refused = await build(false).apiOutcome('tools.limited', {});

        assertApiFailure(refused, 'server');
        error.mockRestore();
    });

    it('the signature gate answers versionExpired to a caller built against another shape, given the generated map', async () => {
        const { mockApp } = createMockApp({ apiVersion: '2' });
        const stale = await callerFor(mockApp, { apiSignatures: { ...mockSignatures, [await apiNameKeyOf('user.get')]: 'an-older-shape' } }).apiOutcome('user.get', { userId: '1' });
        assertApiFailure(stale, 'versionExpired');
        expect((await callerFor(mockApp, { apiSignatures: mockSignatures }).apiOutcome('user.get', { userId: '1' })).ok).toBe(true);
        // A caller that sends no signature is never gated, as on the server.
        expect((await callerFor(mockApp).apiOutcome('user.get', { userId: '1' })).ok).toBe(true);
        // A runtime given no map passes every signature: it holds no server
        // schema to judge one by.
        const ungated = mock.create({ ...requiredOptions });
        ungated.registerPartial(ungated.apiSlice(ungated.api('user.get', async ({ payload }) => ({ id: payload.userId, name: 'Ada' }))));
        expect((await callerFor(ungated, { apiSignatures: { [await apiNameKeyOf('user.get')]: 'whatever' } }).apiOutcome('user.get', { userId: '1' })).ok).toBe(true);
    });
});

describe('LambderMockApp - failure injection and latency', () => {
    it('failNext injects each transport and protocol failure once, in order, then the endpoint answers again', async () => {
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp, { timeoutMs: 50 });
        mockApp.failNext('user.get', 'network');
        mockApp.failNext('user.get', 'timeout');
        mockApp.failNext('user.get', 'server');
        mockApp.failNext('user.get', { reason: 'refusal', message: 'No.' });
        mockApp.failNext('user.get', 'notAuthorized');
        mockApp.failNext('user.get', 'sessionExpired');
        mockApp.failNext('user.get', 'versionExpired');
        mockApp.failNext('user.get', { reason: 'rateLimited', retryAfterSeconds: 7 });

        const reasons: string[] = [];
        for(let i = 0; i < 8; i += 1){
            const outcome = await caller.apiOutcome('user.get', { userId: '1' });
            reasons.push(outcome.ok ? 'ok' : outcome.reason);
            if(!outcome.ok && outcome.reason === 'refusal' && i === 3) expect(outcome.refusal).toEqual({ type: 'warning', content: 'No.' });
            if(!outcome.ok && i === 7) expect(outcome.retryAfterSeconds).toBe(7);
        }
        expect(reasons).toEqual(['network', 'timeout', 'server', 'refusal', 'notAuthorized', 'sessionExpired', 'versionExpired', 'refusal']);
        expect((await caller.apiOutcome('user.get', { userId: '1' })).ok).toBe(true);
        expect(mockApp.calls.filter((call) => call.outcome === 'injected').length).toBe(8);
    });

    it('setFailure persists until cleared; setOffline rejects every call', async () => {
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        mockApp.setFailure('user.get', 'server');
        expect((await caller.apiOutcome('user.get', { userId: '1' })).ok).toBe(false);
        expect((await caller.apiOutcome('user.get', { userId: '1' })).ok).toBe(false);
        mockApp.setFailure('user.get', null);
        expect((await caller.apiOutcome('user.get', { userId: '1' })).ok).toBe(true);

        mockApp.setOffline(true);
        const offline = await caller.apiOutcome('user.get', { userId: '1' });
        expect(offline.ok).toBe(false);
        expect(offline.ok ? '' : offline.reason).toBe('network');
        if(!offline.ok && offline.reason === 'network') expect(offline.error).toBeInstanceOf(LambderMockTransportError);
        mockApp.setOffline(false);
        expect((await caller.apiOutcome('user.get', { userId: '1' })).ok).toBe(true);
    });

    it('a queued failNext survives a call that never reached the handler', async () => {
        // Dequeued before the latency wait and the offline check, the failure
        // would be swallowed by an earlier, unrelated call, and the call that
        // was arranged to fail would answer normally.
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        mockApp.failNext('user.get', { reason: 'refusal', message: 'Queued.' });

        mockApp.setOffline(true);
        expect((await caller.apiOutcome('user.get', { userId: '1' })).ok).toBe(false);
        mockApp.setOffline(false);

        mockApp.setLatency(1000);
        const controller = new AbortController();
        const pending = caller.apiOutcome('user.get', { userId: '1' }, { signal: controller.signal });
        controller.abort();
        expect((await pending).ok).toBe(false);
        mockApp.setLatency(0);

        const refused = await caller.apiOutcome('user.get', { userId: '1' });
        assertApiFailure(refused);
        expect(refused.refusal).toEqual({ type: 'warning', content: 'Queued.' });
        expect((await caller.apiOutcome('user.get', { userId: '1' })).ok).toBe(true);
    });

    it('latency delays the answer and an abort cancels the wait', async () => {
        const { mockApp } = createMockApp({ latency: 30 });
        const caller = callerFor(mockApp);
        // On fake timers, so what is asserted is that the answer waits for the
        // configured latency and for nothing else. A wall-clock elapsed time
        // says both less and more than that: it passes on a machine that
        // slept, and fails on one that stalled.
        vi.useFakeTimers();
        try {
            let settled = false;
            const pending = caller.api('user.get', { userId: '1' });
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(29);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await pending).toEqual({ id: '1', name: 'Ada' });
            expect(mockApp.calls.at(-1)?.durationMs).toBeGreaterThanOrEqual(30);
        } finally {
            vi.useRealTimers();
        }

        mockApp.setLatency(1000);
        const controller = new AbortController();
        const pending = caller.apiOutcome('user.get', { userId: '1' }, { signal: controller.signal });
        controller.abort();
        const aborted = await pending;
        assertApiFailure(aborted, 'network');
    });
});

describe('LambderMockApp - overrides, reset, observation', () => {
    it('override replaces one handler and restores it through the handle it hands back', async () => {
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        const stub = mockApp.override('user.get', async () => ({ id: 'x', name: 'Stub' }));
        // Restore and nothing else: a [Symbol.dispose] member would make the
        // published .d.ts fail to compile for a consumer on lib: ES2022.
        expect(Object.keys(stub)).toEqual(['restore']);
        expect(await caller.api('user.get', { userId: '1' })).toEqual({ id: 'x', name: 'Stub' });
        stub.restore();
        expect(await caller.api('user.get', { userId: '1' })).toEqual({ id: '1', name: 'Ada' });

        mockApp.override('user.get', async () => ({ id: 'y', name: 'Other' }));
        mockApp.restoreOverrides();
        expect(await caller.api('user.get', { userId: '1' })).toEqual({ id: '1', name: 'Ada' });
    });

    it('overrides stack: restoring the inner one uncovers the outer, not the registry', async () => {
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        const outer = mockApp.override('user.get', async () => ({ id: 'outer', name: 'Outer' }));
        const inner = mockApp.override('user.get', async () => ({ id: 'inner', name: 'Inner' }));
        try {
            expect(await caller.api('user.get', { userId: '1' })).toEqual({ id: 'inner', name: 'Inner' });
        } finally {
            inner.restore();
        }
        // The inner override restored at the end of its scope must not take
        // the outer one with it, or a describe-scope stub silently vanishes
        // from the `it` after the one that scoped its own.
        expect(await caller.api('user.get', { userId: '1' })).toEqual({ id: 'outer', name: 'Outer' });

        outer.restore();
        outer.restore();   // restoring twice is a no-op, not a pop of somebody else's
        expect(await caller.api('user.get', { userId: '1' })).toEqual({ id: '1', name: 'Ada' });
    });

    it('an override restored on the way out of a throwing body restores only itself', async () => {
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        const outer = mockApp.override('user.get', async () => ({ id: 'outer', name: 'Outer' }));
        await expect((async () => {
            const inner = mockApp.override('user.get', async () => ({ id: 'inner', name: 'Inner' }));
            try {
                throw new Error('the body threw');
            } finally {
                inner.restore();
            }
        })()).rejects.toThrow('the body threw');
        expect(await caller.api('user.get', { userId: '1' })).toEqual({ id: 'outer', name: 'Outer' });
        outer.restore();
    });

    it('a slice whose key disagrees with its entry is refused at registration', () => {
        // The compile-time completeness check reads the keys and the runtime
        // reads entry.name, so a hand-written slice where the two disagree
        // registers one endpoint under another's name and leaves a third
        // unanswered. Only apiSlice keys entries for you.
        const app = mock.create({ ...requiredOptions });
        const entry = app.api('user.get', async ({ payload }) => ({ id: payload.userId, name: 'Ada' }));
        expect(() => app.registerPartial({ 'tools.echo': entry }))
            .toThrow(/slice key "tools\.echo" holds the mock for "user\.get"/);
        expect(app.registeredNames).toEqual([]);
    });

    it('reset empties the cookies its own transports hold, and leaves a jar the caller brought', async () => {
        const { mockApp } = createMockApp();
        const transport = mockApp.transport();
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport });
        const ownJar = new LambderCookieJar();
        const brought = callerFor(mockApp, { jar: ownJar });
        await caller.api('account.login', { user: 'ada' });
        await brought.api('account.login', { user: 'bob' });
        expect(transport.cookieJar?.size).toBeGreaterThan(0);

        mockApp.reset();

        // Rewinding sessions without their cookies would make the next call
        // look signed in until the answer said otherwise.
        expect(transport.cookieJar?.size).toBe(0);
        const after = await caller.apiOutcome('account.me', {});
        assertApiFailure(after, 'sessionExpired');
        // The caller's own jar is the caller's, as an app-supplied store is.
        expect(ownJar.size).toBeGreaterThan(0);
    });

    it('reset rewinds sessions, counters, replays, overrides, failures and the log, then calls onReset', async () => {
        const onReset = vi.fn();
        const mockApp = mock.create({ ...requiredOptions, sessions: true, rateLimits: { policies: { tight: { perMin: 1, per: 'ip' } } }, onReset });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.api('tools.limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) }),
            mockApp.api('account.login', async ({ payload, sessionController }) => { await sessionController.createSession(payload.user, { userId: payload.user, tenants: [] }); return { ok: true }; }),
        ));
        const caller = callerFor(mockApp);
        await caller.api('account.login', { user: 'ada' });
        await caller.api('tools.limited', {});
        expect((await caller.apiOutcome('tools.limited', {})).ok).toBe(false);
        mockApp.override('tools.limited', async () => ({ n: 9 }));
        mockApp.setFailure('account.login', 'server');

        mockApp.reset();

        expect(onReset).toHaveBeenCalledOnce();
        expect(mockApp.sessionStore?.size).toBe(0);
        expect(mockApp.calls.length).toBe(0);
        expect(await caller.api('tools.limited', {})).toEqual({ n: 1 });
        expect((await caller.apiOutcome('account.login', { user: 'ada' })).ok).toBe(true);
    });

    it('validates the payload against an entry\'s own schema, answering 422 as the server does', async () => {
        // The contract is a type, so the server's schemas do not exist here.
        // An entry may restate the shape for the endpoints whose rejection
        // path a test needs, and endpoints without one take whatever arrives.
        const mockApp = mock.create({ ...requiredOptions });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.api('user.get', { input: z.object({ userId: z.string() }), handler: async ({ payload }) => ({ id: payload.userId, name: 'Ada' }) }),
            mockApp.api('tools.echo', async ({ payload }) => ({ count: payload.notes.length })),
        ));
        const caller = callerFor(mockApp);

        expect(await caller.api('user.get', { userId: '1' })).toEqual({ id: '1', name: 'Ada' });

        const refused = await caller.apiOutcome('user.get', { userId: 42 } as never);
        assertApiFailure(refused, 'validation');
        // An endpoint with no schema still takes whatever arrives.
        expect(await caller.api('tools.echo', { notes: ['a', 'b'] })).toEqual({ count: 2 });
    });

    it('answers a bad input as the server app\'s own validation handler does, once the mock states it', async () => {
        // A server app with setApiInputValidationErrorHandler answers 200 with
        // a refusal; a mock that always answered 422 would test the
        // form's error path against an answer production never gives.
        const mockApp = mock.create({
            ...requiredOptions,
            onInvalidInput: (zodError) => ({ payload: null, config: { refusal: `Check ${zodError.issues[0]?.path.join('.')}.` } }),
        });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.api('user.get', { input: z.object({ userId: z.string() }), handler: async ({ payload }) => ({ id: payload.userId, name: 'Ada' }) }),
        ));
        const outcome = await callerFor(mockApp).apiOutcome('user.get', { userId: 42 } as never);

        assertApiFailure(outcome, 'refusal');
        expect(outcome.refusal?.content).toBe('Check userId.');
        expect(outcome.status).toBe(200);

        // null asks for the standard answer.
        const standard = mock.create({ ...requiredOptions, onInvalidInput: () => null });
        standard.registerPartial(standard.apiSlice(
            standard.api('user.get', { input: z.object({ userId: z.string() }), handler: async ({ payload }) => ({ id: payload.userId, name: 'Ada' }) }),
        ));
        assertApiFailure(await callerFor(standard).apiOutcome('user.get', { userId: 42 } as never), 'validation');
    });

    it('hands a handler a parse of the JSON, never the object the page sent', async () => {
        // By reference, a handler that stored the payload would share it with
        // the page's form, and a Date or an undefined key would reach it as no
        // server ever sees one.
        const mockApp = mock.create({ ...requiredOptions });
        const seen: unknown[] = [];
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.api('tools.echo', async ({ payload }) => { seen.push(payload); return { count: payload.notes.length }; }),
        ));
        const form = { notes: ['a'], at: new Date('2026-01-02T03:04:05.000Z'), draft: undefined };
        await callerFor(mockApp).api('tools.echo', form as never);

        expect(seen[0]).not.toBe(form);
        expect(seen[0]).toEqual({ notes: ['a'], at: '2026-01-02T03:04:05.000Z' });
        expect(Object.keys(seen[0] as object)).not.toContain('draft');
        (seen[0] as { notes: string[] }).notes.push('edited by the handler');
        expect(form.notes).toEqual(['a']);
    });

    it('carries the logList and the headers and cookies a handler wrote, beside its payload', async () => {
        const mockApp = mock.create({ ...requiredOptions });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.api('tools.echo', async ({ payload, logList, setResponseHeader, setCookie }) => {
                logList.push('note');
                setResponseHeader('X-Served-By', 'the mock');
                setCookie('lastEcho', String(payload.notes.length));
                return { count: payload.notes.length };
            }),
        ));

        const answer = await mockApp.handleRequest({
            apiName: 'tools.echo', version: null, signature: null, token: '', siteHost: 'localhost', payload: { notes: ['hi'] },
            compressedPayload: null, guardInputs: undefined, idempotencyKey: undefined,
            headers: {}, cookies: {}, ip: '1.2.3.4', host: 'localhost',
        });

        expect(JSON.parse(answer.body)).toEqual({ apiVersion: null, payload: { count: 1 }, logList: ['note'] });
        expect(answer.headers['X-Served-By']).toEqual(['the mock']);
        expect(answer.headers['Set-Cookie']).toEqual([expect.stringMatching(/^lastEcho=1; /)]);
    });

    it('answers a thrown handler with the message it threw, unless asked for the server\'s wording', async () => {
        const build = (revealHandlerErrors?: boolean) => {
            const mockApp = mock.create(revealHandlerErrors === undefined ? requiredOptions : { ...requiredOptions, revealHandlerErrors });
            mockApp.registerPartial(mockApp.apiSlice(
                mockApp.api('tools.echo', async () => { throw new Error('Translations not found for "checkout"'); }),
            ));
            return callerFor(mockApp);
        };

        const revealed = await build().apiOutcome('tools.echo', { notes: [] });
        assertApiFailure(revealed);
        expect(revealed.refusal?.content).toBe('Translations not found for "checkout"');

        const hidden = await build(false).apiOutcome('tools.echo', { notes: [] });
        assertApiFailure(hidden);
        expect(hidden.refusal?.content).toBe('Internal server error.');
    });

    it('reset also puts back the configured latency and restarts the call numbering', async () => {
        const mockApp = mock.create({ ...requiredOptions, latency: 0, rateLimits: { policies: { tight: { perMin: 2, per: 'ip' } } } });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.api('tools.limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) }),
        ));
        const caller = callerFor(mockApp);
        mockApp.setLatency(120);

        mockApp.reset();

        // No timer is advanced: a call still carrying the latency set before
        // the reset would be sitting on one, which is what this asserts
        // instead of an elapsed wall-clock time.
        vi.useFakeTimers();
        try {
            let settled = false;
            const pending = caller.api('tools.limited', {});
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(true);
            expect(await pending).toEqual({ n: 1 });
        } finally {
            vi.useRealTimers();
        }
        expect(mockApp.calls[0]?.id).toBe(1);
    });

    it('refuses to override an endpoint that was never registered, rather than inventing a public one', () => {
        const mockApp = mock.create({ ...requiredOptions, sessions: true, rateLimits: { policies: { tight: { perMin: 2, per: 'ip' } } } });
        mockApp.registerPartial(mockApp.apiSlice(
            mockApp.api('tools.limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) }),
        ));

        // 'account.me' is a session endpoint in the contract. Inventing a public
        // entry for it would answer with no session and no guards, so a test
        // would read a pass where the server refuses.
        expect(() => mockApp.override('account.me', async () => ({ userId: 'x' })))
            .toThrow(/has nothing to override/);
    });

    it('subscribers see both phases with the pipeline decisions; keys replace listeners; a throwing listener is reported once', async () => {
        const { mockApp } = createMockApp();
        const events: LambderMockCallEvent[] = [];
        mockApp.subscribe('test', () => { throw new Error('never'); });
        mockApp.subscribe('test', (event) => { events.push(event); });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockApp.subscribe('broken', () => { throw new Error('listener broke'); });

        await callerFor(mockApp).api('user.get', { userId: '1' });
        await callerFor(mockApp).api('user.get', { userId: '2' });

        expect(events.map((event) => event.phase)).toEqual(['request', 'response', 'request', 'response']);
        const [request, response] = events as [LambderMockCallEvent & { phase: 'request' }, LambderMockCallEvent & { phase: 'response' }];
        expect(request.apiName).toBe('user.get');
        expect(request.mode).toBe('public');
        expect(request.payload).toEqual({ userId: '1' });
        expect(request.hasSessionCookie).toBe(false);
        expect(response.id).toBe(request.id);
        expect(response.outcome).toBe('ok');
        expect(response.statusCode).toBe(200);
        expect(response.envelope?.payload).toEqual({ id: '1', name: 'Ada' });
        expect(error).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });

    it('the call log hands out copies, and keeps no session token', async () => {
        const { mockApp } = createMockApp();
        const transport = mockApp.transport();
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport });
        await caller.api('account.login', { user: 'ada' });
        const sessionToken = transport.cookieJar!.get(mockApp.tokenCookieKey, { includeHttpOnly: true })!;

        const record = mockApp.calls.at(-1)!;
        (record.payload as { user: string }).user = 'edited';
        record.guardsRun.push('invented');
        for(const key of Object.keys(record.headers)) delete record.headers[key];

        const again = mockApp.calls.at(-1)!;
        expect((again.payload as { user: string }).user).toBe('ada');
        expect(again.guardsRun).toEqual([]);
        const setCookies = Object.entries(again.headers).find(([key]) => key.toLowerCase() === 'set-cookie')?.[1] ?? [];
        expect(setCookies.length).toBeGreaterThan(0);
        // The header says which cookies a call set and how; the token itself
        // is the one credential this runtime holds and stays out of the log.
        expect(setCookies.every((header) => /^[^=]+=\[redacted\];/.test(header))).toBe(true);
        expect(sessionToken.length).toBeGreaterThan(0);
        expect(setCookies.join(' ')).not.toContain(sessionToken);
    });

    it('a listener that throws is muted rather than called again, and reset unmutes it', async () => {
        const { mockApp } = createMockApp();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        let seen = 0;
        mockApp.subscribe('broken', () => { seen += 1; throw new Error('listener broke'); });

        await callerFor(mockApp).api('user.get', { userId: '1' });
        await callerFor(mockApp).api('user.get', { userId: '2' });
        // One call, not four: the message says the listener is ignored from
        // then on, so the loop must stop calling it.
        expect(seen).toBe(1);
        expect(error).toHaveBeenCalledTimes(1);

        mockApp.reset();
        await callerFor(mockApp).api('user.get', { userId: '3' });
        expect(seen).toBe(2);
        error.mockRestore();
    });

    it('the call log is a bounded ring of completed calls', async () => {
        const mockApp = mock.create({ ...requiredOptions, callLogSize: 2 });
        mockApp.registerPartial(mockApp.apiSlice(mockApp.api('user.get', async ({ payload }) => ({ id: payload.userId, name: 'Ada' }))));
        const caller = callerFor(mockApp);
        for(const userId of ['1', '2', '3']) await caller.api('user.get', { userId });
        expect(mockApp.calls.map((call) => (call.payload as { userId: string }).userId)).toEqual(['2', '3']);
    });

    it('the unsubscribe returned by subscribe removes the listener', async () => {
        const { mockApp } = createMockApp();
        const seen: string[] = [];
        const unsubscribe = mockApp.subscribe('k', (event) => { seen.push(event.phase); });
        await callerFor(mockApp).api('user.get', { userId: '1' });
        unsubscribe();
        await callerFor(mockApp).api('user.get', { userId: '1' });
        expect(seen).toEqual(['request', 'response']);
    });
});

/**
 * A stand-in for the msw module: the adapter needs a post() to register a
 * resolver and a Response constructor, and the module type names all() too.
 *
 * Deliberately not annotated as LambderMswModule. Annotated, the fake would be
 * checked against the adapter's own declaration and prove only that the
 * declaration describes the fake; whether the real package fits it is pinned
 * in tests/mock/mock-types.test.ts against a replica of msw 2's own signature.
 */
const fakeMswModule = () => {
    let resolver: ((info: { request: Request }) => Promise<Response | undefined>) | null = null;
    const msw = {
        http: { post: (_path: string, given: typeof resolver) => { resolver = given; return null; }, all: () => null },
        HttpResponse: Response,
    };
    // JSON to the endpoint's own path, as every Lambder caller posts it; a test passes its own Content-Type to see another.
    const post = async (apiName: string, body: unknown, headers: Record<string, string> = {}) => await resolver!({
        request: new Request(apiCallPath('http://localhost/api', apiName), { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }),
    });
    return { msw, post };
};

/** A page's cookie storage, as the mirror writes to it and js-cookie reads it back. */
const fakeDocumentCookies = () => {
    const written: string[] = [];
    const values = new Map<string, string>();
    return {
        written,
        /** One cookie as a page's script reads it, undefined where the page holds none. */
        read(name: string){ return values.get(name); },
        document: {
            get cookie(){ return [...values].map(([name, value]) => `${name}=${value}`).join('; '); },
            set cookie(header: string){
                written.push(header);
                const [pair] = header.split(';');
                const separator = (pair ?? '').indexOf('=');
                if(separator <= 0) return;
                const name = pair!.slice(0, separator).trim();
                // A browser removes the cookie on an expiry in the past rather
                // than storing an empty value, and so does the jar.
                if(/;\s*Max-Age=0\b/i.test(header)) values.delete(name);
                else values.set(name, pair!.slice(separator + 1).trim());
            },
        },
    };
};

/** Runs a body with the page's cookie storage in place, and puts the globals back. */
const withFakePage = async (page: ReturnType<typeof fakeDocumentCookies>, body: () => Promise<void>) => {
    const globals = globalThis as unknown as { document?: unknown };
    const previousDocument = globals.document;
    globals.document = page.document;
    try {
        await body();
    } finally {
        if(previousDocument === undefined) delete globals.document; else globals.document = previousDocument;
    }
};

describe('LambderMockApp - the MSW adapter and the document mirror', () => {
    it('serves a mocked call over the adapter, carrying the session in its own jar', async () => {
        const { mockApp } = createMockApp();
        const jar = new LambderCookieJar();
        const { msw, post } = fakeMswModule();
        lambderMockMswHandler(mockApp, { msw, apiPath: '/api', cookieJar: jar });

        const login = await post('account.login', { payload: { user: 'ada' }, token: '', siteHost: 'localhost' }) as Response;
        expect(login.status).toBe(200);
        expect(jar.get(mockApp.tokenCookieKey, { includeHttpOnly: true })).toBeTruthy();

        // The jar answers for the host and path this call is going to, the
        // way a browser decides what to send, rather than emptying itself
        // into every request.
        const me = await post('account.me', { payload: {}, token: jar.get(mockApp.csrfCookieKey) ?? '', siteHost: 'localhost' }) as Response;
        expect(await me.json()).toMatchObject({ payload: { userId: 'ada' } });
    });

    it('a passthrough is a row in the call log and an event, not silence', async () => {
        // The one failure the log exists to make visible: a mistyped endpoint
        // name leaving the page for the real backend.
        const { mockApp } = createMockApp();
        const events: LambderMockCallEvent[] = [];
        mockApp.subscribe('panel', (event) => { events.push(event); });
        const { msw, post } = fakeMswModule();
        lambderMockMswHandler(mockApp, { msw, apiPath: '/api', onUnmocked: 'passthrough' });

        const answer = await post('user.gett', { payload: { userId: '1' }, token: '', siteHost: 'localhost' });
        expect(answer).toBeUndefined();
        expect(mockApp.calls.at(-1)).toMatchObject({ apiName: 'user.gett', outcome: 'passthrough', statusCode: null, mode: null });
        expect(events.map((event) => event.phase)).toEqual(['request', 'response']);
    });

    it('the document mirror drops Secure off a secure context, skips HttpOnly, and reset expires what it planted', async () => {
        // Development over plain http on a LAN address: the browser refuses a
        // Secure write, so a mirror that keeps the attribute leaves the page
        // with no CSRF cookie and every session call failing its CSRF check
        // with nothing in any log to say why.
        const globals = globalThis as unknown as { document?: unknown; isSecureContext?: boolean };
        const previousDocument = globals.document;
        const previousSecureContext = globals.isSecureContext;
        const page = fakeDocumentCookies();
        globals.document = page.document;
        globals.isSecureContext = false;
        try {
            const { mockApp } = createMockApp();
            const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport: mockApp.transport({ cookies: 'document' }) });
            await caller.api('account.login', { user: 'ada' });

            expect(page.written.some((header) => header.startsWith(`${mockApp.csrfCookieKey}=`))).toBe(true);
            expect(page.written.some((header) => /;\s*Secure\b/i.test(header))).toBe(false);
            // The session cookie is HttpOnly, so it stays in the jar exactly
            // as a browser keeps it out of document.cookie.
            expect(page.written.some((header) => header.startsWith(`${mockApp.tokenCookieKey}=`))).toBe(false);
            // The page reads its CSRF token back, which is what the caller
            // posts on the envelope: the session call it carries works.
            expect(await caller.api('account.me', {})).toEqual({ userId: 'ada' });

            page.written.length = 0;
            mockApp.reset();
            expect(page.written.some((header) => header.startsWith(`${mockApp.csrfCookieKey}=`) && /Max-Age=0/.test(header))).toBe(true);
        } finally {
            if(previousDocument === undefined) delete globals.document; else globals.document = previousDocument;
            if(previousSecureContext === undefined) delete globals.isSecureContext; else globals.isSecureContext = previousSecureContext;
        }
    });

    it('signs a browser in behind the adapter: the jar carries the session and the page holds the CSRF cookie', async () => {
        // The documented browser path, and the one a frontend plants its dev
        // session on. The adapter scopes its jar by the app's cookieHost, not
        // the request URL host, or an app whose cookieHost is not the page's
        // would hold the session at a host it never sends it to. And signIn
        // writes through the document mirror like every cookie writer, or the
        // page would have no CSRF token to post and every session call would
        // answer sessionExpired.
        const page = fakeDocumentCookies();
        await withFakePage(page, async () => {
            const app = mock.create({ ...requiredOptions, sessions: true, cookieHost: 'api.example.com' });
            app.registerPartial(app.apiSlice(app.api('account.me', { guards: 'signedIn', handler: async ({ session }) => ({ userId: session.data.userId }) })));
            const jar = new LambderCookieJar();
            const { msw, post } = fakeMswModule();
            lambderMockMswHandler(app, { msw, apiPath: '/api', cookieJar: jar });

            await app.signIn('ada', { userId: 'ada', tenants: [] }, { jar });

            // What the browser caller posts: the CSRF cookie as a page's own
            // script reads it.
            const token = page.read(app.csrfCookieKey);
            expect(token).toBeTruthy();
            const me = await post('account.me', { payload: {}, token, siteHost: 'api.example.com' }) as Response;
            expect(await me.json()).toMatchObject({ payload: { userId: 'ada' } });

            await app.signOut('ada', { jar });

            // Symmetric with signIn: the records are gone and so are the
            // cookies naming them, in the jar and on the page.
            expect(jar.get(app.tokenCookieKey, { includeHttpOnly: true })).toBeUndefined();
            expect(page.read(app.csrfCookieKey)).toBeUndefined();
            const after = await post('account.me', { payload: {}, token, siteHost: 'api.example.com' }) as Response;
            expect(await after.json()).toMatchObject({ sessionExpired: true });
        });
    });

    it('keeps a memory-mode page signed in after a logout and a login, whatever signIn left in document.cookie', async () => {
        // signIn mirrors the CSRF cookie into document.cookie for the MSW
        // adapter, and a page's caller reads its token from there. A memory
        // transport that never wrote there again would land the next login's
        // answer in the jar only, and the caller would keep posting the demo
        // user's token, failing the pairing and signing the new user out.
        const page = fakeDocumentCookies();
        await withFakePage(page, async () => {
            const { mockApp } = createMockApp();
            const jar = new LambderCookieJar();
            await mockApp.signIn('demo', { userId: 'demo', tenants: [] }, { jar });
            expect(page.read(mockApp.csrfCookieKey)).toBeTruthy();
            const caller = callerFor(mockApp, { jar });
            expect(await caller.api('account.me', {})).toEqual({ userId: 'demo' });

            await caller.api('account.logout', {});
            await caller.api('account.login', { user: 'bea' });
            expect(await caller.api('account.me', {})).toEqual({ userId: 'bea' });
        });
    });

    it('leaves a memory-mode page signed in when a call sent before a login answers sessionExpired after it', async () => {
        // The session lives in the transport's jar, where document.cookie
        // never sees it, so the caller judges the answer by the jar's token:
        // the poll went out signed out, and the page now holds a session.
        const { mockApp } = createMockApp();
        const memory = mockApp.transport();
        let releasePollAnswer = () => {};
        const pollAnswerHeld = new Promise<void>((resolve) => { releasePollAnswer = resolve; });
        const answerInTransit: LambderApiTransport = async (request) => {
            const answer = await memory(request);
            if(request.apiName === 'account.me') await pollAnswerHeld;
            return answer;
        };
        const sessionExpiredHandler = vi.fn();
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, sessionExpiredHandler, transport: answerInTransit });
        await caller.api('account.login', { user: 'ada' });
        await caller.api('account.logout', {});

        const poll = caller.apiOutcome('account.me', {});
        await caller.api('account.login', { user: 'bea' });
        releasePollAnswer();

        assertApiFailure(await poll, 'sessionExpired');
        expect(sessionExpiredHandler).not.toHaveBeenCalled();
        expect(await caller.api('account.me', {})).toEqual({ userId: 'bea' });
    });

    it('still calls the sessionExpired handler in memory mode when the answer is about the session the jar holds', async () => {
        const { mockApp } = createMockApp();
        const sessionExpiredHandler = vi.fn();
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, sessionExpiredHandler, transport: mockApp.transport() });
        await caller.api('account.login', { user: 'ada' });
        await mockApp.signOut('ada');

        assertApiFailure(await caller.apiOutcome('account.me', {}), 'sessionExpired');
        expect(sessionExpiredHandler).toHaveBeenCalledOnce();
    });

    it('reads its calls from the same client address the direct transport does', async () => {
        // Were the adapter to pin 127.0.0.1, an app that set
        // defaultClientIp would see its own address through the transport and
        // the loopback through the service worker: two clients where there is
        // one, and a per-IP rate limit counting them apart.
        const app = mock.create({ ...requiredOptions, defaultClientIp: '10.1.2.3' });
        app.registerPartial(app.apiSlice(
            app.api('user.get', async ({ request }) => ({ id: request.ip, name: 'ip' })),
        ));
        const { msw, post } = fakeMswModule();
        lambderMockMswHandler(app, { msw, apiPath: '/api' });

        const direct = await new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false, transport: app.transport(),
        }).api('user.get', { userId: 'x' });
        const through = await post('user.get', { payload: { userId: 'x' }, token: '', siteHost: 'localhost' }) as Response;

        expect(direct?.id).toBe('10.1.2.3');
        expect(await through.json()).toMatchObject({ payload: { id: '10.1.2.3' } });
    });
});

describe('LambderMockApp - the rest entry', () => {
    /**
     * An app that mocks one endpoint and declares everything else not mocked:
     * the shape an app adopts the mock in while its contract is only partly
     * covered.
     */
    const createRestApp = (options: { apiVersion?: string; sessionStore?: LambderSessionStore<SessionData> } = {}) => {
        const app = mock.create({
            apiVersion: options.apiVersion,
            apiSignatures: mockSignatures,
            ...requiredOptions,
            sessions: options.sessionStore ? { store: options.sessionStore } : true,
        });
        app.register(
            app.apiSlice(app.api('user.get', async ({ payload }) => ({ id: payload.userId, name: 'Ada' }))),
            app.restNotMocked('not mocked yet'),
        );
        return app;
    };

    /** The memory store with its reads counted, so a call can be shown never to have asked it anything. */
    const recordingSessionStore = () => {
        const inner = new LambderMemorySessionStore<SessionData>();
        let reads = 0;
        const store: LambderSessionStore<SessionData> = {
            isMemoryOnly: true,
            get: async (sessionKeyHash, secretHash) => { reads += 1; return await inner.get(sessionKeyHash, secretHash); },
            create: async (record) => await inner.create(record),
            update: async (...args) => await inner.update(...args),
            delete: async (sessionKeyHash, secretHash) => await inner.delete(sessionKeyHash, secretHash),
            listSecretHashes: async (sessionKeyHash) => await inner.listSecretHashes(sessionKeyHash),
        };
        return { store, reads: () => reads, forgetReads: () => { reads = 0; } };
    };

    it('answers an endpoint nothing registered with the notMocked refusal, carrying the rest reason', async () => {
        const app = createRestApp();
        const outcome = await callerFor(app).apiOutcome('tools.limited', {});

        expect(outcome.ok).toBe(false);
        if(outcome.ok) return;
        expect(outcome.refusal).toMatchObject({
            code: LAMBDER_REFUSAL_CODES.notMocked,
            content: expect.stringContaining('"tools.limited" is not mocked: not mocked yet'),
        });
        expect(app.calls.at(-1)?.outcome).toBe('notMocked');
        // The mode of a name nothing registered is not knowable at runtime,
        // and the rest answer does not pretend otherwise: it is processed as
        // public, which says nothing about the endpoint.
        expect(app.calls.at(-1)?.mode).toBeNull();

        // A registration like any other, so reset() keeps it.
        app.reset();
        expect((await callerFor(app).apiOutcome('tools.limited', {})).ok).toBe(false);
        expect(app.calls.at(-1)?.outcome).toBe('notMocked');
    });

    it('leaves the registered entries alone, and a later registration takes its endpoint back', async () => {
        const app = createRestApp();
        expect(await callerFor(app).api('user.get', { userId: '42' })).toEqual({ id: '42', name: 'Ada' });

        // Explicit entries win over the rest however late they arrive, which
        // is what lets a test register the three endpoints it cares about
        // over an app that declared the rest not mocked at boot.
        app.registerPartial(app.apiSlice(app.api('tools.echo', async ({ payload }) => ({ count: payload.notes.length }))));
        expect(await callerFor(app).api('tools.echo', { notes: ['a', 'b'] })).toEqual({ count: 2 });
        expect(app.calls.at(-1)?.outcome).toBe('ok');
    });

    it('answers as a public endpoint: no session read, and a signed-out session endpoint says not mocked', async () => {
        // The one fidelity limit of a mock given no apiOptions table.
        // 'account.me' is a session endpoint of the contract, so the server
        // and a mock given the table both read the session store before
        // answering; the rest entry here cannot, because the contract is a
        // type and the mode of an unregistered name is not recoverable at
        // runtime.
        const recording = recordingSessionStore();
        const app = createRestApp({ sessionStore: recording.store });
        const jar = new LambderCookieJar();
        await app.signIn('ada', { userId: 'ada', tenants: [] }, { jar });
        recording.forgetReads();

        const signedIn = await callerFor(app, { jar }).apiOutcome('account.me', {});
        assertApiFailure(signedIn);
        expect(signedIn.refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.notMocked });
        expect(recording.reads()).toBe(0);

        // And with no session at all it is still "not mocked" rather than the
        // sessionExpired the server answers.
        const signedOut = await callerFor(app).apiOutcome('account.me', {});
        assertApiFailure(signedOut, 'refusal');
        expect(app.calls.at(-1)?.outcome).toBe('notMocked');
        expect(recording.reads()).toBe(0);
    });

    it('still runs the protocol steps that precede dispatch, so a stale client hears versionExpired first', async () => {
        const app = createRestApp({ apiVersion: '2' });

        const stale = await callerFor(app, { apiSignatures: { ...mockSignatures, [await apiNameKeyOf('tools.limited')]: 'an-older-shape' } }).apiOutcome('tools.limited', {});
        assertApiFailure(stale, 'versionExpired');
        expect(app.calls.at(-1)?.outcome).toBe('versionExpired');

        const current = await callerFor(app, { apiSignatures: mockSignatures }).apiOutcome('tools.limited', {});
        assertApiFailure(current);
        expect(current.refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.notMocked });
    });

    it('a second rest entry is refused the way a duplicate name is, and leaves the registry as it was', () => {
        const twice = mock.create({ ...requiredOptions });
        expect(() => twice.register(
            twice.apiSlice(twice.api('user.get', async ({ payload }) => ({ id: payload.userId, name: 'Ada' }))),
            twice.restNotMocked('not mocked yet'),
            twice.restNotMocked('also not mocked'),
        )).toThrow(/already registered as not mocked/);
        expect(twice.registeredNames).toEqual([]);

        // And a second register() call carrying one is refused as well: which
        // reason a call would get is registration order, which is exactly what
        // a duplicate name is refused for.
        const app = createRestApp();
        expect(() => app.register(
            app.apiSlice(app.api('tools.echo', async ({ payload }) => ({ count: payload.notes.length }))),
            app.restNotMocked('also not mocked'),
        )).toThrow(/already registered as not mocked \("not mocked yet"\)/);
        // The entries of the refused call are not registered either.
        expect(app.registeredNames).toEqual(['user.get']);
    });

    it('wins over the MSW adapter passthrough: nothing reaches the network', async () => {
        // The two are alternatives. With a rest entry the runtime has an
        // answer for every name, so onUnmocked never applies and a call that
        // would have gone to the real backend is answered notMocked instead.
        const app = createRestApp();
        const { msw, post } = fakeMswModule();
        lambderMockMswHandler(app, { msw, apiPath: '/api', onUnmocked: 'passthrough' });

        const answer = await post('tools.limited', { payload: {}, token: '', siteHost: 'localhost' });
        expect(answer).toBeDefined();
        expect(await (answer as Response).json()).toMatchObject({ refusal: { code: LAMBDER_REFUSAL_CODES.notMocked } });
        expect(app.calls.at(-1)).toMatchObject({ apiName: 'tools.limited', outcome: 'notMocked' });
    });
});

describe('LambderMockApp - the invoke transport', () => {
    it('reads the client address from sourceIp alone, not from a forwarding header', async () => {
        // The synthesized event carries the end user's address in
        // requestContext.http.sourceIp, and x-forwarded-for is an ordinary
        // request header any caller can set: trusting it would hand every
        // caller the value a `per: "ip"` limit counts on.
        const app = mock.create({ ...requiredOptions });
        app.registerPartial(app.apiSlice(
            app.api('user.get', async ({ request }) => ({ id: request.ip, name: 'ip' })),
        ));
        const transport = lambderMockInvokeTransport(app);

        const answer = await transport({
            rawPath: '/api/user/get',
            body: JSON.stringify({ payload: { userId: 'x' }, token: '', siteHost: '' }),
            headers: { 'x-forwarded-for': '9.9.9.9', 'content-type': 'application/json' },
            requestContext: { http: { method: 'POST', sourceIp: '10.0.0.7' } },
        }, {});

        expect(JSON.parse(answer.result.body)).toMatchObject({ payload: { id: '10.0.0.7' } });
    });

    it('answers a POST of another type as no API call, as the server does', async () => {
        const app = mock.create({ ...requiredOptions });
        app.registerPartial(app.apiSlice(
            app.api('user.get', async () => ({ id: 'u1', name: 'Ada' })),
        ));
        const answer = await lambderMockInvokeTransport(app)({
            rawPath: '/api/user/get',
            body: JSON.stringify({ payload: { userId: 'x' }, token: '', siteHost: '' }),
            headers: { 'content-type': 'text/plain' },
            requestContext: { http: { method: 'POST', sourceIp: '10.0.0.7' } },
        }, {});
        expect(answer.result.statusCode).toBe(404);

        const { msw, post } = fakeMswModule();
        lambderMockMswHandler(app, { apiPath: '/api', msw });
        expect(await post('user.get', { payload: { userId: 'x' }, token: '', siteHost: '' }, { 'Content-Type': 'text/plain' })).toBeUndefined();
    });

    it('answers only a JSON POST to a call path under the apiPath it was given, as the server does', async () => {
        const app = mock.create({ ...requiredOptions });
        app.registerPartial(app.apiSlice(
            app.api('user.get', async () => ({ id: 'u1', name: 'Ada' })),
        ));
        const send = (transport: ReturnType<typeof lambderMockInvokeTransport>, rawPath: string, method = 'POST') => transport({
            rawPath,
            body: JSON.stringify({ payload: { userId: 'x' }, token: '', siteHost: '' }),
            headers: { 'content-type': 'application/json' },
            requestContext: { http: { method, sourceIp: '10.0.0.7' } },
        }, {});

        const atDefault = lambderMockInvokeTransport(app);
        expect(JSON.parse((await send(atDefault, '/api/user/get')).result.body)).toMatchObject({ payload: { id: 'u1' } });
        // A route of the mocked function, which a mock does not serve: two
        // segments of identifiers outside apiPath are no call.
        expect((await send(atDefault, '/webhooks/user/get')).result.statusCode).toBe(404);
        expect((await send(atDefault, '/api/user/get', 'GET')).result.statusCode).toBe(404);

        const atRpc = lambderMockInvokeTransport(app, { apiPath: '/rpc' });
        expect(JSON.parse((await send(atRpc, '/rpc/user/get')).result.body)).toMatchObject({ payload: { id: 'u1' } });
        expect((await send(atRpc, '/api/user/get')).result.statusCode).toBe(404);
    });
});

describe('LambderMockApp - registration, cookies and the call log', () => {
    it('refuses a not-mocked session endpoint on a mock without sessions, as it refuses a mocked one', async () => {
        // Unchecked, the entry would register in silence and the first call
        // to it would answer 500 from inside the pipeline with a message
        // naming the server's option, for a mistake whose fix is one option
        // at create(). The apiOptions table is what says it is a session
        // endpoint here.
        // @ts-expect-error the contract has session endpoints; built without sessions on purpose, as a plain-JS caller could
        const bare = mock.create({ ...requiredOptions, sessions: false, apiOptions: contractOptions });
        expect(() => bare.notMocked('admin.audit', 'operator endpoint, no client calls it'))
            .toThrow(/session endpoint "admin.audit" needs the sessions option at creation/);
        // The public twin still registers: it is the session read that needs the option.
        expect(() => bare.notMocked('admin.run', 'operator endpoint, no client calls it')).not.toThrow();
    });

    it('carries its cookies at the app\'s own host, so a page served from anything but plain localhost stays signed in', async () => {
        // Were signIn to plant at "localhost" while the transport's jar scoped
        // by the caller's siteHost, on shop.localhost:5173 the jar would
        // answer with nothing and every session call would come back
        // sessionExpired with a full jar and no explanation.
        const app = mock.create({ ...requiredOptions, sessions: true, cookieHost: 'shop.localhost:5173' });
        app.registerPartial(app.apiSlice(app.api('account.me', { guards: 'signedIn', handler: async ({ session }) => ({ userId: session.data.userId }) })));
        const jar = new LambderCookieJar();
        await app.signIn('ada', { userId: 'ada', tenants: [] }, { jar });

        const answer = await app.transport({ cookies: jar })({
            apiPath: '/api', apiName: 'account.me', token: '', siteHost: 'shop.localhost:5173', payload: {},
        });
        expect(await answer.json()).toMatchObject({ payload: { userId: 'ada' } });
    });

    it('still signs in the Node caller, which names no site host at all', async () => {
        const app = mock.create({ ...requiredOptions, sessions: true });
        app.registerPartial(app.apiSlice(app.api('account.me', { guards: 'signedIn', handler: async ({ session }) => ({ userId: session.data.userId }) })));
        const jar = new LambderCookieJar();
        await app.signIn('ada', { userId: 'ada', tenants: [] }, { jar });

        const answer = await app.transport({ cookies: jar })({
            apiPath: '/api', apiName: 'account.me', token: '', siteHost: '', payload: {},
        });
        expect(await answer.json()).toMatchObject({ payload: { userId: 'ada' } });
    });

    it('reports the guards a crashed call had already run', async () => {
        // The pipeline rethrows a crash, so a trace read off what run()
        // returned would leave guardsRun empty on exactly the calls a
        // developer opens the log for. The trace is handed in, and survives
        // the throw.
        const { mockApp } = createMockApp();
        const caller = callerFor(mockApp);
        await caller.api('account.login', { user: 'ada' });
        mockApp.override('order.create', async () => { throw new Error('boom'); });

        const outcome = await caller.apiOutcome('order.create', { qty: 1 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: 'k-order-crash-abcdefabcdef' });

        expect(outcome.ok).toBe(false);
        const last = mockApp.calls.at(-1)!;
        expect(last.outcome).toBe('crash');
        expect(last.error?.message).toBe('boom');
        expect(last.guardsRun).toEqual(['tenant']);
    });

});

describe('LambderMockApp - idempotency carries the server\'s own options', () => {
    it('scopes a public replay per caller when the app names a callerIdentity', async () => {
        // Without an identity the scope of a PUBLIC endpoint is the posted key
        // alone, which makes that key a bearer token for its own stored
        // answer. A mock that could not express the option would replay where
        // a server configured with one misses.
        let runs = 0;
        const app = mock.create({
            ...requiredOptions,
            idempotency: { callerIdentity: (ctx) => ctx.request.ip },
        });
        app.registerPartial(app.apiSlice(
            app.api('ticket.buy', { idempotency: true, handler: async () => { runs += 1; return { ticketId: `t-${runs}` }; } }),
        ));
        const callerFrom = (clientIp: string) => new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false, transport: app.transport({ clientIp }),
        });
        const key = createIdempotencyKey();

        const first = await callerFrom('10.0.0.1').api('ticket.buy', { seat: 'A1' }, { idempotencyKey: key });
        const replay = await callerFrom('10.0.0.1').api('ticket.buy', { seat: 'A1' }, { idempotencyKey: key });
        const stranger = await callerFrom('10.0.0.2').api('ticket.buy', { seat: 'A1' }, { idempotencyKey: key });

        expect(replay).toEqual(first);
        expect(stranger).not.toEqual(first);
        expect(runs).toBe(2);
        expect(app.calls.filter((call) => call.outcome === 'replayed').length).toBe(1);
    });

    it('carries defaultPendingTtlSeconds to the engine, which judges it', () => {
        // The engine refuses a replay window that is not a positive whole
        // number of seconds; the option reaching it is what this pins, since
        // an option the mock drops throws nothing at all.
        expect(() => mock.create({ ...requiredOptions, idempotency: { defaultPendingTtlSeconds: 0 } }))
            .toThrow(/defaultPendingTtlSeconds/);
        expect(() => mock.create({ ...requiredOptions, idempotency: { defaultPendingTtlSeconds: 900 } })).not.toThrow();
    });
});

describe('LambderMockApp - declarations read off the apiOptions table', () => {
    /** The server's vocabulary, the same object its init declares, which the mock imports from shared code. */
    const contractVocabulary = {
        'app/not-a-member': { notAuthorized: true, status: 403 },
        'app/read-only': {},
        'app/user-archived': { data: z.object({ since: z.string(), by: z.string().default('system'), days: z.number().transform((days) => days * 24) }) },
    } as const;
    const declaredMock = mock.declareRefusals(contractVocabulary);

    /**
     * The guard map for a mock given the tables: a declared code's flag is
     * its declaration's, so the raise site names the code alone. mockGuards,
     * for a mock given no tables, has to set the flag itself.
     */
    const declaredGuards = {
        signedIn: mockGuards.signedIn,
        tenant: mock.guard({
            guardInput: z.object({ tenantId: z.string() }),
            session: true,
            handler: (ctx, { tenantId }, role: 'reader' | 'writer') => {
                const membership = ctx.session.data.tenants.find((tenant) => tenant.tenantId === tenantId);
                if(!membership) refuse('Not a member.', { code: 'app/not-a-member' });
                if(role === 'writer' && membership.role !== 'writer') refuse('Read-only member.', { code: 'app/read-only' });
                return membership;
            },
        }),
    };

    const createDerivedApp = () => {
        const app = declaredMock.create({ ...requiredOptions, guards: declaredGuards, apiOptions: contractOptions, guardDeclarations: contractGuardDeclarations });
        let ticketRuns = 0;
        app.register(
            app.apiSlice(
                app.api('user.get', async ({ payload }) => ({ id: payload.userId, name: 'Ada' })),
                app.api('account.login', async () => ({ ok: true })),
                app.api('account.logout', async () => ({ ok: true })),
                app.api('account.me', async ({ session }) => ({ userId: session.data.userId })),
                // Its handler alone, and guardData is still typed from the contract's guards.
                app.api('order.create', async ({ payload, guardData }) => ({ orderId: `o-${guardData.tenant.tenantId}`, qty: payload.qty })),
                app.api('tools.limited', async () => ({ n: 1 })),
                app.api('ticket.buy', { handler: async ({ payload }) => { ticketRuns += 1; return { ticketId: `t-${payload.seat}-${ticketRuns}` }; } }),
                app.api('tools.echo', { input: z.object({ notes: z.array(z.string()) }), handler: async ({ payload }) => ({ count: payload.notes.length }) }),
            ),
            app.restNotMocked('not mocked yet'),
        );
        return app;
    };

    const callerOf = (app: { transport(options?: { cookies?: LambderCookieJar }): LambderApiTransport }, jar?: LambderCookieJar) =>
        new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false, transport: app.transport(jar ? { cookies: jar } : {}) });

    it('runs the guards, the rate limit and the idempotency the table declares, with entries that restate none of them', async () => {
        const app = createDerivedApp();

        // The rate limit: tight allows two a minute.
        expect((await callerOf(app).apiOutcome('tools.limited', {})).ok).toBe(true);
        expect((await callerOf(app).apiOutcome('tools.limited', {})).ok).toBe(true);
        assertApiFailure(await callerOf(app).apiOutcome('tools.limited', {}), 'refusal', { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });

        // The idempotency: a retry with the same key replays the first answer.
        const key = createIdempotencyKey();
        const first = await callerOf(app).api('ticket.buy', { seat: 'A1' }, { idempotencyKey: key });
        expect(await callerOf(app).api('ticket.buy', { seat: 'A1' }, { idempotencyKey: key })).toEqual(first);
        expect(app.calls.at(-1)?.outcome).toBe('replayed');

        // The guard: a member who is not a writer is refused, a writer is not.
        const jar = new LambderCookieJar();
        await app.signIn('lin', { userId: 'lin', tenants: [{ tenantId: 't1', role: 'reader' }] }, { jar });
        const reader = await callerOf(app, jar).apiOutcome('order.create', { qty: 1 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: createIdempotencyKey() });
        assertApiFailure(reader);
        expect(reader.refusal).toMatchObject({ code: 'app/read-only' });
        const writerJar = new LambderCookieJar();
        await app.signIn('ada', { userId: 'ada', tenants: [{ tenantId: 't1', role: 'writer' }] }, { jar: writerJar });
        expect(await callerOf(app, writerJar).api('order.create', { qty: 2 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: createIdempotencyKey() })).toEqual({ orderId: 'o-t1', qty: 2 });
        expect(app.calls.at(-1)?.guardsRun).toEqual(['tenant']);
    });

    it('sends a code declared sessionExpired under that flag, as the server does', async () => {
        // The same code, declared as a session that is gone: the declaration, not the raise site, sets the flag.
        const expiring = mock.declareRefusals({ ...contractVocabulary, 'app/read-only': { sessionExpired: true } })
            .create({ ...requiredOptions, guards: declaredGuards, apiOptions: contractOptions, guardDeclarations: contractGuardDeclarations });
        expiring.register(
            expiring.apiSlice(
                expiring.api('user.get', async ({ payload }) => ({ id: payload.userId, name: 'Ada' })),
                expiring.api('account.login', async () => ({ ok: true })),
                expiring.api('account.logout', async () => ({ ok: true })),
                expiring.api('account.me', async ({ session }) => ({ userId: session.data.userId })),
                expiring.api('order.create', async ({ payload, guardData }) => ({ orderId: `o-${guardData.tenant.tenantId}`, qty: payload.qty })),
                expiring.api('tools.limited', async () => ({ n: 1 })),
                expiring.api('ticket.buy', async ({ payload }) => ({ ticketId: `t-${payload.seat}` })),
                expiring.api('tools.echo', { input: z.object({ notes: z.array(z.string()) }), handler: async ({ payload }) => ({ count: payload.notes.length }) }),
            ),
            expiring.restNotMocked('not mocked yet'),
        );
        const jar = new LambderCookieJar();
        await expiring.signIn('lin', { userId: 'lin', tenants: [{ tenantId: 't1', role: 'reader' }] }, { jar });
        const reader = await callerOf(expiring, jar).apiOutcome('order.create', { qty: 1 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: createIdempotencyKey() });
        assertApiFailure(reader, 'sessionExpired');
        expect(reader.refusal).toMatchObject({ code: 'app/read-only', content: 'Read-only member.' });
    });

    it('holds a refusal to the codes the tables declare for the entry, its guards\' included', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = createDerivedApp();
        const jar = new LambderCookieJar();
        await app.signIn('sam', { userId: 'sam', tenants: [] }, { jar });
        // The guard's own code goes out, with the flag and status its declaration gives it.
        const stranger = await callerOf(app, jar).apiOutcome('order.create', { qty: 1 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: createIdempotencyKey() });
        assertApiFailure(stranger, 'notAuthorized', { code: 'app/not-a-member', status: 403 });
        // A code no table declares for the entry does not.
        app.override('user.get', async () => refuse('Gone.', { code: 'app/gone' }));
        assertApiFailure(await callerOf(app).apiOutcome('user.get', { userId: '1' }), 'server', { status: 500 });
        expect(app.calls.at(-1)).toMatchObject({ outcome: 'crash', error: { name: 'LambderApiRefusalValidationError' } });
        // Nor an injected one.
        app.failNext('user.get', { reason: 'refusal', message: { type: 'warning', code: 'app/gone' as never, content: 'Gone.' } });
        assertApiFailure(await callerOf(app).apiOutcome('user.get', { userId: '1' }), 'server', { status: 500 });
        vi.restoreAllMocks();
    });

    it('parses a declared code\'s data as the server does: from the input form, defaults filled and transforms run once, and nothing else is sent', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = createDerivedApp();
        // ctx.refuse takes the input form: `by` defaults and `days` transforms on the way out, exactly once.
        app.override('user.get', async ({ refuse }) => refuse('Archived.', { code: 'app/user-archived', data: { since: '2024-01-01', days: 2 } }));
        const archived = await callerOf(app).apiOutcome('user.get', { userId: '1' });
        assertApiRefusal(archived, 'app/user-archived');
        expect(archived.refusal.data).toEqual({ since: '2024-01-01', by: 'system', days: 48 });
        // Without its data, or with data its schema rejects, the code is not sent.
        app.override('user.get', async () => refuse('Archived.', { code: 'app/user-archived' }));
        assertApiFailure(await callerOf(app).apiOutcome('user.get', { userId: '1' }), 'server', { status: 500 });
        expect(app.calls.at(-1)?.error).toMatchObject({ name: 'LambderApiRefusalValidationError', message: expect.stringContaining('which carries data, and no data') });
        app.override('user.get', async () => refuse('Archived.', { code: 'app/user-archived', data: { since: 'yesterday' } }));
        assertApiFailure(await callerOf(app).apiOutcome('user.get', { userId: '1' }), 'server', { status: 500 });
        expect(app.calls.at(-1)?.error).toMatchObject({ message: expect.stringContaining('data its schema does not accept') });
        // Nor is data on a code that carries none.
        const jar = new LambderCookieJar();
        await app.signIn('ada', { userId: 'ada', tenants: [{ tenantId: 't1', role: 'writer' }] }, { jar });
        app.override('order.create', async () => refuse('No.', { code: 'app/read-only', data: { why: 'frozen' } }));
        assertApiFailure(await callerOf(app, jar).apiOutcome('order.create', { qty: 1 }, { guardInputs: { tenant: { tenantId: 't1' } }, idempotencyKey: createIdempotencyKey() }), 'server', { status: 500 });
        expect(app.calls.at(-1)?.error).toMatchObject({ message: expect.stringContaining('and data it does not declare') });
        vi.restoreAllMocks();
    });

    it('needs the vocabulary declared on the init when the tables name a code, and refuses a table naming one the vocabulary does not hold', () => {
        const undeclared = mock.create({ ...requiredOptions, apiOptions: contractOptions, guardDeclarations: contractGuardDeclarations });
        expect(() => undeclared.api('user.get', async () => ({ id: '1', name: 'Ada' })))
            .toThrow(/"user\.get" can refuse with declared codes by the apiOptions table, and the mock init declared no refusal vocabulary/);
        const missingOne = mock.declareRefusals({ 'app/not-a-member': {} }).create({ ...requiredOptions, apiOptions: contractOptions, guardDeclarations: contractGuardDeclarations });
        expect(() => missingOne.api('order.create', async () => ({ orderId: 'o', qty: 1 })))
            .toThrow(/"order\.create" can refuse with "app\/read-only" by the apiOptions and guardDeclarations tables, which the vocabulary declared on the mock init does not hold/);
    });

    it('takes the vocabulary as the list of maps the server declares, and refuses a code two of them declare', async () => {
        const { 'app/user-archived': archived, ...memberRefusals } = contractVocabulary;
        const listed = mock.declareRefusals([memberRefusals, { 'app/user-archived': archived }])
            .create({ ...requiredOptions, guards: declaredGuards, apiOptions: contractOptions, guardDeclarations: contractGuardDeclarations });
        expect(() => listed.api('order.create', async () => ({ orderId: 'o', qty: 1 }))).not.toThrow();
        // @ts-expect-error "app/read-only" is declared in two of the maps
        expect(() => mock.declareRefusals([memberRefusals, { 'app/read-only': {} }])).toThrow(/the refusal code "app\/read-only" is declared in two of the maps given to declareRefusals\(\)/);
    });

    it('requires a code on every refusal when the vocabulary says so, as the server does', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const strict = mock.declareRefusals(contractVocabulary, { requireCodes: true })
            .create({ ...requiredOptions, guards: declaredGuards, apiOptions: contractOptions, guardDeclarations: contractGuardDeclarations });
        strict.register(strict.apiSlice(strict.api('user.get', async (ctx) => {
            // @ts-expect-error a refusal names a code here
            if(Math.random() > 2) ctx.refuse('Plain.');
            // The free refuse() still compiles; the render check is what catches it.
            return refuse('Plain.');
        })), strict.restNotMocked('not mocked'));
        assertApiFailure(await callerOf(strict).apiOutcome('user.get', { userId: '1' }), 'server', { status: 500 });
        expect(strict.calls.at(-1)?.error).toMatchObject({ name: 'LambderApiRefusalValidationError', message: expect.stringContaining('refused without a code') });
        // The switch needs the table that says which codes an entry may send.
        expect(() => mock.declareRefusals(contractVocabulary, { requireCodes: true }).create({ ...requiredOptions })).toThrow(/requireCodes needs the apiOptions table/);
        vi.restoreAllMocks();
    });

    it('needs the guard declarations beside a table whose entries declare guards, since they hold the guards\' codes', () => {
        const app = mock.create({ ...requiredOptions, apiOptions: contractOptions });
        expect(() => app.api('order.create', async () => ({ orderId: 'o', qty: 1 })))
            .toThrow(/"order\.create" declares guards in the apiOptions table, and create\(\) was not given the guardDeclarations table/);
    });

    it('refuses an entry that restates an option the table declares, at compile time and at runtime', () => {
        const app = mock.create({ ...requiredOptions, apiOptions: contractOptions });
        // @ts-expect-error the table declares the guards: a restatement is a second copy of the server's declaration.
        expect(() => app.api('order.create', { guards: { tenant: 'writer' }, handler: async () => ({ orderId: 'o', qty: 1 }) }))
            .toThrow('LambderMockApp: "order.create" restates its guards option, which the apiOptions table given to create() already declares. Leave it out of the entry.');
        // @ts-expect-error nor the rate limit.
        expect(() => app.api('tools.limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) })).toThrow(/restates its rateLimit option/);
    });

    it('holds the table to the contract: every endpoint, each under its mode', () => {
        const { 'account.me': _me, ...missingMe } = contractOptions;
        // @ts-expect-error the table has no entry for account.me, so it predates the contract.
        mock.create({ ...requiredOptions, apiOptions: missingMe });
        // @ts-expect-error the table calls account.me public where the contract says session.
        mock.create({ ...requiredOptions, apiOptions: { ...contractOptions, 'account.me': { mode: 'public' } } as const });

        // What a stale table meets at runtime, for a caller the compiler did not see.
        const stale = mock.create({ ...requiredOptions, apiOptions: missingMe as typeof contractOptions });
        expect(() => stale.api('account.me', async () => ({ userId: 'x' })))
            .toThrow('LambderMockApp: "account.me" has no entry in the apiOptions table given to create(). The table predates this endpoint: regenerate it with writeApiOptions.');
        // An entry states no mode of its own, so it runs under the table's:
        // a table stale on a mode is the compiler's to refuse, above.
        const swapped = mock.create({ ...requiredOptions, apiOptions: { ...contractOptions, 'account.me': { mode: 'public' } } as unknown as typeof contractOptions });
        expect(swapped.api('account.me', async () => ({ userId: 'x' })).mode).toBe('public');
    });

    it('answers a rest entry under the mode the table gives the name, so an unmocked session endpoint reads the session first', async () => {
        const app = createDerivedApp();

        const signedOut = await callerOf(app).apiOutcome('admin.audit', {});
        assertApiFailure(signedOut, 'sessionExpired');
        expect(app.calls.at(-1)).toMatchObject({ outcome: 'sessionExpired', mode: 'session' });

        const jar = new LambderCookieJar();
        await app.signIn('ada', { userId: 'ada', tenants: [] }, { jar });
        const signedIn = await callerOf(app, jar).apiOutcome('admin.audit', {});
        assertApiFailure(signedIn);
        expect(signedIn.refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.notMocked });

        const publicOne = await callerOf(app).apiOutcome('admin.run', {});
        assertApiFailure(publicOne);
        expect(publicOne.refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.notMocked });
        expect(app.calls.at(-1)).toMatchObject({ outcome: 'notMocked', mode: 'public' });
    });
});

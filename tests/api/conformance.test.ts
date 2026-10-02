/**
 * The adapter conformance suite: one API declaration driven through the
 * Lambda server (a real Lambder instance over memory stores, called
 * in-process through the typed caller) and through LambderMockApp, with the
 * same declarations restated, asserting identical status, headers and
 * envelope across the protocol matrix. The pipeline is shared, so what this
 * pins is the two adapters: how each reads a request and hands back an
 * answer.
 */

import { testPublicFiles } from '../helpers.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { apiNameKeyOf, type LambderApiSignatureMap } from '../../src/shared/wire/LambderApiSignatureMap.js';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import LambderCaller from '../../src/client/LambderCaller.js';
import { lambderHandlerTransport } from '../../src/invoke/lambderHandlerTransport.js';
import { lambderCookieJarTransport } from '../../src/shared/transport/lambderCookieJarTransport.js';
import type { LambderApiTransport } from '../../src/shared/transport/LambderApiTransport.js';
import { LambderCookieJar } from '../../src/shared/transport/LambderCookieJar.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { initLambderMock } from '../../src/mock/LambderMockApp.js';
import { lambderMockInvokeTransport } from '../../src/mock/lambderMockInvokeTransport.js';
import { lambderMockMswHandler, type LambderMswModule } from '../../src/mock/lambderMockMswHandler.js';
import { decodeLambdaHttpResult, localLambdaContext, synthesizeLambdaHttpEvent } from '../../src/invoke/LambderLambdaEvent.js';
import { LAMBDER_REFUSAL_CODES, refuse } from '../../src/shared/wire/LambderApiRefusal.js';

type SessionData = { userId: string; role: 'admin' | 'member' };
const IDEMPOTENCY_KEY = 'k-conformance-abcdefabcdef';

/** A gate a handler can hold open, so a duplicate can arrive while the original is in flight. */
const makeGate = () => {
    let release = () => {};
    let enter = () => {};
    const opened = new Promise<void>((resolve) => { release = resolve; });
    /** Resolves once the handler is inside the gate, so a test can wait for that instead of guessing a delay. */
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    return { opened, entered, release: () => release(), enter: () => enter() };
};

const serverGuards = {
    signedIn: lambderGuard({ session: true, handler: async () => {} }),
    role: lambderGuard({
        guardInput: z.object({ wanted: z.enum(['admin', 'member']) }),
        session: true,
        refusals: ['app/wrong-role'],
        handler: (ctx, { wanted }, _param: true) => {
            if(ctx.session.data.role !== wanted) refuse('Wrong role.', { code: 'app/wrong-role' });
            return { role: ctx.session.data.role };
        },
    }),
};

const createServer = (gate: ReturnType<typeof makeGate>) => {
    const app = initLambder<SessionData>().declareRefusals({ 'app/nope': {}, 'app/wrong-role': { notAuthorized: true } }).create({
        files: testPublicFiles(),
        apiPath: '/api',
        apiVersion: '1',
        apiSignatures: serverSignatures,
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        guards: serverGuards,
        rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { tight: { perMin: 1, per: 'ip' }, perCaller: { perMin: 1, per: 'session' } } },
        // An identity, so a public endpoint's stored answer is scoped to the
        // caller that made it rather than replaying to whoever presents the
        // key. Both sides read the same field of the same request type.
        idempotency: { store: new LambderMemoryIdempotencyStore(), callerIdentity: (_ctx, request) => request.ip },
    });
    const { defineApi } = app;
    let counter = 0;
    return app.registerApiGroups(
        app.defineApiGroup('test', {
            ok: defineApi({ input: z.object({ n: z.number() }), output: z.object({ doubled: z.number() }) }, async (ctx) => ({ doubled: ctx.apiPayload.n * 2 })),
            refuse: defineApi({ input: z.object({}), output: z.any(), refusals: 'app/nope' }, async (ctx) => ctx.refuse('Nope.', { code: 'app/nope', title: 'No' })),
            deny: defineApi({ input: z.object({}), output: z.any() }, async () => refuse('Denied.', { notAuthorized: true })),
            limited: defineApi({ input: z.object({}), output: z.object({ n: z.number() }), rateLimit: 'tight' }, async (_ctx) => ({ n: 1 })),
            noted: defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (ctx) => {
                ctx.logList.push('a line for the envelope');
                return { ok: true };
            }),
            headed: defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (ctx) => {
                ctx.responseHeaders.set('X-Observed', 'from the handler');
                return { ok: true };
            }),
            once: defineApi({ input: z.object({}), output: z.object({ counter: z.number() }), idempotency: true }, async (_ctx) => { counter += 1; return { counter }; }),
            slow: defineApi({ input: z.object({}), output: z.object({ done: z.boolean() }), idempotency: true }, async (_ctx) => { gate.enter(); await gate.opened; return { done: true }; }),
            crash: defineApi({ input: z.object({}), output: z.any() }, async () => { throw new Error('boom'); }),
            // A handler that writes the call's headers and then throws: the one
            // exit where "the headers belong to the call" is easiest to lose,
            // because the crash unwinds past the step that drains them.
            crashAfterLogin: defineApi({ input: z.object({}), output: z.any() }, async (ctx) => {
                await app.getSessionController(ctx).createSession('ada', { userId: 'ada', role: 'admin' });
                throw new Error('boom');
            }),
            echo: defineApi({ input: z.object({ notes: z.array(z.string()) }), output: z.object({ count: z.number() }) }, async (ctx) => ({ count: ctx.apiPayload.notes.length })),
        }),
        app.defineApiGroup('account', {
            login: defineApi({ input: z.object({ user: z.string(), role: z.enum(['admin', 'member']) }), output: z.object({ ok: z.boolean() }) },
                async (ctx) => { await app.getSessionController(ctx).createSession(ctx.apiPayload.user, { userId: ctx.apiPayload.user, role: ctx.apiPayload.role }); return { ok: true }; }),
            me: defineApi({ input: z.object({}), output: z.object({ userId: z.string() }), guards: 'signedIn' }, async (ctx) => ({ userId: ctx.session.data.userId })),
            guarded: defineApi({ input: z.object({}), output: z.object({ role: z.string() }), guards: { role: true } }, async (ctx) => ({ role: ctx.guardData.role.role })),
            limitedPerCaller: defineApi({ input: z.object({}), output: z.object({ n: z.number() }), guards: 'signedIn', rateLimit: 'perCaller' }, async (_ctx) => ({ n: 1 })),
        }),
    );
};

type Contract = ReturnType<typeof createServer>['ApiContract'];

const createMock = (gate: ReturnType<typeof makeGate>) => {
    const mock = initLambderMock<Contract, SessionData>();
    const mockApp = mock.create({
        apiVersion: '1',
        apiSignatures: serverSignatures,
        // The mock reveals a thrown handler's message by default, which is a
        // development convenience and a deliberate difference from the server.
        // This suite compares the two in the shape they ship in.
        revealHandlerErrors: false,
        sessions: true,
        rateLimits: { policies: { tight: { perMin: 1, per: 'ip' }, perCaller: { perMin: 1, per: 'session' } } },
        idempotency: { callerIdentity: (_ctx, request) => request.ip },
        guards: {
            signedIn: mock.guard({ session: true, handler: async () => {} }),
            role: mock.guard({
                guardInput: z.object({ wanted: z.enum(['admin', 'member']) }),
                session: true,
                handler: (ctx, { wanted }, _param: true) => {
                    if(ctx.session.data.role !== wanted) refuse('Wrong role.', { code: 'app/wrong-role', notAuthorized: true });
                    return { role: ctx.session.data.role };
                },
            }),
        },
    });
    let counter = 0;
    mockApp.register(mockApp.apiSlice(
        // The entry's own input schema, restated: what it parses to is pinned
        // to the contract, and this is the cell that compares its 422 to the
        // server's rather than only to itself.
        mockApp.api('test.ok', { input: z.object({ n: z.number() }), handler: async ({ payload }) => ({ doubled: payload.n * 2 }) }),
        mockApp.api('test.refuse', async (ctx) => ctx.refuse('Nope.', { code: 'app/nope', title: 'No' })),
        mockApp.api('test.deny', async () => refuse('Denied.', { notAuthorized: true })),
        mockApp.api('account.login', async ({ payload, sessionController }) => { await sessionController.createSession(payload.user, { userId: payload.user, role: payload.role }); return { ok: true }; }),
        // A session endpoint restates the guard that makes it one: without
        // the apiOptions table, that is how the mock knows its mode.
        mockApp.api('account.me', { guards: 'signedIn', handler: async ({ session }) => ({ userId: session.data.userId }) }),
        mockApp.api('account.guarded', { guards: { role: true }, handler: async ({ guardData }) => ({ role: guardData.role.role }) }),
        mockApp.api('test.limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) }),
        mockApp.api('account.limitedPerCaller', { guards: 'signedIn', rateLimit: 'perCaller', handler: async () => ({ n: 1 }) }),
        mockApp.api('test.noted', async ({ logList }) => {
            logList.push('a line for the envelope');
            return { ok: true };
        }),
        mockApp.api('test.headed', async ({ responseHeaders }) => {
            responseHeaders.set('X-Observed', 'from the handler');
            return { ok: true };
        }),
        mockApp.api('test.once', { idempotency: true, handler: async () => { counter += 1; return { counter }; } }),
        mockApp.api('test.slow', { idempotency: true, handler: async () => { gate.enter(); await gate.opened; return { done: true }; } }),
        mockApp.api('test.crash', async () => { throw new Error('boom'); }),
        mockApp.api('test.crashAfterLogin', async ({ sessionController }) => {
            await sessionController.createSession('ada', { userId: 'ada', role: 'admin' });
            throw new Error('boom');
        }),
        mockApp.api('test.echo', async ({ payload }) => ({ count: payload.notes.length })),
    ));
    return mockApp;
};

/** What one side answered, in the terms the matrix compares: status, the headers that matter, the envelope. */
type Observed = { status: number; retryAfter: string | null; handlerHeader: string | null; setCookies: number; envelope: unknown; reason: string };

const observing = (transport: LambderApiTransport, sink: Observed[]): LambderApiTransport => async (request) => {
    const answer = await transport(request);
    const text = await answer.text();
    let envelope: unknown;
    try { envelope = JSON.parse(text); } catch { envelope = text; }
    sink.push({
        status: answer.status,
        retryAfter: answer.header('retry-after') ?? null,
        // A header a handler wrote, which reaches the answer through the call
        // context on both sides and is the one part of an answer neither the
        // envelope nor the status shows.
        handlerHeader: answer.header('x-observed') ?? null,
        setCookies: answer.setCookies?.length ?? 0,
        envelope,
        reason: '',
    });
    return { ...answer, text: async () => text, json: async () => JSON.parse(text) };
};

/** The server's own map, as the generator would write it: what the mock is given so it judges signatures as the server does. */
const serverSignatures: LambderApiSignatureMap = {};
beforeAll(async () => { Object.assign(serverSignatures, await createServer(makeGate()).apiSignatures()); });

/** Both sides, side by side: a caller per side over a fresh cookie jar, and what each observed. */
const createSides = (options: { apiSignatures?: LambderApiSignatureMap; requestCompression?: boolean } = {}) => {
    const serverGate = makeGate();
    const mockGate = makeGate();
    const server = createServer(serverGate);
    const mockApp = createMock(mockGate);
    const observed = { server: [] as Observed[], mock: [] as Observed[] };
    /** One browser per side, from one client address: its own jar, its own session, its own identity. */
    const callerPair = (clientIp: string) => ({
        server: new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false, apiVersion: '1', apiSignatures: options.apiSignatures, requestCompression: options.requestCompression,
            transport: observing(lambderCookieJarTransport(lambderHandlerTransport(server.getHandler(), { clientIp }), { jar: new LambderCookieJar() }), observed.server),
        }),
        mock: new LambderCaller<Contract>({
            apiPath: '/api', isCorsEnabled: false, apiVersion: '1', apiSignatures: options.apiSignatures, requestCompression: options.requestCompression,
            transport: observing(mockApp.transport({ clientIp }), observed.mock),
        }),
    });
    const here = callerPair('127.0.0.1');
    const stranger = callerPair('10.0.0.2');
    return { server, mockApp, serverCaller: here.server, mockCaller: here.mock, stranger, observed, serverGate, mockGate };
};

/** Runs the same call on both sides and asserts they observed the same thing, reason included. */
const same = async <K extends keyof Contract & string>(
    sides: ReturnType<typeof createSides>,
    apiName: K | string,
    payload: Contract[K]['input'],
    // The key is `unknown` because the matrix also posts one that is not a
    // string, which is a call the engine refuses on both sides.
    options?: { guardInputs?: Record<string, unknown>; idempotencyKey?: unknown; from?: 'stranger' },
) => {
    // The typed caller has no way to express a non-string key, hence the
    // cast: the sides are compared there on the engine's answer to it.
    const { from, ...rest } = options ?? {};
    const callOptions = rest as { guardInputs?: Record<string, unknown>; idempotencyKey?: string };
    const [serverCaller, mockCaller] = from === 'stranger'
        ? [sides.stranger.server, sides.stranger.mock]
        : [sides.serverCaller, sides.mockCaller];
    // Untyped here on purpose: the matrix also sends names the contract does not know.
    const serverOutcome = await (serverCaller as LambderCaller<any>).apiOutcome(apiName, payload, callOptions);
    const mockOutcome = await (mockCaller as LambderCaller<any>).apiOutcome(apiName, payload, callOptions);
    const serverSeen = sides.observed.server.at(-1)!;
    const mockSeen = sides.observed.mock.at(-1)!;
    const reasonOf = (outcome: typeof serverOutcome) => outcome.ok ? 'ok' : outcome.reason;
    expect({ ...mockSeen, reason: reasonOf(mockOutcome) }).toEqual({ ...serverSeen, reason: reasonOf(serverOutcome) });
    return { serverOutcome, mockOutcome, seen: serverSeen };
};

describe('Adapter conformance: the server and the mock answer alike', () => {
    it('ok: the same envelope', async () => {
        const { seen } = await same(createSides(), 'test.ok', { n: 21 });
        expect(seen).toMatchObject({ status: 200, envelope: { apiVersion: '1', payload: { doubled: 42 } } });
    });

    it('a refusal with a code and a title, and a notAuthorized refusal', async () => {
        const sides = createSides();
        const refused = await same(sides, 'test.refuse', {});
        expect(refused.seen.envelope).toEqual({ apiVersion: '1', payload: null, refusal: { type: 'warning', code: 'app/nope', title: 'No', content: 'Nope.' } });
        const denied = await same(sides, 'test.deny', {});
        expect(denied.seen.envelope).toMatchObject({ notAuthorized: true });
        expect(denied.mockOutcome.ok ? '' : denied.mockOutcome.reason).toBe('notAuthorized');
    });

    it('sessionExpired without a session, then login sets the same cookies and the session call reads them', async () => {
        const sides = createSides();
        const expired = await same(sides, 'account.me', {});
        expect(expired.seen.envelope).toEqual({ apiVersion: '1', payload: null, sessionExpired: true });

        const login = await same(sides, 'account.login', { user: 'ada', role: 'admin' });
        expect(login.seen.setCookies).toBe(2);
        const me = await same(sides, 'account.me', {});
        expect(me.seen.envelope).toEqual({ apiVersion: '1', payload: { userId: 'ada' } });
    });

    it('a guard with a client input: the same guardData, the same notAuthorized refusal, the same 422 for a missing input', async () => {
        const sides = createSides();
        await same(sides, 'account.login', { user: 'ada', role: 'member' });
        const allowed = await same(sides, 'account.guarded', {}, { guardInputs: { role: { wanted: 'member' } } });
        expect(allowed.seen.envelope).toMatchObject({ payload: { role: 'member' } });
        const refused = await same(sides, 'account.guarded', {}, { guardInputs: { role: { wanted: 'admin' } } });
        expect(refused.seen.envelope).toMatchObject({ notAuthorized: true, refusal: { code: 'app/wrong-role' } });
        const missing = await same(sides, 'account.guarded', {}, { guardInputs: { role: {} as never } });
        expect(missing.seen.status).toBe(422);
        expect(missing.mockOutcome.ok ? '' : missing.mockOutcome.reason).toBe('validation');
    });

    it('versionExpired for a caller built against another shape of the endpoint, and a pass for the current one', async () => {
        const stale = { ...serverSignatures, [await apiNameKeyOf('test.ok')]: 'an-older-shape' };
        const { seen } = await same(createSides({ apiSignatures: stale }), 'test.ok', { n: 1 });
        expect(seen.envelope).toEqual({ apiVersion: '1', payload: null, versionExpired: true });
        const current = await same(createSides({ apiSignatures: serverSignatures }), 'test.ok', { n: 21 });
        expect(current.seen.envelope).toEqual({ apiVersion: '1', payload: { doubled: 42 } });
    });

    it('a version below minApiVersion: versionExpired on both sides, whatever the signature says', async () => {
        const floorApp = initLambder().create({ files: testPublicFiles(), apiPath: '/api', apiVersion: '1.2.32', minApiVersion: '1.2.10' });
        const server = floorApp.registerApiGroups(floorApp.defineApiGroup('test', {
            ok: floorApp.defineApi({ input: z.object({ n: z.number() }), output: z.object({ doubled: z.number() }) }, async (ctx) => ({ doubled: ctx.apiPayload.n * 2 })),
        }));
        type FloorContract = typeof server.ApiContract;
        const floorMock = initLambderMock<FloorContract>().create({ apiVersion: '1.2.32', minApiVersion: '1.2.10', apiSignatures: await server.apiSignatures() });
        floorMock.register(floorMock.apiSlice(floorMock.api('test.ok', async ({ payload }) => ({ doubled: payload.n * 2 }))));
        const signatures = await server.apiSignatures();
        const bothSides = async (version: string) => {
            const onServer = await new LambderCaller<FloorContract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: version, apiSignatures: signatures, transport: lambderHandlerTransport(server.getHandler()) }).apiOutcome('test.ok', { n: 2 });
            const onMock = await new LambderCaller<FloorContract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: version, apiSignatures: signatures, transport: floorMock.transport() }).apiOutcome('test.ok', { n: 2 });
            return [onServer, onMock].map((outcome) => outcome.ok ? 'ok' : outcome.reason);
        };
        expect(await bothSides('1.2.9')).toEqual(['versionExpired', 'versionExpired']);
        expect(await bothSides('1.2.10')).toEqual(['ok', 'ok']);
        expect(await bothSides('1.3.0')).toEqual(['ok', 'ok']);
    });

    it('a body that is not a JSON object: the same invalid-payload refusal from the server and from every mock adapter that reads a body', async () => {
        const { server, mockApp } = createSides();
        const handler = server.getHandler();
        const invokeTransport = lambderMockInvokeTransport(mockApp);
        let mswResolver: Parameters<LambderMswModule['http']['post']>[1] | null = null;
        lambderMockMswHandler(mockApp, {
            apiPath: '/api',
            msw: { http: { post: (_path, resolver) => { mswResolver = resolver; return null; }, all: () => null }, HttpResponse: Response },
        });
        for(const body of ['5', '"x"', 'true', 'null', '[1,2]', 'not json']){
            const event = synthesizeLambdaHttpEvent({ method: 'POST', path: '/api/test/ok', host: 'localhost', body, contentType: 'application/json' }, { invoke: false });
            const onServer = await decodeLambdaHttpResult(await handler(event, localLambdaContext('conformance')), 1_000_000);
            const seen = { status: onServer.statusCode, envelope: onServer.json() };
            expect(seen).toEqual({
                status: 400,
                envelope: { apiVersion: '1', payload: null, refusal: { type: 'error', code: LAMBDER_REFUSAL_CODES.invalidRequestPayload, content: expect.stringMatching(/^Request body must be a JSON object/) } },
            });
            const onInvoke = (await invokeTransport(event, {})).result;
            expect({ status: onInvoke.statusCode, envelope: JSON.parse(onInvoke.body) }).toEqual(seen);
            const onMsw = await mswResolver!({ request: new Request('http://localhost/api/test/ok', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }) });
            expect({ status: onMsw?.status, envelope: await onMsw?.json() }).toEqual(seen);
        }
    });

    it('a minApiVersion above apiVersion: refused at creation on both sides', () => {
        const refusal = /Lambder: minApiVersion 1\.5\.0 is above apiVersion 1\.2\.0/;
        expect(() => initLambder().create({ apiPath: '/api', apiVersion: '1.2.0', minApiVersion: '1.5.0' })).toThrow(refusal);
        expect(() => initLambderMock<{}>().create({ apiVersion: '1.2.0', minApiVersion: '1.5.0' })).toThrow(refusal);
    });

    it('rate limited: the same 429 envelope with a Retry-After, its data naming the policy and the same wait', async () => {
        const sides = createSides();
        await same(sides, 'test.limited', {});
        const blocked = await same(sides, 'test.limited', {});
        expect(blocked.seen.status).toBe(429);
        expect(Number(blocked.seen.retryAfter)).toBeGreaterThanOrEqual(1);
        expect(blocked.seen.envelope).toMatchObject({ refusal: { code: 'lambder/rate-limited', data: { policy: 'tight', retryAfterSeconds: Number(blocked.seen.retryAfter) } } });
    });

    it('idempotent replay: the same stored answer, the handler run once on each side', async () => {
        const sides = createSides();
        const first = await same(sides, 'test.once', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        const replay = await same(sides, 'test.once', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        expect(replay.seen.envelope).toEqual(first.seen.envelope);
        expect(replay.seen.envelope).toMatchObject({ payload: { counter: 1 } });
    });

    it('duplicate in flight: the same 409 while the original is still running', async () => {
        const sides = createSides();
        const originals = [sides.serverCaller.apiOutcome('test.slow', {}, { idempotencyKey: IDEMPOTENCY_KEY }), sides.mockCaller.apiOutcome('test.slow', {}, { idempotencyKey: IDEMPOTENCY_KEY })];
        // Both originals hold their claim once their handler has entered the gate.
        await Promise.all([sides.serverGate.entered, sides.mockGate.entered]);
        const duplicate = await same(sides, 'test.slow', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        expect(duplicate.seen.status).toBe(409);
        expect(duplicate.seen.envelope).toMatchObject({ refusal: { code: 'lambder/duplicate-in-flight' } });
        sides.serverGate.release();
        sides.mockGate.release();
        const [serverOriginal, mockOriginal] = await Promise.all(originals);
        expect(serverOriginal.ok && mockOriginal.ok).toBe(true);
    });

    it("an entry's own input schema: the same 422 as the server's schema", async () => {
        // The mock's schema is the mock's, because the contract is a type and
        // the server's schemas do not exist on this side. Without this cell,
        // what it answers a bad payload with is only compared to itself.
        const { seen, mockOutcome } = await same(createSides(), 'test.ok', { n: 'not a number' } as never);
        expect(seen.status).toBe(422);
        expect(mockOutcome.ok ? '' : mockOutcome.reason).toBe('validation');
    });

    it('the envelope beside the payload: the same logList', async () => {
        // Both handlers return their payload, and what else the envelope
        // carries goes on the context: ctx.logList on either side.
        const { seen } = await same(createSides(), 'test.noted', {});
        expect(seen.envelope).toEqual({
            apiVersion: '1', payload: { ok: true },
            logList: ['a line for the envelope'],
        });
    });

    it('a header a handler wrote: on the answer on both sides', async () => {
        const { seen } = await same(createSides(), 'test.headed', {});
        expect(seen.handlerHeader).toBe('from the handler');
    });

    it('an idempotency key that is not a string: the same 400 on both sides', async () => {
        // The key is client data, and only the engine judges it. A handler
        // never sees a non-string one; what matters here is that the mock
        // refuses it where the server does rather than running the handler.
        const { seen } = await same(createSides(), 'test.once', {}, { idempotencyKey: 42 });
        expect(seen.status).toBe(400);
    });

    it('an identity-scoped replay: the same answer for one caller, a fresh run for another', async () => {
        // Without an identity the scope of a public endpoint is the posted key
        // alone, which makes that key a bearer token for its own stored
        // answer. Configured on both sides, the scope has to be the same one.
        const sides = createSides();
        const first = await same(sides, 'test.once', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        const replay = await same(sides, 'test.once', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        expect(replay.seen.envelope).toEqual(first.seen.envelope);

        const stranger = await same(sides, 'test.once', {}, { idempotencyKey: IDEMPOTENCY_KEY, from: 'stranger' });
        expect(stranger.seen.envelope).toMatchObject({ payload: { counter: 2 } });
    });

    it('a per-session rate limit: the same 429 for the session that spent it', async () => {
        // The other key an endpoint can be limited by, and the one that needs
        // the session read to have happened first.
        const sides = createSides();
        await same(sides, 'account.login', { user: 'ada', role: 'admin' });
        await same(sides, 'account.limitedPerCaller', {});
        const blocked = await same(sides, 'account.limitedPerCaller', {});
        expect(blocked.seen.status).toBe(429);
        expect(blocked.seen.envelope).toMatchObject({ refusal: { code: 'lambder/rate-limited', data: { policy: 'perCaller' } } });

        // Another session is another counter, on both sides.
        await same(sides, 'account.login', { user: 'bob', role: 'member' }, { from: 'stranger' });
        const other = await same(sides, 'account.limitedPerCaller', {}, { from: 'stranger' });
        expect(other.seen.status).toBe(200);
    });

    it('an unknown api: the same apiNotFound refusal', async () => {
        const { seen } = await same(createSides(), 'test.nope', {});
        expect(seen.envelope).toEqual({ apiVersion: '1', payload: null, refusal: { type: 'warning', code: 'lambder/api-not-found', content: 'API not found.' } });
    });

    it('an unknown api from a signed caller: the signature gate answers first on both sides', async () => {
        // A caller whose map holds a name the server does not have was built
        // against another contract, so both sides say versionExpired rather
        // than apiNotFound. A mock that resolved the name first would answer
        // apiNotFound where the server does not.
        const withNope = { ...serverSignatures, [await apiNameKeyOf('test.nope')]: 'from-another-contract' };
        const { seen } = await same(createSides({ apiSignatures: withNope }), 'test.nope', {});
        expect(seen.envelope).toEqual({ apiVersion: '1', payload: null, versionExpired: true });
    });

    it('a malformed compressed payload on an unknown api: the same 400 on both sides', async () => {
        // The other half of the same pre-pass. A mock that reached apiNotFound
        // without restoring the payload would answer a request the server
        // rejects as unreadable with a 200 and a refusal.
        const sides = createSides();
        const call = (transport: LambderApiTransport) => transport({
            apiPath: '/api', apiName: 'test.nope', version: '1', token: '', siteHost: '',
            compressed: { payloadGz: 'not-base64!!!', payloadBytes: 10 },
        });

        const serverAnswer = await call(lambderHandlerTransport(sides.server.getHandler()));
        const mockAnswer = await call(sides.mockApp.transport());

        expect(mockAnswer.status).toBe(serverAnswer.status);
        expect(JSON.parse(await mockAnswer.text())).toEqual(JSON.parse(await serverAnswer.text()));
        expect(serverAnswer.status).toBe(400);
    });

    it('a crash: the same 500 envelope', async () => {
        const { seen, mockOutcome } = await same(createSides(), 'test.crash', {});
        expect(seen).toMatchObject({ status: 500, envelope: { apiVersion: '1', payload: null, refusal: { type: 'error', content: 'Internal server error.' } } });
        expect(mockOutcome.ok ? '' : mockOutcome.reason).toBe('server');
    });

    it('a crash after a session was created: 500 on both sides, both cookies still on the answer', async () => {
        // The call's headers belong to the call however it ended. The pipeline
        // drains them for the answers it produces itself, and a crash unwinds
        // past that, so this is the exit where the two adapters can part: a
        // handler that signed a user in and then threw would leave the browser
        // with no session cookie and nothing to explain it.
        const { seen, mockOutcome } = await same(createSides(), 'test.crashAfterLogin', {});
        expect(seen.status).toBe(500);
        expect(seen.setCookies).toBe(2);
        expect(mockOutcome.ok ? '' : mockOutcome.reason).toBe('server');
    });

    it('a compressed request payload: restored on both sides', async () => {
        const notes = Array.from({ length: 300 }, (_, i) => `note-${i} in the stockroom`);
        const { seen } = await same(createSides({ requestCompression: true }), 'test.echo', { notes });
        expect(seen.envelope).toEqual({ apiVersion: '1', payload: { count: 300 } });
    });
});

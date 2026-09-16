/**
 * The adapter conformance suite: one API declaration driven through the
 * Lambda server (a real Lambder instance over memory stores, called
 * in-process through the typed caller) and through LambderMockApp, with the
 * same declarations restated, asserting identical status, headers and
 * envelope across the protocol matrix. The pipeline is shared, so what this
 * pins is the two adapters: how each reads a request and hands back an
 * answer.
 */

import { testPublicFiles } from './helpers.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { apiNameKeyOf, type LambderApiSignatureMap } from '../src/shared/wire/LambderApiSignature.js';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import LambderCaller from '../src/client/LambderCaller.js';
import { lambderHandlerTransport } from '../src/invoke/lambderHandlerTransport.js';
import { lambderCookieJarTransport } from '../src/shared/transport/lambderCookieJarTransport.js';
import type { LambderApiTransport } from '../src/shared/transport/LambderApiTransport.js';
import { LambderCookieJar } from '../src/shared/transport/LambderCookieJar.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { initLambderMock } from '../src/mock/LambderMockApp.js';
import { refuse } from '../src/shared/wire/LambderApiRefusal.js';

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
    role: lambderGuard({
        guardInput: z.object({ wanted: z.enum(['admin', 'member']) }),
        session: true,
        handler: (ctx, { wanted }, _param: true) => {
            if(ctx.session.data.role !== wanted) refuse('Wrong role.', { code: 'app/wrong-role', notAuthorized: true });
            return { role: ctx.session.data.role };
        },
    }),
};

const createServer = (gate: ReturnType<typeof makeGate>) => {
    const app = initLambder<SessionData>().create({
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
    let counter = 0;
    return app
        .addApi('ok', { input: z.object({ n: z.number() }), output: z.object({ doubled: z.number() }) }, async (ctx, res) => res.api({ doubled: ctx.apiPayload.n * 2 }))
        .addApi('refuse', { input: z.object({}), output: z.any() }, async () => refuse('Nope.', { code: 'app/nope', title: 'No' }))
        .addApi('deny', { input: z.object({}), output: z.any() }, async () => refuse('Denied.', { notAuthorized: true }))
        .addApi('login', { input: z.object({ user: z.string(), role: z.enum(['admin', 'member']) }), output: z.object({ ok: z.boolean() }) },
            async (ctx, res) => { await app.getSessionController(ctx).createSession(ctx.apiPayload.user, { userId: ctx.apiPayload.user, role: ctx.apiPayload.role }); return res.api({ ok: true }); })
        .addSessionApi('me', { input: z.object({}), output: z.object({ userId: z.string() }) }, async (ctx, res) => res.api({ userId: ctx.session.data.userId }))
        .addSessionApi('guarded', { input: z.object({}), output: z.object({ role: z.string() }), guards: { role: true } }, async (ctx, res) => res.api({ role: ctx.guardData.role.role }))
        .addApi('limited', { input: z.object({}), output: z.object({ n: z.number() }), rateLimit: 'tight' }, async (_ctx, res) => res.api({ n: 1 }))
        .addSessionApi('limitedPerCaller', { input: z.object({}), output: z.object({ n: z.number() }), rateLimit: 'perCaller' }, async (_ctx, res) => res.api({ n: 1 }))
        .addApi('noted', { input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (ctx, res) => {
            ctx.logList.push('a line for the envelope');
            return res.api({ ok: true }, { message: 'a message beside the payload' });
        })
        .addApi('headed', { input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (ctx, res) => {
            ctx.responseHeaders.set('X-Observed', 'from the handler');
            return res.api({ ok: true });
        })
        .addApi('once', { input: z.object({}), output: z.object({ counter: z.number() }), idempotency: true }, async (_ctx, res) => { counter += 1; return res.api({ counter }); })
        .addApi('slow', { input: z.object({}), output: z.object({ done: z.boolean() }), idempotency: true }, async (_ctx, res) => { gate.enter(); await gate.opened; return res.api({ done: true }); })
        .addApi('crash', { input: z.object({}), output: z.any() }, async () => { throw new Error('boom'); })
        // A handler that writes the call's headers and then throws: the one
        // exit where "the headers belong to the call" is easiest to lose,
        // because the crash unwinds past the step that drains them.
        .addApi('crashAfterLogin', { input: z.object({}), output: z.any() }, async (ctx) => {
            await app.getSessionController(ctx).createSession('ada', { userId: 'ada', role: 'admin' });
            throw new Error('boom');
        })
        .addApi('echo', { input: z.object({ notes: z.array(z.string()) }), output: z.object({ count: z.number() }) }, async (ctx, res) => res.api({ count: ctx.apiPayload.notes.length }));
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
        mockApp.publicApi('ok', { input: z.object({ n: z.number() }), handler: async ({ payload }) => ({ doubled: payload.n * 2 }) }),
        mockApp.publicApi('refuse', async () => refuse('Nope.', { code: 'app/nope', title: 'No' })),
        mockApp.publicApi('deny', async () => refuse('Denied.', { notAuthorized: true })),
        mockApp.publicApi('login', async ({ payload, sessions }) => { await sessions.createSession(payload.user, { userId: payload.user, role: payload.role }); return { ok: true }; }),
        mockApp.sessionApi('me', async ({ session }) => ({ userId: session.data.userId })),
        mockApp.sessionApi('guarded', { guards: { role: true }, handler: async ({ guardData }) => ({ role: guardData.role.role }) }),
        mockApp.publicApi('limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) }),
        mockApp.sessionApi('limitedPerCaller', { rateLimit: 'perCaller', handler: async () => ({ n: 1 }) }),
        mockApp.publicApi('noted', async ({ envelope, logList }) => {
            logList.push('a line for the envelope');
            envelope.message = 'a message beside the payload';
            return { ok: true };
        }),
        mockApp.publicApi('headed', async ({ responseHeaders }) => {
            responseHeaders.set('X-Observed', 'from the handler');
            return { ok: true };
        }),
        mockApp.publicApi('once', { idempotency: true, handler: async () => { counter += 1; return { counter }; } }),
        mockApp.publicApi('slow', { idempotency: true, handler: async () => { gate.enter(); await gate.opened; return { done: true }; } }),
        mockApp.publicApi('crash', async () => { throw new Error('boom'); }),
        mockApp.publicApi('crashAfterLogin', async ({ sessions }) => {
            await sessions.createSession('ada', { userId: 'ada', role: 'admin' });
            throw new Error('boom');
        }),
        mockApp.publicApi('echo', async ({ payload }) => ({ count: payload.notes.length })),
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
    // The key is client data, and the matrix posts one that is not a string,
    // which the typed caller has no way to express: what the two sides are
    // compared on there is the engine's answer to a bad key.
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
        const { seen } = await same(createSides(), 'ok', { n: 21 });
        expect(seen).toMatchObject({ status: 200, envelope: { apiVersion: '1', payload: { doubled: 42 } } });
    });

    it('a refusal with a code and a title, and a notAuthorized refusal', async () => {
        const sides = createSides();
        const refused = await same(sides, 'refuse', {});
        expect(refused.seen.envelope).toEqual({ apiVersion: '1', payload: null, errorMessage: { type: 'warning', code: 'app/nope', title: 'No', content: 'Nope.' } });
        const denied = await same(sides, 'deny', {});
        expect(denied.seen.envelope).toMatchObject({ notAuthorized: true });
        expect(denied.mockOutcome.ok ? '' : denied.mockOutcome.reason).toBe('notAuthorized');
    });

    it('sessionExpired without a session, then login sets the same cookies and the session call reads them', async () => {
        const sides = createSides();
        const expired = await same(sides, 'me', {});
        expect(expired.seen.envelope).toEqual({ apiVersion: '1', payload: null, sessionExpired: true });

        const login = await same(sides, 'login', { user: 'ada', role: 'admin' });
        expect(login.seen.setCookies).toBe(2);
        const me = await same(sides, 'me', {});
        expect(me.seen.envelope).toEqual({ apiVersion: '1', payload: { userId: 'ada' } });
    });

    it('a guard with a client input: the same guardData, the same notAuthorized refusal, the same 422 for a missing input', async () => {
        const sides = createSides();
        await same(sides, 'login', { user: 'ada', role: 'member' });
        const allowed = await same(sides, 'guarded', {}, { guardInputs: { role: { wanted: 'member' } } });
        expect(allowed.seen.envelope).toMatchObject({ payload: { role: 'member' } });
        const refused = await same(sides, 'guarded', {}, { guardInputs: { role: { wanted: 'admin' } } });
        expect(refused.seen.envelope).toMatchObject({ notAuthorized: true, errorMessage: { code: 'app/wrong-role' } });
        const missing = await same(sides, 'guarded', {}, { guardInputs: { role: {} as never } });
        expect(missing.seen.status).toBe(422);
        expect(missing.mockOutcome.ok ? '' : missing.mockOutcome.reason).toBe('validation');
    });

    it('versionExpired for a caller built against another shape of the endpoint, and a pass for the current one', async () => {
        const stale = { ...serverSignatures, [await apiNameKeyOf('ok')]: 'an-older-shape' };
        const { seen } = await same(createSides({ apiSignatures: stale }), 'ok', { n: 1 });
        expect(seen.envelope).toEqual({ apiVersion: '1', payload: null, versionExpired: true });
        const current = await same(createSides({ apiSignatures: serverSignatures }), 'ok', { n: 21 });
        expect(current.seen.envelope).toEqual({ apiVersion: '1', payload: { doubled: 42 } });
    });

    it('a version below minApiVersion: versionExpired on both sides, whatever the signature says', async () => {
        const server = initLambder().create({ files: testPublicFiles(), apiPath: '/api', apiVersion: '1.2.32', minApiVersion: '1.2.10' })
            .addApi('ok', { input: z.object({ n: z.number() }), output: z.object({ doubled: z.number() }) }, async (ctx, res) => res.api({ doubled: ctx.apiPayload.n * 2 }));
        type FloorContract = typeof server.ApiContract;
        const floorMock = initLambderMock<FloorContract>().create({ apiVersion: '1.2.32', minApiVersion: '1.2.10', apiSignatures: await server.apiSignatures() });
        floorMock.register(floorMock.apiSlice(floorMock.publicApi('ok', async ({ payload }) => ({ doubled: payload.n * 2 }))));
        const signatures = await server.apiSignatures();
        const bothSides = async (version: string) => {
            const onServer = await new LambderCaller<FloorContract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: version, apiSignatures: signatures, transport: lambderHandlerTransport(server.getHandler()) }).apiOutcome('ok', { n: 2 });
            const onMock = await new LambderCaller<FloorContract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: version, apiSignatures: signatures, transport: floorMock.transport() }).apiOutcome('ok', { n: 2 });
            return [onServer, onMock].map((outcome) => outcome.ok ? 'ok' : outcome.reason);
        };
        expect(await bothSides('1.2.9')).toEqual(['versionExpired', 'versionExpired']);
        expect(await bothSides('1.2.10')).toEqual(['ok', 'ok']);
        expect(await bothSides('1.3.0')).toEqual(['ok', 'ok']);
    });

    it('rate limited: the same 429 envelope with a Retry-After', async () => {
        const sides = createSides();
        await same(sides, 'limited', {});
        const blocked = await same(sides, 'limited', {});
        expect(blocked.seen.status).toBe(429);
        expect(Number(blocked.seen.retryAfter)).toBeGreaterThanOrEqual(1);
        expect(blocked.seen.envelope).toMatchObject({ errorMessage: { code: 'lambder/rate-limited' } });
    });

    it('idempotent replay: the same stored answer, the handler run once on each side', async () => {
        const sides = createSides();
        const first = await same(sides, 'once', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        const replay = await same(sides, 'once', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        expect(replay.seen.envelope).toEqual(first.seen.envelope);
        expect(replay.seen.envelope).toMatchObject({ payload: { counter: 1 } });
    });

    it('duplicate in flight: the same 409 while the original is still running', async () => {
        const sides = createSides();
        const originals = [sides.serverCaller.apiOutcome('slow', {}, { idempotencyKey: IDEMPOTENCY_KEY }), sides.mockCaller.apiOutcome('slow', {}, { idempotencyKey: IDEMPOTENCY_KEY })];
        // Both originals hold their claim once their handler has entered the gate.
        await Promise.all([sides.serverGate.entered, sides.mockGate.entered]);
        const duplicate = await same(sides, 'slow', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        expect(duplicate.seen.status).toBe(409);
        expect(duplicate.seen.envelope).toMatchObject({ errorMessage: { code: 'lambder/duplicate-in-flight' } });
        sides.serverGate.release();
        sides.mockGate.release();
        const [serverOriginal, mockOriginal] = await Promise.all(originals);
        expect(serverOriginal.ok && mockOriginal.ok).toBe(true);
    });

    it("an entry's own input schema: the same 422 as the server's schema", async () => {
        // The mock's schema is the mock's, because the contract is a type and
        // the server's schemas do not exist on this side. What it answers a
        // bad payload with was only ever compared to itself.
        const { seen, mockOutcome } = await same(createSides(), 'ok', { n: 'not a number' } as never);
        expect(seen.status).toBe(422);
        expect(mockOutcome.ok ? '' : mockOutcome.reason).toBe('validation');
    });

    it('the envelope beside the payload: the same message and logList', async () => {
        // A mock handler returns its payload, so the rest of the envelope goes
        // on the context: ctx.envelope.message where a server handler passes
        // res.api(payload, { message }), and ctx.logList either way.
        const { seen } = await same(createSides(), 'noted', {});
        expect(seen.envelope).toEqual({
            apiVersion: '1', payload: { ok: true },
            message: 'a message beside the payload', logList: ['a line for the envelope'],
        });
    });

    it('a header a handler wrote: on the answer on both sides', async () => {
        const { seen } = await same(createSides(), 'headed', {});
        expect(seen.handlerHeader).toBe('from the handler');
    });

    it('an idempotency key that is not a string: the same 400 on both sides', async () => {
        // The key is client data, and only the engine judges it. A handler
        // never sees a non-string one; what matters here is that the mock
        // refuses it where the server does rather than running the handler.
        const { seen } = await same(createSides(), 'once', {}, { idempotencyKey: 42 });
        expect(seen.status).toBe(400);
    });

    it('an identity-scoped replay: the same answer for one caller, a fresh run for another', async () => {
        // Without an identity the scope of a public endpoint is the posted key
        // alone, which makes that key a bearer token for its own stored
        // answer. Configured on both sides, the scope has to be the same one.
        const sides = createSides();
        const first = await same(sides, 'once', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        const replay = await same(sides, 'once', {}, { idempotencyKey: IDEMPOTENCY_KEY });
        expect(replay.seen.envelope).toEqual(first.seen.envelope);

        const stranger = await same(sides, 'once', {}, { idempotencyKey: IDEMPOTENCY_KEY, from: 'stranger' });
        expect(stranger.seen.envelope).toMatchObject({ payload: { counter: 2 } });
    });

    it('a per-session rate limit: the same 429 for the session that spent it', async () => {
        // The other key an endpoint can be limited by, and the one that needs
        // the session read to have happened first.
        const sides = createSides();
        await same(sides, 'login', { user: 'ada', role: 'admin' });
        await same(sides, 'limitedPerCaller', {});
        const blocked = await same(sides, 'limitedPerCaller', {});
        expect(blocked.seen.status).toBe(429);
        expect(blocked.seen.envelope).toMatchObject({ errorMessage: { code: 'lambder/rate-limited' } });

        // Another session is another counter, on both sides.
        await same(sides, 'login', { user: 'bob', role: 'member' }, { from: 'stranger' });
        const other = await same(sides, 'limitedPerCaller', {}, { from: 'stranger' });
        expect(other.seen.status).toBe(200);
    });

    it('an unknown api: the same apiNotFound refusal', async () => {
        const { seen } = await same(createSides(), 'nope', {});
        expect(seen.envelope).toEqual({ apiVersion: '1', payload: null, errorMessage: { type: 'warning', code: 'lambder/api-not-found', content: 'API not found.' } });
    });

    it('an unknown api from a signed caller: the signature gate answers first on both sides', async () => {
        // A caller whose map holds a name the server does not have was built
        // against another contract, so both sides say versionExpired rather
        // than apiNotFound. The mock used to resolve the name first and
        // answered apiNotFound where the server did not.
        const withNope = { ...serverSignatures, [await apiNameKeyOf('nope')]: 'from-another-contract' };
        const { seen } = await same(createSides({ apiSignatures: withNope }), 'nope', {});
        expect(seen.envelope).toEqual({ apiVersion: '1', payload: null, versionExpired: true });
    });

    it('a malformed compressed payload on an unknown api: the same 400 on both sides', async () => {
        // The other half of the same pre-pass. The mock reached apiNotFound
        // without ever restoring the payload, so a request the server rejected
        // as unreadable came back 200-with-a-refusal from the mock.
        const sides = createSides();
        const call = (transport: LambderApiTransport) => transport({
            apiPath: '/api', apiName: 'nope', version: '1', token: '', siteHost: '',
            compressed: { payloadGz: 'not-base64!!!', payloadBytes: 10 },
        });

        const serverAnswer = await call(lambderHandlerTransport(sides.server.getHandler()));
        const mockAnswer = await call(sides.mockApp.transport());

        expect(mockAnswer.status).toBe(serverAnswer.status);
        expect(JSON.parse(await mockAnswer.text())).toEqual(JSON.parse(await serverAnswer.text()));
        expect(serverAnswer.status).toBe(400);
    });

    it('a crash: the same 500 envelope', async () => {
        const { seen, mockOutcome } = await same(createSides(), 'crash', {});
        expect(seen).toMatchObject({ status: 500, envelope: { apiVersion: '1', payload: null, errorMessage: 'Internal server error.' } });
        expect(mockOutcome.ok ? '' : mockOutcome.reason).toBe('server');
    });

    it('a crash after a session was created: 500 on both sides, both cookies still on the answer', async () => {
        // The call's headers belong to the call however it ended. The pipeline
        // drains them for the answers it produces itself, and a crash unwinds
        // past that, so this is the exit where the two adapters can part: a
        // handler that signed a user in and then threw would leave the browser
        // with no session cookie and nothing to explain it.
        const { seen, mockOutcome } = await same(createSides(), 'crashAfterLogin', {});
        expect(seen.status).toBe(500);
        expect(seen.setCookies).toBe(2);
        expect(mockOutcome.ok ? '' : mockOutcome.reason).toBe('server');
    });

    it('a compressed request payload: restored on both sides', async () => {
        const notes = Array.from({ length: 300 }, (_, i) => `note-${i} on the main line`);
        const { seen } = await same(createSides({ requestCompression: true }), 'echo', { notes });
        expect(seen.envelope).toEqual({ apiVersion: '1', payload: { count: 300 } });
    });
});

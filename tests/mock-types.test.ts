/**
 * What the compiler catches in a mock registry, with the contract still a
 * type-only import: completeness, no strays, the right builder for the
 * endpoint's mode, guards restated wherever the contract declares any and
 * pinned to the server's declaration, typed payloads and outputs, and
 * overlap between slices. `npm run typecheck` is what makes the
 * @ts-expect-error lines bite; the runtime assertions pin the builders'
 * runtime shape.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { lambderGuard, lambderRateLimitKey } from '../src/core/LambderPolicyBuilders.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { initLambderMock } from '../src/mock/LambderMockApp.js';
import { lambderMockMswHandler, type LambderMswModule, type LambderMockMswTarget } from '../src/mock/lambderMockMswHandler.js';
import type { LambderSessionRecord } from '../src/shared/contracts/LambderSessionStore.js';

type Permission = 'USERS.MANAGE' | 'USERS.VIEW';
type SessionData = { userId: string; role: 'admin' | 'member' };

/** A server declaration, from which the contract type is taken exactly as an app would export it. */
const serverGuards = {
    orgPermission: lambderGuard({
        guardInput: z.object({ organizationId: z.string() }),
        session: true,
        handler: async (ctx, { organizationId }, permission: Permission) => ({ organizationId, permission, userId: ctx.session.data.userId }),
    }),
    captcha: lambderGuard({ guardInput: z.object({ token: z.string().min(3) }), handler: async () => {} }),
    sessionOnly: lambderGuard({ session: true, handler: () => {} }),
    open: lambderGuard({ handler: (_ctx, _payload, _reason: string) => {} }),
};

const _server = initLambder<SessionData>().create({
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    guards: serverGuards,
    rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { tight: { perMin: 5, per: 'ip' } } },
    idempotency: { store: { peek: async () => null, begin: async () => ({ state: 'new', ownerToken: 'x' }), complete: async () => 'stored', abandon: async () => {} } },
})
    .addApi('user.get', { input: z.object({ userId: z.string() }), output: z.object({ id: z.string(), name: z.string() }), guards: { open: 'public profile' } }, async (_ctx, res) => res.api({ id: '1', name: 'Ada' }))
    .addApi('feedback.submit', { input: z.object({ text: z.string() }), output: z.object({ code: z.string() }), guards: 'captcha', idempotency: true }, async (_ctx, res) => res.api({ code: 'c' }))
    .addSessionApi('users.remove', { input: z.object({ userId: z.string() }), output: z.object({ removed: z.boolean() }), guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx, res) => res.api({ removed: true }))
    .addSessionApi('me', { input: z.object({}), output: z.object({ userId: z.string() }), guards: 'sessionOnly' }, async (ctx, res) => res.api({ userId: ctx.session.data.userId }))
    .addApi('admin.runSignedQuery', { input: z.object({ sql: z.string() }), output: z.any(), guards: { open: 'signed' } }, async (_ctx, res) => res.api(null))
    // Declares no guards, which is the one shape the bare-handler form is for.
    .addApi('health', { input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (_ctx, res) => res.api({ ok: true }))
    // No guards, but a declaration each, which the bare-handler form cannot
    // restate.
    .addApi('ticket.buy', { input: z.object({ seat: z.string() }), output: z.object({ ticketId: z.string() }), idempotency: true }, async (_ctx, res) => res.api({ ticketId: 't1' }))
    .addApi('limited', { input: z.object({}), output: z.object({ n: z.number() }), rateLimit: 'tight' }, async (_ctx, res) => res.api({ n: 1 }));

type Contract = typeof _server.ApiContract;

const mock = initLambderMock<Contract, SessionData>();
const mockGuards = {
    orgPermission: mock.guard({
        guardInput: z.object({ organizationId: z.string() }),
        session: true,
        handler: (ctx, { organizationId }, permission: Permission) => ({ organizationId, permission, userId: ctx.session.data.userId }),
    }),
    captcha: mock.guard({ guardInput: z.object({ token: z.string() }), handler: () => {} }),
    sessionOnly: mock.guard({ session: true, handler: () => {} }),
    open: mock.guard({ handler: (_ctx, _payload, _reason: string) => {} }),
};
/** The policies an entry may restate, which the runtime checks a restatement against at registration. */
const mockPolicies = { tight: { perMin: 5, per: 'ip' } } as const;
/**
 * What the contract makes create() require beside the guard map: it has
 * session, idempotent and rate-limited endpoints. The tests below spread it,
 * so each @ts-expect-error still points at the one mistake it names.
 */
const requiredOptions = { sessions: true, idempotency: true, rateLimits: { policies: mockPolicies } } as const;
const mockApp = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });

describe('Mock registry types - builders', () => {
    it('types the payload from the contract (never optional) and the output as the contract output', () => {
        const entry = mockApp.publicApi('user.get', {
            guards: { open: 'public profile' },
            handler: async ({ payload }) => {
                expectTypeOf(payload).toEqualTypeOf<{ userId: string }>();
                return { id: payload.userId, name: 'Ada' };
            },
        });
        expect(entry.name).toBe('user.get');
        expect(entry.mode).toBe('public');

        // @ts-expect-error the output must be the contract's output shape
        mockApp.publicApi('user.get', { guards: { open: 'public profile' }, handler: async () => ({ id: 'x' }) });
    });

    it('an endpoint whose output is void is mocked by a handler that answers nothing', () => {
        const _voidServer = initLambder().create({ apiPath: '/api' })
            .addApi('ping', { input: z.object({}), output: z.void() }, async (_ctx, res) => res.api())
            .addApi('maybe', { input: z.object({}), output: z.string().optional() }, async (_ctx, res) => res.api(undefined));
        type Output<K extends keyof typeof _voidServer.ApiContract> = (typeof _voidServer.ApiContract)[K]['output'];
        expectTypeOf<Output<'ping'>>().toEqualTypeOf<void>();
        expectTypeOf<Output<'maybe'>>().toEqualTypeOf<string | undefined>();
        const voidMock = initLambderMock<typeof _voidServer.ApiContract>().create({});
        voidMock.publicApi('ping', async () => {});
        voidMock.publicApi('maybe', async () => undefined);
    });

    it('a session endpoint sees a typed session and a public one sees null', () => {
        mockApp.sessionApi('me', {
            guards: 'sessionOnly',
            handler: async ({ session }) => {
                expectTypeOf(session).toEqualTypeOf<LambderSessionRecord<SessionData>>();
                return { userId: session.data.userId };
            },
        });
        mockApp.publicApi('user.get', {
            guards: { open: 'public profile' },
            handler: async ({ session }) => {
                expectTypeOf(session).toEqualTypeOf<null>();
                return { id: '1', name: 'Ada' };
            },
        });
    });

    it('the wrong builder for the endpoint mode fails at the name', () => {
        // @ts-expect-error 'me' is a session endpoint
        mockApp.publicApi('me', async () => ({ userId: 'x' }));
        // @ts-expect-error 'user.get' is a public endpoint
        mockApp.sessionApi('user.get', async () => ({ id: '1', name: 'Ada' }));
    });

    it('a stray name fails at the name', () => {
        // @ts-expect-error no such endpoint
        mockApp.publicApi('user.gett', async () => ({ id: '1', name: 'Ada' }));
        // @ts-expect-error no such endpoint
        mockApp.notMocked('nope', 'reason');
    });

    it('guards are required wherever the contract declares any, and pinned to the server declaration', () => {
        // @ts-expect-error users.remove carries guardInputs: the bare handler form is not allowed
        mockApp.sessionApi('users.remove', async () => ({ removed: true }));
        // @ts-expect-error the guards field is required here
        mockApp.sessionApi('users.remove', { handler: async () => ({ removed: true }) });
        // @ts-expect-error USERS.VIEW is not what the server declares
        mockApp.sessionApi('users.remove', { guards: { orgPermission: 'USERS.VIEW' }, handler: async () => ({ removed: true }) });

        // A guard that takes no client input is still a guard the runtime
        // learns about only from this restatement: dropping it would run
        // none, and the mock would answer 200 where the server answers
        // notAuthorized. Two such shapes: session-only guards ('me' declares
        // sessionOnly) and param-only ones ('user.get' declares open).
        // @ts-expect-error me declares a guard, so the bare handler form is not allowed
        mockApp.sessionApi('me', async () => ({ userId: 'x' }));
        // @ts-expect-error me declares a guard, so the guards field is required
        mockApp.sessionApi('me', { handler: async () => ({ userId: 'x' }) });
        // @ts-expect-error user.get declares a guard, so the bare handler form is not allowed
        mockApp.publicApi('user.get', async () => ({ id: '1', name: 'Ada' }));
        // @ts-expect-error user.get declares a guard, so the guards field is required
        mockApp.publicApi('user.get', { handler: async () => ({ id: '1', name: 'Ada' }) });
        // An endpoint the contract declares no guards for keeps both forms,
        // and has no guards field to get wrong.
        mockApp.publicApi('health', async () => ({ ok: true }));
        mockApp.publicApi('health', { handler: async () => ({ ok: true }) });
        // @ts-expect-error health declares no guards, so there are none to restate
        mockApp.publicApi('health', { guards: { open: 'invented' }, handler: async () => ({ ok: true }) });

        const entry = mockApp.sessionApi('users.remove', {
            guards: { orgPermission: 'USERS.MANAGE' },
            handler: async ({ guardData, guardInputs }) => {
                expectTypeOf(guardData.orgPermission).toEqualTypeOf<{ organizationId: string; permission: Permission; userId: string }>();
                expectTypeOf(guardInputs).toEqualTypeOf<{ orgPermission: { organizationId: string } }>();
                return { removed: true };
            },
        });
        expect(entry.definition.guards).toEqual({ orgPermission: 'USERS.MANAGE' });

        // Pinned to the server's own declaration, guardInputs or not.
        mockApp.publicApi('user.get', { guards: { open: 'public profile' }, handler: async () => ({ id: '1', name: 'Ada' }) });
        // @ts-expect-error the server's reason is a different literal
        mockApp.publicApi('user.get', { guards: { open: 'other' }, handler: async () => ({ id: '1', name: 'Ada' }) });
    });

    it('the idempotency and rate-limit declarations are pinned to the contract too', () => {
        mockApp.publicApi('feedback.submit', { guards: 'captcha', idempotency: true, handler: async () => ({ code: 'c' }) });
        // @ts-expect-error the server declares idempotency: true, not a TTL object
        mockApp.publicApi('feedback.submit', { guards: 'captcha', idempotency: { ttlSeconds: 5 }, handler: async () => ({ code: 'c' }) });
    });

    it('requires the idempotency and rate-limit restatements, not just pins them', () => {
        // The restatement is the only thing that tells the runtime to take a
        // claim or apply a limit, so an entry that omitted one would answer
        // 200 where the server answers a replay, a 409 or a 429. The same
        // argument the guards field makes, one field over.
        // @ts-expect-error the contract declares idempotency for this endpoint
        mockApp.publicApi('feedback.submit', { guards: 'captcha', handler: async () => ({ code: 'c' }) });
        // An endpoint that declares neither still takes neither.
        mockApp.publicApi('health', { handler: async () => ({ ok: true }) });
        // @ts-expect-error health declares no idempotency, so there is nothing to restate
        mockApp.publicApi('health', { idempotency: true, handler: async () => ({ ok: true }) });
    });

    it('the bare handler form is unavailable for an endpoint that declares a rate limit or idempotency, guards or not', () => {
        // The bare handler carries no fields at all, so a gate keyed on guards
        // alone would leave both restatements optional wherever the contract
        // declares no guards: the handler would run twice for one key where
        // the server replays, and a limited endpoint would never answer 429.
        // Both endpoints below declare no guards, the case such a gate misses.
        // @ts-expect-error ticket.buy declares idempotency, so the bare handler form is not allowed
        mockApp.publicApi('ticket.buy', async () => ({ ticketId: 't1' }));
        // @ts-expect-error ticket.buy declares idempotency, so the field is required
        mockApp.publicApi('ticket.buy', { handler: async () => ({ ticketId: 't1' }) });
        // @ts-expect-error limited declares a rate limit, so the bare handler form is not allowed
        mockApp.publicApi('limited', async () => ({ n: 1 }));
        // @ts-expect-error limited declares a rate limit, so the field is required
        mockApp.publicApi('limited', { handler: async () => ({ n: 1 }) });

        // Restated, both forms of the declaration are the contract's own.
        const keyed = mockApp.publicApi('ticket.buy', { idempotency: true, handler: async () => ({ ticketId: 't1' }) });
        const limited = mockApp.publicApi('limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) });
        expect(keyed.definition.idempotency).toBe(true);
        expect(limited.definition.rateLimit).toBe('tight');
        // And the endpoint that declares nothing at all keeps the bare form.
        mockApp.publicApi('health', async () => ({ ok: true }));
    });

    it("an entry's own input schema is pinned to what the contract says the endpoint takes", () => {
        // The schema is the mock's, because the contract is a type and the
        // server's schemas do not exist on this side. What it parses to is
        // still the server's: a restated shape that drifts makes the mock
        // answer 422 to every payload the server accepts, which is the exact
        // failure the schema exists to reproduce.
        mockApp.publicApi('user.get', {
            guards: { open: 'public profile' },
            input: z.object({ userId: z.string() }),
            handler: async ({ payload }) => ({ id: payload.userId, name: 'Ada' }),
        });
        mockApp.publicApi('user.get', {
            guards: { open: 'public profile' },
            // @ts-expect-error the contract types userId as a string
            input: z.object({ userId: z.number() }),
            handler: async ({ payload }) => ({ id: payload.userId, name: 'Ada' }),
        });
    });
});

describe('Mock registry types - slices and register()', () => {
    const userMocks = mockApp.apiSlice(
        mockApp.publicApi('user.get', { guards: { open: 'public profile' }, handler: async ({ payload }) => ({ id: payload.userId, name: 'Ada' }) }),
        mockApp.sessionApi('users.remove', { guards: { orgPermission: 'USERS.MANAGE' }, handler: async () => ({ removed: true }) }),
        mockApp.sessionApi('me', { guards: 'sessionOnly', handler: async ({ session }) => ({ userId: session.data.userId }) }),
    );
    const feedbackMocks = mockApp.apiSlice(
        mockApp.publicApi('feedback.submit', { guards: 'captcha', idempotency: true, handler: async () => ({ code: 'c' }) }),
        mockApp.publicApi('health', async () => ({ ok: true })),
        mockApp.publicApi('ticket.buy', { idempotency: true, handler: async () => ({ ticketId: 't1' }) }),
        mockApp.publicApi('limited', { rateLimit: 'tight', handler: async () => ({ n: 1 }) }),
    );
    const adminMocks = mockApp.apiSlice(
        mockApp.notMocked('admin.runSignedQuery', 'operator endpoint, no client calls it'),
    );

    it('a slice is keyed by the names of its entries', () => {
        expectTypeOf<keyof typeof userMocks>().toEqualTypeOf<'user.get' | 'users.remove' | 'me'>();
        expect(Object.keys(userMocks).sort()).toEqual(['me', 'user.get', 'users.remove']);
    });

    it('register() accepts slices that cover the contract exactly once', () => {
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        app.register(userMocks, feedbackMocks, adminMocks);
        expect(app.registeredNames.sort()).toEqual(['admin.runSignedQuery', 'feedback.submit', 'health', 'limited', 'me', 'ticket.buy', 'user.get', 'users.remove']);
    });

    it('register() refuses a registry with an endpoint missing', () => {
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        // @ts-expect-error admin.runSignedQuery has no mock
        app.register(userMocks, feedbackMocks);
    });

    it('register() refuses an endpoint mocked in two slices, at compile time and at runtime', () => {
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        const again = app.apiSlice(app.publicApi('user.get', { guards: { open: 'public profile' }, handler: async () => ({ id: '2', name: 'Bob' }) }));
        // @ts-expect-error user.get is mocked twice
        expect(() => app.register(userMocks, feedbackMocks, adminMocks, again)).toThrow(/mocked in more than one slice/);
    });

    it('register() takes a rest entry in place of the endpoints no slice covers', () => {
        // How an app adopts the mock over a contract its mocks do not cover
        // yet: register() stays exhaustive by construction, and everything
        // left out is declared not mocked in one argument rather than one
        // notMocked entry per endpoint. admin.runSignedQuery has no slice
        // here and the call compiles all the same.
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        app.register(userMocks, feedbackMocks, app.restNotMocked('not mocked yet'));
        // The rest entry names no endpoint, so it registers none.
        expect(app.registeredNames.sort()).toEqual(['feedback.submit', 'health', 'limited', 'me', 'ticket.buy', 'user.get', 'users.remove']);
    });

    it('a stray name beside a rest entry is still refused', () => {
        // The rest entry answers the endpoints of the contract nothing
        // claimed; a name the contract does not have is not one of them, and
        // reading the rest entry's own key as a name would make it look like
        // one.
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        const strays = { ...feedbackMocks, 'feedback.sumbit': feedbackMocks['feedback.submit'] };
        // @ts-expect-error feedback.sumbit is not an endpoint of the contract
        expect(() => app.register(userMocks, strays, app.restNotMocked('not mocked yet'))).toThrow(/slice key "feedback.sumbit" holds the mock for "feedback.submit"/);
    });

    it('a duplicate beside a rest entry is still refused', () => {
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        const again = app.apiSlice(app.publicApi('user.get', { guards: { open: 'public profile' }, handler: async () => ({ id: '2', name: 'Bob' }) }));
        // @ts-expect-error user.get is mocked twice
        expect(() => app.register(userMocks, again, app.restNotMocked('not mocked yet'))).toThrow(/mocked in more than one slice/);
    });

    it('register() refuses a slice list it cannot count, which would pass completeness on one element', () => {
        // Every check register() makes is written over a tuple. An array
        // type has no elements the compiler can walk, so the overlap and
        // index-signature checks fall straight to `never` and completeness
        // reduces to "the element type mentions these names", which one
        // slice in a list of twenty satisfies as well as all of them.
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        const loose = [userMocks];   // no `as const`: an array of slices, not a fixed list
        // @ts-expect-error the list is an array rather than a fixed list, so it cannot be checked for completeness
        app.register(...loose);

        // Declared `as const` it is a tuple again, and the same three slices
        // that pass as arguments pass spread.
        const fixed = [userMocks, feedbackMocks, adminMocks] as const;
        const counted = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        counted.register(...fixed);
        expect(counted.registeredNames.length).toBe(8);
    });

    it('register() refuses a slice carrying a name the contract does not declare', () => {
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        // A slice written by hand rather than through apiSlice: the key is
        // what register() checks the contract against and what the runtime
        // registers under, so a name the contract does not have is a mock
        // nothing will ever call.
        const strays = { ...feedbackMocks, 'feedback.sumbit': feedbackMocks['feedback.submit'] };
        // @ts-expect-error feedback.sumbit is not an endpoint of the contract
        expect(() => app.register(userMocks, strays, adminMocks)).toThrow(/slice key "feedback.sumbit" holds the mock for "feedback.submit"/);
    });

    it('register() refuses a slice typed with an index signature, which would pass completeness while covering nothing', () => {
        // `keyof` an index-signature type is `string`, which subtracts every
        // contract name from the missing list. Without a check of its own,
        // this registers one endpoint out of five and says nothing; the
        // contract is type-only, so no runtime check can catch it either.
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        const loose: Record<string, ReturnType<typeof mockApp.publicApi<'user.get'>>> = {
            'user.get': mockApp.publicApi('user.get', { guards: { open: 'public profile' }, handler: async ({ payload }) => ({ id: payload.userId, name: 'Ada' }) }),
        };
        // @ts-expect-error the slice's endpoints cannot be read from its type
        app.register(loose);

        // registerPartial makes no completeness claim, so it still takes one.
        const partial = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        partial.registerPartial(loose);
        expect(partial.registeredNames).toEqual(['user.get']);
    });

    it('registerPartial() takes any subset', () => {
        const app = mock.create({ sessions: true, idempotency: true, guards: mockGuards, rateLimits: { policies: mockPolicies } });
        app.registerPartial(feedbackMocks);
        expect(app.registeredNames).toEqual(['feedback.submit', 'health', 'ticket.buy', 'limited']);
    });

    it('an entry appearing twice in one slice is a runtime error', () => {
        const entry = mockApp.publicApi('user.get', { guards: { open: 'public profile' }, handler: async () => ({ id: '1', name: 'Ada' }) });
        expect(() => mockApp.apiSlice(entry, entry)).toThrow(/appears twice in one slice/);
    });
});

describe('Mock registry types - the guard map', () => {
    it('must name every guard the contract declares, with guardInput schemas that take what the server\'s contract says a client sends', () => {
        const { orgPermission, captcha, sessionOnly, open } = mockGuards;
        mock.create({ ...requiredOptions, guards: { orgPermission, captcha, sessionOnly, open } });
        // @ts-expect-error captcha is declared by the contract and missing here
        mock.create({ ...requiredOptions, guards: { orgPermission, sessionOnly, open } });
        mock.create({ ...requiredOptions, guards: {
            orgPermission, sessionOnly, open,
            // @ts-expect-error the server's captcha input is { token: string }, not { code: number }
            captcha: mock.guard({ guardInput: z.object({ code: z.number() }), handler: () => {} }),
        } });
    });

    it('refuses a guard map written against the server contexts', () => {
        // lambderGuard is bound to the render contexts, which carry ip, method
        // and path; a mock call context carries none of them. Handed to the
        // mock, these would compile and then authorize on a context they
        // cannot read: the guard twin of the rate-limit key below.
        // @ts-expect-error these guards expect the server's render contexts, not the mock's
        mock.create({ ...requiredOptions, guards: serverGuards });
    });

    it('a mock guard sees the mock contexts: the session on session guards, the request everywhere', () => {
        mock.guard({
            session: true,
            handler: (ctx) => {
                expectTypeOf(ctx.session).toEqualTypeOf<LambderSessionRecord<SessionData>>();
                expectTypeOf(ctx.request.ip).toEqualTypeOf<string>();
            },
        });
        mock.guard({
            handler: (ctx) => {
                expectTypeOf(ctx.session).toEqualTypeOf<LambderSessionRecord<SessionData> | null>();
            },
        });
    });
});

describe('Mock registry types - the rate-limit policies', () => {
    it('must name every policy the contract references', () => {
        mock.create({ ...requiredOptions, guards: mockGuards, rateLimits: { policies: { tight: { perMin: 5, per: 'ip' } } } });
        // Policies the contract does not reference may be added freely.
        mock.create({ ...requiredOptions, guards: mockGuards, rateLimits: { policies: { tight: { perMin: 5, per: 'ip' }, extra: { perDay: 9, per: 'ip' } } } });
        // @ts-expect-error tight is referenced by the contract and missing here
        mock.create({ ...requiredOptions, guards: mockGuards, rateLimits: { policies: { other: { perMin: 5, per: 'ip' } } } });
    });
});

describe('Mock app options - what the contract makes required', () => {
    it('requires sessions, idempotency and rateLimits whenever the contract has an endpoint that needs each', () => {
        // The guard map's argument, once per option: an entry that needs an
        // option the mock was created without cannot be registered, so
        // leaving the option out is refused here rather than when the
        // registry loads.
        mock.create({ sessions: true, idempotency: true, rateLimits: { policies: mockPolicies }, guards: mockGuards });
        // @ts-expect-error the contract has session endpoints
        mock.create({ idempotency: true, rateLimits: { policies: mockPolicies }, guards: mockGuards });
        // @ts-expect-error switched off is the same as left out
        mock.create({ sessions: false, idempotency: true, rateLimits: { policies: mockPolicies }, guards: mockGuards });
        // @ts-expect-error the contract has idempotent endpoints
        mock.create({ sessions: true, rateLimits: { policies: mockPolicies }, guards: mockGuards });
        // @ts-expect-error switched off is the same as left out
        mock.create({ sessions: true, idempotency: false, rateLimits: { policies: mockPolicies }, guards: mockGuards });
        // @ts-expect-error the contract references rate-limit policies
        mock.create({ sessions: true, idempotency: true, guards: mockGuards });
    });

    it('leaves each optional for a contract that needs none of them', () => {
        initLambderMock<{ health: { input: {}; output: { ok: boolean }; mode: 'public' } }>().create({});
    });

    it('refuses a session guard or a per-session policy where a public endpoint names it', () => {
        // The server refuses both pairings when it registers the endpoint, so
        // a contract never carries one; a mock copy that differs from the
        // server's could not register the entry.
        mock.create({
            ...requiredOptions,
            // @ts-expect-error open is named by public endpoints, so it may not require a session
            guards: { ...mockGuards, open: mock.guard({ session: true, handler: (_ctx, _payload, _reason: string) => {} }) },
        });
        mock.create({
            ...requiredOptions, guards: mockGuards,
            // @ts-expect-error tight is named by a public endpoint, so it may not be keyed per session
            rateLimits: { policies: { tight: { perMin: 5, per: 'session' } } },
        });
    });

    it('refuses a shared budget for a policy whose windows an endpoint overrides', () => {
        // One counter shared by every referencing endpoint has one set of
        // windows, so the server refuses the override on a perPolicy budget.
        const overriding = initLambderMock<{ burst: { input: {}; output: { n: number }; mode: 'public'; rateLimit: { tight: { perMin: 1 } } } }>();
        overriding.create({ rateLimits: { policies: { tight: { perMin: 5, per: 'ip' } } } });
        // @ts-expect-error burst overrides tight's windows
        overriding.create({ rateLimits: { policies: { tight: { perMin: 5, per: 'ip', budget: 'perPolicy' } } } });
        // An errorMessage alone is overridable on either budget.
        initLambderMock<{ burst: { input: {}; output: { n: number }; mode: 'public'; rateLimit: { tight: { errorMessage: { type: 'warning'; content: 'Slow down.' } } } } }>()
            .create({ rateLimits: { policies: { tight: { perMin: 5, per: 'ip', budget: 'perPolicy' } } } });
    });
});

describe('Mock rate-limit keys are bound to the mock context', () => {
    it('types a key handler for the runtime that will actually call it', () => {
        // The engine hands a key handler whatever context the adapter runs on,
        // and the two adapters run on different ones. Built with the mock's
        // own builder, the handler sees the mock call context.
        const policies = {
            ...mockPolicies,
            perUser: {
                perMin: 5,
                budget: 'perApi',
                per: mock.rateLimitKey({ handler: (ctx) => ctx.session?.data.userId ?? 'anonymous' }),
            },
        } as const;

        expect(() => mock.create({ ...requiredOptions, guards: mockGuards, rateLimits: { policies } })).not.toThrow();
    });

    it('refuses a key handler written against the server context', () => {
        // lambderRateLimitKey is bound to the render context. Handed to the
        // mock, it would compile and then read ip/method/path as undefined:
        // every caller would share one counter, and a per-ip limit a test was
        // written to prove would prove nothing.
        const serverKey = lambderRateLimitKey({ handler: (ctx) => `${ctx.ip}:${ctx.method}` });

        mock.create({
            sessions: true,
            guards: mockGuards,
            // @ts-expect-error the handler expects the server's render context, not the mock's
            rateLimits: { policies: { ...mockPolicies, byIp: { perMin: 5, budget: 'perApi', per: serverKey } } },
        });
    });
});

describe('Mock app options - what a typo costs', () => {
    it('requires the guard map whenever the contract declares a guard name', () => {
        // The app-level twin of the entry's own guards field, and the same
        // argument: a guard the map does not declare cannot run, so the mock
        // answers 200 where the server answers notAuthorized. Left optional,
        // it would be the droppable half of the check it exists for.
        // @ts-expect-error the contract declares guards, so the map is required
        mock.create({ ...requiredOptions });
        // @ts-expect-error still required beside other options
        mock.create({ ...requiredOptions, latency: 0 });
        mock.create({ ...requiredOptions, guards: mockGuards });
    });

    it('catches a typo INSIDE rateLimits.policies and idempotency, not only at the top level', () => {
        // `const P` and `const I` are what pin a restatement to the contract,
        // and inferring a generic from an object literal switches
        // excess-property checking off for the whole literal, nested objects
        // included. Unchecked, these would compile, be dropped in silence, and
        // leave the runtime on the default: a typo'd failOpen is fail-open,
        // and a typo'd callerIdentity leaves every public replay key a bearer
        // token.
        mock.create({
            ...requiredOptions, guards: mockGuards,
            // @ts-expect-error budgt is not a policy option
            rateLimits: { policies: { tight: { perMin: 5, per: 'ip', budgt: 'perPolicy' } } },
        });
        mock.create({
            ...requiredOptions, guards: mockGuards,
            // @ts-expect-error failOpn is not an idempotency option
            idempotency: { failOpn: false },
        });
        mock.create({
            ...requiredOptions, guards: mockGuards,
            // @ts-expect-error callerIdentitiy is not an idempotency option
            idempotency: { callerIdentitiy: () => null },
        });

        // Spelled correctly, all three forms still compile.
        mock.create({
            sessions: true, guards: mockGuards,
            rateLimits: { policies: { tight: { perMin: 5, per: 'ip', budget: 'perPolicy' } } },
            idempotency: { failOpen: false, defaultPendingTtlSeconds: 900, callerIdentity: (ctx) => ctx.request.ip },
        });
        mock.create({ ...requiredOptions, guards: mockGuards, idempotency: true });
    });
});

describe("A mock entry's input schema is pinned in both directions", () => {
    const guards = { open: 'public profile' } as const;

    it('takes the schema that parses to exactly the contract input', () => {
        mockApp.publicApi('user.get', {
            guards,
            input: z.object({ userId: z.string() }),
            handler: async ({ payload }) => ({ id: payload.userId, name: 'Ada' }),
        });
    });

    it('refuses a schema that parses to something else', () => {
        mockApp.publicApi('user.get', {
            guards,
            // @ts-expect-error the contract types userId as a string
            input: z.object({ userId: z.number() }),
            handler: async () => ({ id: '1', name: 'Ada' }),
        });
    });

    it('refuses a STRICTER schema, which is the drift that makes the mock 422 what the server accepts', () => {
        // z.ZodType is covariant in its output, so a one-directional pin
        // would pass a schema parsing to a subtype: an extra required field,
        // or a literal where the contract says string. Such a schema refuses
        // payloads the server accepts, the exact failure the schema exists to
        // reproduce.
        mockApp.publicApi('user.get', {
            guards,
            // @ts-expect-error the schema demands a field the endpoint does not take
            input: z.object({ userId: z.string(), tenantId: z.string() }),
            handler: async () => ({ id: '1', name: 'Ada' }),
        });
        mockApp.publicApi('user.get', {
            guards,
            // @ts-expect-error the schema narrows userId to one literal
            input: z.object({ userId: z.literal('u1') }),
            handler: async () => ({ id: '1', name: 'Ada' }),
        });
    });

    it('refuses a LOOSER schema, which would let the mock accept what the server rejects', () => {
        mockApp.publicApi('user.get', {
            guards,
            // @ts-expect-error the schema parses to a payload wider than the contract's
            input: z.object({ userId: z.union([z.string(), z.number()]) }),
            handler: async () => ({ id: '1', name: 'Ada' }),
        });
        mockApp.publicApi('user.get', {
            guards,
            // @ts-expect-error a schema that parses to anything is not this endpoint's
            input: z.unknown(),
            handler: async () => ({ id: '1', name: 'Ada' }),
        });
        // z.any() is the one schema no pin can refuse: `any` is assignable in
        // both directions by definition, which is what `any` means.
    });

    it('takes the server\'s own schema restated, a default included, and refuses a transform the handler is not typed for', () => {
        const _server = initLambder().create({ apiPath: '/api' })
            .addApi('search', { input: z.object({ q: z.string(), page: z.number().default(1) }), output: z.object({ hits: z.number() }) }, async (_ctx, res) => res.api({ hits: 0 }))
            .addApi('lookup', { input: z.object({ id: z.string().transform(Number) }), output: z.object({ hits: z.number() }) }, async (_ctx, res) => res.api({ hits: 0 }));
        const app = initLambderMock<typeof _server.ApiContract>().create({});
        app.publicApi('search', { input: z.object({ q: z.string(), page: z.number().default(1) }), handler: async () => ({ hits: 1 }) });
        app.publicApi('lookup', {
            // @ts-expect-error the handler reads id as the posted string, and the schema would hand it a number
            input: z.object({ id: z.string().transform(Number) }),
            handler: async () => ({ hits: 1 }),
        });
    });
});

describe('The MSW adapter fits the real msw module', () => {
    it('takes the real module, and hands back the handler setupWorker accepts', () => {
        // msw is a devDependency of this package, so the adapter is pinned to
        // the package itself rather than to a hand-written replica of its
        // signature: an msw release that changes http.post fails the build
        // here instead of at a consumer, and this codebase refuses
        // hand-maintained mirrors of a contract the compiler could check.
        expectTypeOf<typeof import('msw')>().toExtend<LambderMswModule>();
        // The app is what an adapter is handed, cookieHost and all.
        expectTypeOf<typeof mockApp>().toExtend<LambderMockMswTarget>();

        // Compiled, not run: the documented wiring, which is where a
        // mismatched declaration would surface.
        const wiring = () => {
            const msw = null as unknown as typeof import('msw');
            const setupWorker = null as unknown as typeof import('msw/browser').setupWorker;
            const worker = setupWorker(lambderMockMswHandler(mockApp, { msw, apiPath: '/api' }));
            expectTypeOf(worker.start).toBeFunction();
        };
        expect(typeof wiring).toBe('function');
    });
});

describe('The mock guards map is checked for surplus keys', () => {
    it('refuses sesion: true on an inline guard, which would otherwise register as a public guard', () => {
        // The server's create() catches this typo one level down, and the
        // mock's guards map must too: otherwise a guard meant for sessions
        // runs on a context with no session and answers where the server
        // refuses.
        // @ts-expect-error sesion is not a guard option
        mock.create({ ...requiredOptions, guards: { ...mockGuards, extra: { sesion: true, handler: async () => undefined } } });
        expect(() => mock.create({ ...requiredOptions, guards: { ...mockGuards, extra: { session: true, handler: async () => undefined } } })).not.toThrow();
    });
});

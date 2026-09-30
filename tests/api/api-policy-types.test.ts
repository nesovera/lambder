/**
 * What the policy layer promises the COMPILER, which `npm run typecheck`
 * (tsconfig.tests.json) is what makes bite: vitest never evaluates a
 * @ts-expect-error. Each case below is a declaration that would compile and
 * enforce nothing, or a legitimate one that must stay possible to write.
 */

import { testPublicFiles } from '../helpers.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderApiPipeline } from '../../src/api/LambderApiPipeline.js';
import { LambderResponse } from '../../src/core/LambderResponse.js';
import { lambderGuard, lambderRateLimitKey } from '../../src/core/LambderPolicyBuilders.js';
import { lambderGuardBuilder } from '../../src/api/LambderApiGuards.js';
import { initLambderMock } from '../../src/mock/LambderMockApp.js';
import type {
    LambderApiRateLimitPolicyConfig,
    LambderPolicyNamesInputLacks,
    LambderRateLimitPer,
} from '../../src/api/LambderApiRateLimits.js';
import type { LambderGuardNamesInputLacks } from '../../src/api/LambderApiGuards.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import type { LambderApiCallContext } from '../../src/api/LambderApiCallContext.js';
import type { LambderSessionRecord } from '../../src/shared/contracts/LambderSessionStore.js';
import type { LambderRenderContext } from '../../src/core/LambderContext.js';

const testSchema = {
    input: z.object({ value: z.string() }),
    output: z.object({ result: z.string() }),
};

const createApp = () => initLambder().create({
    files: testPublicFiles(),
    apiPath: '/api',
    rateLimits: {
        limiter: new LambderMemoryRateLimiter(),
        policies: { perIp: { perMin: 5, per: 'ip' } },
    },
});

describe('The rateLimit option is non-empty by construction, like the guards option', () => {
    it('rejects the three empty forms at the type level', () => {
        const app = createApp();
        // @ts-expect-error an empty map declares no policy
        const emptyMap = app.defineApi({ ...testSchema, rateLimit: {} }, async (_ctx) => ({ result: 'ok' }));
        expect(() => app.registerApiGroups(app.defineApiGroup('emptyMap', { a: emptyMap }))).toThrow();
        // @ts-expect-error an empty list declares no policy
        const emptyList = app.defineApi({ ...testSchema, rateLimit: [] }, async (_ctx) => ({ result: 'ok' }));
        expect(() => app.registerApiGroups(app.defineApiGroup('emptyList', { b: emptyList }))).toThrow();
        // @ts-expect-error a named policy with an undefined value declares nothing
        const undefinedPolicy = app.defineApi({ ...testSchema, rateLimit: { perIp: undefined } }, async (_ctx) => ({ result: 'ok' }));
        expect(() => app.registerApiGroups(app.defineApiGroup('undefinedPolicy', { c: undefinedPolicy }))).toThrow();
    });

    it('still accepts every non-empty form', () => {
        const app = createApp();
        expect(() => app.registerApiGroups(app.defineApiGroup('test', {
            one: app.defineApi({ ...testSchema, rateLimit: 'perIp' }, async (_ctx) => ({ result: 'ok' })),
            list: app.defineApi({ ...testSchema, rateLimit: ['perIp'] }, async (_ctx) => ({ result: 'ok' })),
            map: app.defineApi({ ...testSchema, rateLimit: { perIp: true } }, async (_ctx) => ({ result: 'ok' })),
            tuned: app.defineApi({ ...testSchema, rateLimit: { perIp: { perMin: 1 } } }, async (_ctx) => ({ result: 'ok' })),
        })))
            .not.toThrow();
    });
});

describe('A payload slice is held to a union input whole, not member by member', () => {
    const createSliceApp = () => initLambder().create({
        files: testPublicFiles(),
        apiPath: '/api',
        guards: { emailOwner: lambderGuard({ apiInput: z.object({ email: z.string() }), handler: async () => {} }) },
        rateLimits: {
            limiter: new LambderMemoryRateLimiter(),
            policies: { perEmail: { perMin: 5, per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }) } },
        },
    });

    it('refuses a guard or a rate-limit key whose slice only some members of the input carry', () => {
        // Checked member by member, the `kind: "a"` member carrying `email`
        // would be enough, and every `kind: "b"` request would then be
        // refused 422 by the slice's own parse.
        const eitherKind = z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), email: z.string() }), z.object({ kind: z.literal('b') })]);
        const app = createSliceApp();
        app.registerApiGroups(app.defineApiGroup('test', {
            guarded: app.defineApi({
                input: eitherKind,
                output: z.object({}),
                // @ts-expect-error a `kind: "b"` payload carries no email for the guard's slice
                guards: 'emailOwner',
            }, async (_ctx) => ({})),
            limited: app.defineApi({
                input: eitherKind,
                output: z.object({}),
                // @ts-expect-error a `kind: "b"` payload carries no email for the key's slice
                rateLimit: 'perEmail',
            }, async (_ctx) => ({})),
        }));
    });

    it('accepts a slice every member carries, and a plain input that carries it', () => {
        const everyKind = z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), email: z.string() }), z.object({ kind: z.literal('b'), email: z.string() })]);
        const app = createSliceApp();
        expect(() => app.registerApiGroups(app.defineApiGroup('test', {
            union: app.defineApi({ input: everyKind, output: z.object({}), guards: 'emailOwner', rateLimit: 'perEmail' }, async (_ctx) => ({})),
            plain: app.defineApi({ input: z.object({ email: z.string(), name: z.string() }), output: z.object({}), guards: 'emailOwner', rateLimit: 'perEmail' }, async (_ctx) => ({})),
        })))
            .not.toThrow();
    });
});

describe('A declared guard or rate limit is held to the fields the API\'s input carries, in every form of the option', () => {
    // The options' constraints admit every declared name, and the input is
    // checked once it is known (LambderPayloadSliceCheck), so what an API
    // costs the compiler does not grow with the app's keyed declarations
    // (api-policy-type-cost.test.ts). These pin that the check still refuses
    // what the constraint used to, on the option that names the fault.
    const createKeyedApp = () => initLambder<{ userId: string }>().create({
        files: testPublicFiles(),
        apiPath: '/api',
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        guards: {
            emailOwner: lambderGuard({ apiInput: z.object({ email: z.string() }), handler: async () => {} }),
            sessionOnly: lambderGuard({ session: true, handler: async () => {} }),
        },
        rateLimits: {
            limiter: new LambderMemoryRateLimiter(),
            policies: {
                perEmail: { perMin: 5, per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }) },
                perSession: { perMin: 5, per: 'session' },
            },
        },
    });
    const noEmail = { input: z.object({ name: z.string() }), output: z.object({}) };
    const withEmail = { input: z.object({ name: z.string(), email: z.string() }), output: z.object({}) };

    it('refuses an apiInput guard the input does not carry, as a name, a list or a map', () => {
        const app = createKeyedApp();
        app.registerApiGroups(app.defineApiGroup('test', {
            // @ts-expect-error the input carries no email for the guard's slice
            byName: app.defineApi({ ...noEmail, guards: 'emailOwner' }, async () => ({})),
            // @ts-expect-error the same, in the list form
            byList: app.defineApi({ ...noEmail, guards: ['emailOwner'] }, async () => ({})),
            // @ts-expect-error the same, in the map form
            byMap: app.defineApi({ ...noEmail, guards: { emailOwner: true } }, async () => ({})),
            // @ts-expect-error and on a session API
            session: app.defineApi({ ...noEmail, guards: ['sessionOnly', 'emailOwner'] }, async () => ({})),
        }));
    });

    it('refuses an apiInput-keyed rate limit the input does not carry, as a name, a list or a map', () => {
        const app = createKeyedApp();
        app.registerApiGroups(app.defineApiGroup('test', {
            // @ts-expect-error the input carries no email for the key's slice
            byName: app.defineApi({ ...noEmail, guards: 'sessionOnly', rateLimit: 'perEmail' }, async () => ({})),
            // @ts-expect-error the same, in the list form
            byList: app.defineApi({ ...noEmail, guards: 'sessionOnly', rateLimit: ['perEmail'] }, async () => ({})),
            // @ts-expect-error the same, in the map form
            byMap: app.defineApi({ ...noEmail, guards: 'sessionOnly', rateLimit: { perEmail: true } }, async () => ({})),
            // @ts-expect-error and on a public API
            public: app.defineApi({ ...noEmail, rateLimit: 'perEmail' }, async () => ({})),
        }));
    });

    it('still keeps a session-keyed policy off an API no guard of which needs a session, and a session guard off an instance without sessions, at compile time and at registration', () => {
        const app = createKeyedApp();
        // @ts-expect-error a public API has no session to key the limit by
        const limited = app.defineApi({ ...withEmail, rateLimit: 'perSession' }, async () => ({}));
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { limited })))
            .toThrow(/uses rate-limit policy "perSession" \(per "session"\), which counts per session, and none of its guards needs a session/);
        const sessionless = initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            guards: { sessionOnly: lambderGuard({ session: true, handler: async () => {} }) },
        });
        // @ts-expect-error an instance without sessions has no session for the guard to read
        const guarded = sessionless.defineApi({ ...withEmail, guards: 'sessionOnly' }, async () => ({}));
        expect(() => sessionless.registerApiGroups(sessionless.defineApiGroup('test', { guarded })))
            .toThrow(/a guard of API "test\.guarded" needs a session, and the instance was created without the session option/);
    });

    it('names the guards and policies at fault, and none when the input carries their fields', () => {
        type Guards = { emailOwner: { apiInput: { email: string } }; sessionOnly: { session: true } };
        type Policies = { perEmail: { per: { apiInput: z.ZodObject<{ email: z.ZodString }> } }; perIp: { per: 'ip' } };
        expectTypeOf<LambderGuardNamesInputLacks<Guards, 'emailOwner' | 'sessionOnly', { name: string }>>().toEqualTypeOf<'emailOwner'>();
        expectTypeOf<LambderGuardNamesInputLacks<Guards, 'emailOwner', { name: string; email: string }>>().toBeNever();
        expectTypeOf<LambderPolicyNamesInputLacks<Policies, 'perEmail' | 'perIp', { name: string }>>().toEqualTypeOf<'perEmail'>();
        expectTypeOf<LambderPolicyNamesInputLacks<Policies, 'perEmail', { email: string }>>().toBeNever();
    });

    it('accepts every form when the input carries the fields', () => {
        const app = createKeyedApp();
        expect(() => app.registerApiGroups(app.defineApiGroup('test', {
            byName: app.defineApi({ ...withEmail, guards: 'emailOwner', rateLimit: 'perEmail' }, async () => ({})),
            byList: app.defineApi({ ...withEmail, guards: ['emailOwner', 'sessionOnly'], rateLimit: ['perEmail', 'perSession'] }, async () => ({})),
            byMap: app.defineApi({ ...withEmail, guards: { sessionOnly: true, emailOwner: true }, rateLimit: { perEmail: true } }, async () => ({})),
            session: app.defineApi({ ...withEmail, guards: 'sessionOnly', rateLimit: 'perEmail' }, async () => ({})),
        })))
            .not.toThrow();
    });
});

describe('Annotating a policy or a policies map', () => {
    it('compiles with ctx typed, rather than failing as an implicit any', () => {
        // A key function typed as a union with a function member in each arm
        // defeats contextual typing: annotating with either type below would
        // be a hard TS7006 on `ctx`, so a policies map could not be declared
        // apart from the create() call at all.
        const perAddress: LambderRateLimitPer<LambderRenderContext> = {
            handler: (ctx) => ctx.ip,
        };
        const policies: Record<string, LambderApiRateLimitPolicyConfig<LambderRenderContext>> = {
            perIp: { perMin: 5, per: perAddress },
            perEmail: {
                perMin: 3,
                per: { apiInput: z.object({ email: z.string() }), handler: (ctx, payload) => `${ctx.ip}:${String((payload as { email: string }).email)}` },
            },
        };

        expect(Object.keys(policies)).toEqual(['perIp', 'perEmail']);
        expectTypeOf(perAddress).not.toBeAny();
    });

    it('keeps the apiInput correlation in the builder, where the literal is written', () => {
        const key = lambderRateLimitKey({
            apiInput: z.object({ email: z.string() }),
            // Typed from the schema, with no annotation at the call site.
            handler: (_ctx, { email }) => email.toLowerCase(),
        });
        expectTypeOf(key.apiInput).not.toBeAny();
    });
});

describe('The pipeline is bound to its own context', () => {
    it('refuses a policy whose key handler reads a context the pipeline does not run on', () => {
        // A third adapter built over the documented core gets the binding too:
        // the exported pipeline's rateLimits option is typed by its TCtx, not
        // by an `any` default.
        type BareContext = LambderApiCallContext<{ role: string }>;
        new LambderApiPipeline<BareContext, { role: string }>({
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                // @ts-expect-error the handler wants the server's render context, which this pipeline does not run on
                policies: { perIp: { perMin: 1, per: lambderRateLimitKey({ handler: (ctx) => ctx.ip }) } },
            },
        });

        // The same pipeline takes a handler written against its own context.
        expect(() => new LambderApiPipeline<BareContext, { role: string }>({
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: { perSubject: { perMin: 1, per: { handler: (ctx) => ctx.session?.sessionKey ?? 'anonymous' } } },
            },
        })).not.toThrow();
    });

    it('binds the SESSION context a guard runs on too, not only the public one', () => {
        // Typed as `any`, a session guard could be handed to any pipeline and
        // read whatever it liked off a context that does not carry it. The
        // session context is TCtx with the session narrowed, which is what
        // both shipped adapters declare, so pinning it costs them nothing.
        type BareContext = LambderApiCallContext<{ role: string }>;
        new LambderApiPipeline<BareContext, { role: string }>({
            // @ts-expect-error a server session guard reads ctx.ip, which the bare context does not carry
            guards: { tenant: lambderGuard({ session: true, handler: (ctx) => ({ from: `${ctx.ip}:${ctx.session.sessionKey}` }) }) },
        });

        // A guard written against this pipeline's own session context fits.
        const bareGuard = lambderGuardBuilder<BareContext, BareContext & { session: LambderSessionRecord<{ role: string }> }>();
        expect(() => new LambderApiPipeline<BareContext, { role: string }>({
            guards: { tenant: bareGuard({ session: true, handler: (ctx) => ({ role: ctx.session.data.role }) }) },
        })).not.toThrow();
    });
});

describe('callerIdentity sees the request, never a session', () => {
    it('does not compile a callerIdentity that reads ctx.session', () => {
        // It is consulted only on PUBLIC APIs, and a public call reads no
        // session, so `ctx.session?.data?.userId ?? null` would compile, run
        // and return null on every call: every public replay key a bearer
        // token again, silently, with no log and no test an app could write
        // to catch it. So the parameter type carries no session.
        new LambderApiPipeline<LambderApiCallContext<{ userId: string }>, { userId: string }>({
            idempotency: {
                store: new LambderMemoryIdempotencyStore(),
                // @ts-expect-error a public API reads no session; read what the request carries
                callerIdentity: (ctx) => ctx.session?.sessionKey ?? null,
            },
        });

        // What it is for: the credential the request itself carries.
        expect(() => new LambderApiPipeline<LambderApiCallContext<{ userId: string }>, { userId: string }>({
            idempotency: {
                store: new LambderMemoryIdempotencyStore(),
                callerIdentity: (_ctx, request) => (request.guardInputs?.device as { token?: string } | undefined)?.token ?? null,
            },
        })).not.toThrow();
    });
});

describe('A guard belongs to the adapter it was built for', () => {
    const mock = initLambderMock<{ 'secure.thing': { input: { value: string }; output: { result: string }; mode: 'session'; guards: 'tenant' } }, { userId: string }>();

    it('refuses a server-built guard in a mock guards map, and a mock-built guard in the server map', () => {
        const serverGuard = lambderGuard({ handler: (ctx) => ({ from: `${ctx.ip}:${ctx.method}` }) });
        const mockGuard = mock.guard({ handler: (ctx) => ({ from: ctx.apiName }) });

        mock.create({
            sessions: true,
            // @ts-expect-error the handler expects the server's render context, not the mock's
            guards: { tenant: serverGuard },
        });

        initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            // @ts-expect-error the handler expects the mock's call context, not the server's
            guards: { tenant: mockGuard },
        });

        // Each in its own map is fine.
        expect(() => initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            guards: { tenant: serverGuard },
        })).not.toThrow();
    });

    it('refuses a guard that answers CONDITIONALLY, not only one that always answers', () => {
        // A check that distributes over the union lets the `undefined` arm
        // pick the harmless branch, and the whole check comes back as
        // unknown. A guard that returns a response to deny and falls through
        // otherwise is the ordinary spelling of the mistake.
        // @ts-expect-error a guard authorizes, it does not answer
        const conditional = lambderGuard({ handler: (ctx) => ctx.ip === '203.0.113.7' ? new LambderResponse({ statusCode: 403, body: 'denied' }) : undefined });
        expect(typeof conditional).toBe('object');
    });
});

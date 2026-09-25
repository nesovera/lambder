/**
 * What the policy layer promises the COMPILER, which `npm run typecheck`
 * (tsconfig.tests.json) is what makes bite: vitest never evaluates a
 * @ts-expect-error. Each case below is a declaration that would compile and
 * enforce nothing, or a legitimate one that must stay possible to write.
 */

import { testPublicFiles } from './helpers.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderApiPipeline } from '../src/api/LambderApiPipeline.js';
import { LambderResponse } from '../src/core/LambderResponse.js';
import { lambderGuard, lambderRateLimitKey } from '../src/core/LambderPolicyBuilders.js';
import { lambderGuardBuilder } from '../src/api/LambderApiGuards.js';
import { initLambderMock } from '../src/mock/LambderMockApp.js';
import type {
    LambderApiRateLimitPolicyConfig,
    LambderRateLimitPer,
} from '../src/api/LambderApiRateLimits.js';
import type { LambderApiCallContext } from '../src/api/LambderApiCallContext.js';
import type { LambderSessionRecord } from '../src/shared/contracts/LambderSessionStore.js';
import type { LambderRenderContext } from '../src/core/LambderContext.js';

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
        const lambder = createApp();
        // @ts-expect-error an empty map declares no policy
        expect(() => lambder.addApi('a', { ...testSchema, rateLimit: {} }, async (_ctx, res) => res.api(null))).toThrow();
        // @ts-expect-error an empty list declares no policy
        expect(() => lambder.addApi('b', { ...testSchema, rateLimit: [] }, async (_ctx, res) => res.api(null))).toThrow();
        // @ts-expect-error a named policy with an undefined value declares nothing
        expect(() => lambder.addApi('c', { ...testSchema, rateLimit: { perIp: undefined } }, async (_ctx, res) => res.api(null))).toThrow();
    });

    it('still accepts every non-empty form', () => {
        expect(() => createApp()
            .addApi('one', { ...testSchema, rateLimit: 'perIp' }, async (_ctx, res) => res.api({ result: 'ok' }))
            .addApi('list', { ...testSchema, rateLimit: ['perIp'] }, async (_ctx, res) => res.api({ result: 'ok' }))
            .addApi('map', { ...testSchema, rateLimit: { perIp: true } }, async (_ctx, res) => res.api({ result: 'ok' }))
            .addApi('tuned', { ...testSchema, rateLimit: { perIp: { perMin: 1 } } }, async (_ctx, res) => res.api({ result: 'ok' })))
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
        app.addApi('guarded', {
            input: eitherKind,
            output: z.object({}),
            // @ts-expect-error a `kind: "b"` payload carries no email for the guard's slice
            guards: 'emailOwner',
        }, async (_ctx, res) => res.api({}));
        app.addApi('limited', {
            input: eitherKind,
            output: z.object({}),
            // @ts-expect-error a `kind: "b"` payload carries no email for the key's slice
            rateLimit: 'perEmail',
        }, async (_ctx, res) => res.api({}));
    });

    it('accepts a slice every member carries, and a plain input that carries it', () => {
        const everyKind = z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), email: z.string() }), z.object({ kind: z.literal('b'), email: z.string() })]);
        expect(() => createSliceApp()
            .addApi('union', { input: everyKind, output: z.object({}), guards: 'emailOwner', rateLimit: 'perEmail' }, async (_ctx, res) => res.api({}))
            .addApi('plain', { input: z.object({ email: z.string(), name: z.string() }), output: z.object({}), guards: 'emailOwner', rateLimit: 'perEmail' }, async (_ctx, res) => res.api({})))
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

/**
 * What the instance binds onto every context it renders: `ctx.sessionController`, the
 * session controller a handler, guard or hook reaches without holding the
 * instance, and `ctx.rateLimit` / `ctx.isRateLimited`, a named policy charged
 * by code for a key only the handler knows.
 *
 * Driven through lambderTestApp over a limiter that throws on any use, so a
 * charge that passes proves it went through the instance's own limiter, the
 * one the test app put in place, and not around it.
 */

import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { createContext } from '../../src/core/LambderContext.js';
import { lambderRateLimitKey } from '../../src/core/LambderPolicyBuilders.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { LAMBDER_REFUSAL_CODES } from '../../src/shared/wire/LambderApiRefusal.js';
import type { LambderRateLimiter } from '../../src/shared/contracts/LambderRateLimiter.js';
import type LambderSessionController from '../../src/session/LambderSessionController.js';
import type { LambderApiRateLimitPolicyConfig, LambderRateLimitCheckResult } from '../../src/api/LambderApiRateLimits.js';
import type { LambderApiOutcome } from '../../src/shared/wire/LambderApiOutcome.js';
import { lambderTestApp, assertApiSuccess, assertApiFailure } from '../../src/testing.js';
import { joinKeyFields } from '../../src/shared/util/joinKeyFields.js';
import { LambderKeyFieldDigest } from '../../src/shared/util/LambderKeyFieldDigest.js';
import { createApiEvent, createMockContext } from '../helpers.js';

type SessionData = { userId: string; role: 'admin' | 'member' };

const productionRateLimiter: LambderRateLimiter = {
    isRateLimited: () => { throw new Error('a test reached the production rate limiter'); },
};

afterEach(() => { vi.restoreAllMocks(); });

const lambderInit = initLambder<SessionData>();

const policies = {
    // Keyed by the code that charges it: one invited address.
    invitesPerRecipient: { perMin: 2, refusal: { type: 'warning', content: 'That address was invited too often.' } },
    invitesShared: { perMin: 2, budget: 'perPolicy' },
    pairPerIp: { perMin: 2, per: 'ip' },
    remindPerSession: { perMin: 1, per: 'session' },
    loginPerEmail: {
        perMin: 5,
        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }),
    },
} as const;

const createApp = () => {
    const app = lambderInit.create({
        apiPath: '/api',
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        rateLimits: { limiter: productionRateLimiter, failOpen: false, policies },
        guards: {
            // Built with the app's own builder, so the session is typed.
            signedInAs: lambderInit.guard({
                session: true,
                handler: async (ctx) => {
                    expectTypeOf(ctx.session.data).toEqualTypeOf<SessionData>();
                    expectTypeOf(ctx.sessionController).toEqualTypeOf<LambderSessionController<SessionData>>();
                    return { userId: ctx.session.data.userId };
                },
            }),
        },
    });
    const { defineApi } = app;
    return app
        .addHook('beforeRender', async (ctx) => (ctx.path === '/spread' ? { ...ctx, pathParams: { spread: 'yes' } } : ctx))
        .registerApiGroups(app.defineApiGroup('test', {
            login: defineApi({ input: z.object({ user: z.string() }), output: z.object({ ok: z.boolean() }) }, async (ctx) => {
                await ctx.sessionController.createSession(ctx.apiPayload.user, { userId: ctx.apiPayload.user, role: 'member' });
                return { ok: ctx.session?.data.userId === ctx.apiPayload.user };
            }),
            whoAmI: defineApi({ input: z.object({}), output: z.object({ userId: z.string().nullable() }) }, async (ctx) => {
                const session = await ctx.sessionController.fetchSessionIfExists();
                return { userId: session?.data.userId ?? null };
            }),
            guarded: defineApi({ input: z.object({}), output: z.object({ userId: z.string() }), guards: 'signedInAs' },
                async (ctx) => ({ userId: ctx.guardData.signedInAs.userId })),
            invite: defineApi({ input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx) => {
                await ctx.rateLimit('invitesPerRecipient', ctx.apiPayload.email);
                return { sent: true };
            }),
            inviteAgain: defineApi({ input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx) => {
                await ctx.rateLimit('invitesPerRecipient', ctx.apiPayload.email);
                return { sent: true };
            }),
            inviteShared: defineApi({ input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx) => {
                await ctx.rateLimit('invitesShared', ctx.apiPayload.email);
                return { sent: true };
            }),
            inviteSharedAgain: defineApi({ input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx) => {
                await ctx.rateLimit('invitesShared', ctx.apiPayload.email);
                return { sent: true };
            }),
            // A handler that says "too many" in its own output shape.
            pair: defineApi({ input: z.object({}), output: z.object({ error: z.string().nullable(), retryAfterSeconds: z.number().nullable() }) }, async (ctx) => {
                const verdict = await ctx.isRateLimited('pairPerIp');
                return verdict ? { error: 'too-many-attempts', retryAfterSeconds: verdict.retryAfterSeconds } : { error: null, retryAfterSeconds: null };
            }),
            // The same policy, declared: the charge from code lands on the same counter.
            pairDeclared: defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }), rateLimit: 'pairPerIp' }, async (_ctx) => ({ ok: true })),
            remind: defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'signedInAs' }, async (ctx) => {
                await ctx.rateLimit('remindPerSession');
                return { ok: true };
            }),
            misuse: defineApi({ input: z.object({ how: z.string() }), output: z.object({ ok: z.boolean() }) }, async (ctx) => {
                const loose = ctx.rateLimit as (policy: string, key?: string) => Promise<void>;
                if(ctx.apiPayload.how === 'keyForIp') await loose('pairPerIp', 'someone');
                if(ctx.apiPayload.how === 'noKey') await loose('invitesPerRecipient');
                if(ctx.apiPayload.how === 'unknown') await loose('nope', 'x');
                if(ctx.apiPayload.how === 'payloadKeyed') await loose('loginPerEmail');
                return { ok: true };
            }),
            // Compile-time: the policy names are the app's, the key is required where
            // the policy has no per and refused where the request supplies it.
            types: defineApi({ input: z.object({}), output: z.object({}) }, async (ctx) => {
                if(Math.random() > 2){
                    // @ts-expect-error an unknown policy
                    await ctx.rateLimit('nope', 'x');
                    // @ts-expect-error a policy without per needs its key
                    await ctx.rateLimit('invitesPerRecipient');
                    // @ts-expect-error a per-ip policy takes no key
                    await ctx.rateLimit('pairPerIp', 'someone');
                    // @ts-expect-error a payload-keyed policy is charged by the APIs declaring it
                    await ctx.rateLimit('loginPerEmail');
                    expectTypeOf(await ctx.isRateLimited('pairPerIp')).toEqualTypeOf<LambderRateLimitCheckResult>();
                }
                return {};
            }),
        }))
        .addRoute('/unsubscribe/:email', async (ctx, res) => {
            await ctx.rateLimit('invitesPerRecipient', ctx.pathParams.email);
            return res.text('unsubscribed');
        })
        .addRoute('/spread', async (ctx, res) => {
            // The hook answered a spread copy; the tools are bound to it.
            await ctx.sessionController.fetchSessionIfExists();
            return res.json({ spread: ctx.pathParams.spread ?? null, userId: ctx.session?.data.userId ?? null });
        });
};

describe('ctx.sessionController', () => {
    it('creates a session a later call reads, from a handler holding no instance', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor();

        assertApiSuccess(await visitor.apiOutcome('test.whoAmI', {}));
        expect(await visitor.api('test.whoAmI', {})).toEqual({ userId: null });
        // The controller writes onto the context it was reached through.
        expect(await visitor.api('test.login', { user: 'ada' })).toEqual({ ok: true });
        expect(await visitor.api('test.whoAmI', {})).toEqual({ userId: 'ada' });
    });

    it('is typed to the app session in a guard built with initLambder().guard', async () => {
        const app = lambderTestApp(createApp());
        const ada = await app.signIn('ada', { userId: 'ada', role: 'admin' });
        expect(await ada.api('test.guarded', {})).toEqual({ userId: 'ada' });
    });

    it('is bound again onto the context a beforeRender hook hands back as a spread copy', async () => {
        const app = lambderTestApp(createApp());
        const ada = await app.signIn('ada', { userId: 'ada', role: 'admin' });

        const page = await ada.request('GET', '/spread');
        // The copy carries none of the tools (they are not enumerable), so
        // this reads the session only because they were bound onto it.
        expect(page.json()).toEqual({ spread: 'yes', userId: 'ada' });
    });

    it('says the session option is missing when the instance has none', async () => {
        const instance = initLambder().create({ apiPath: '/api' });
        const app = lambderTestApp(instance.registerApiGroups(instance.defineApiGroup('test', {
            touch: instance.defineApi({ input: z.object({}), output: z.object({}) }, async (ctx) => { await ctx.sessionController.fetchSessionIfExists(); return {}; }),
        })));

        const outcome = await app.visitor().apiOutcome('test.touch', {});
        assertApiFailure(outcome, 'server');
        expect(String((outcome.error.cause as Error).message)).toMatch(/Session is not enabled/);
    });

    it('says what is missing on a context built by createContext() alone', () => {
        const ctx = createContext(createApiEvent({ apiName: 'test.whoAmI', payload: {} }), createMockContext(), { apiPath: '/api' });
        expect(() => ctx.sessionController).toThrow(/bound by the Lambder instance rendering the request/);
        expect(Object.keys(ctx)).not.toContain('sessionController');
    });

    it('lets createContext() default apiPath to the one create() defaults to', () => {
        // The option has create()'s obvious default, so it stays optional here too.
        const defaulted = createContext(createApiEvent({ apiName: 'test.whoAmI', payload: {} }), createMockContext());
        expect(defaulted.apiName).toBe('test.whoAmI');
        expect(initLambder().create({}).apiPath).toBe('/api');
        expect(createContext(createApiEvent({ apiName: 'test.whoAmI', payload: {} }), createMockContext(), { apiPath: '/rpc' }).apiName).toBeNull();
    });
});

describe('ctx.rateLimit and ctx.isRateLimited', () => {
    it('counts a key the handler supplies and refuses past the policy, with its message, 429 and Retry-After', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor();

        assertApiSuccess(await visitor.apiOutcome('test.invite', { email: 'ada@example.com' }));
        assertApiSuccess(await visitor.apiOutcome('test.invite', { email: 'ada@example.com' }));
        const refused = await visitor.apiOutcome('test.invite', { email: 'ada@example.com' });

        assertApiFailure(refused, 'refusal', { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
        expect(refused.refusal?.content).toBe('That address was invited too often.');
        expect(refused.retryAfterSeconds).toBeGreaterThan(0);
        // Another key has its own counter, from the same visitor.
        assertApiSuccess(await visitor.apiOutcome('test.invite', { email: 'grace@example.com' }));
    });

    it('counts per API by default and once across APIs on a perPolicy budget, as a declared limit does', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor();

        for(let attempt = 0; attempt < 2; attempt += 1){
            assertApiSuccess(await visitor.apiOutcome('test.invite', { email: 'a@example.com' }));
            assertApiSuccess(await visitor.apiOutcome('test.inviteAgain', { email: 'a@example.com' }));
        }

        assertApiSuccess(await visitor.apiOutcome('test.inviteShared', { email: 'b@example.com' }));
        assertApiSuccess(await visitor.apiOutcome('test.inviteSharedAgain', { email: 'b@example.com' }));
        assertApiFailure(await visitor.apiOutcome('test.inviteShared', { email: 'b@example.com' }), 'refusal', { status: 429 });
    });

    it('answers the check result instead of refusing, and shares the counter the declared limit charges', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor({ clientIp: '203.0.113.7' });

        expect(await visitor.api('test.pair', {})).toEqual({ error: null, retryAfterSeconds: null });
        assertApiSuccess(await visitor.apiOutcome('test.pairDeclared', {}));
        // Two attempts on the per-ip counter this API keeps: the third is over,
        // whichever way it was charged.
        const pairedApart = await visitor.api('test.pair', {});
        expect(pairedApart).toEqual({ error: null, retryAfterSeconds: null });
        const over = await visitor.api('test.pair', {});
        expect(over?.error).toBe('too-many-attempts');
        expect(over?.retryAfterSeconds).toBeGreaterThan(0);

        // Another address is another counter.
        expect(await app.visitor({ clientIp: '203.0.113.8' }).api('test.pair', {})).toEqual({ error: null, retryAfterSeconds: null });
    });

    it('keys a per-session policy off the session the call carries', async () => {
        const app = lambderTestApp(createApp());
        const ada = await app.signIn('ada', { userId: 'ada', role: 'admin' });
        const grace = await app.signIn('grace', { userId: 'grace', role: 'member' });

        assertApiSuccess(await ada.apiOutcome('test.remind', {}));
        assertApiFailure(await ada.apiOutcome('test.remind', {}), 'refusal', { status: 429 });
        assertApiSuccess(await grace.apiOutcome('test.remind', {}));
    });

    it('refuses on a route with a plain 429 carrying Retry-After and the policy message', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor();

        expect((await visitor.request('GET', '/unsubscribe/ada')).statusCode).toBe(200);
        expect((await visitor.request('GET', '/unsubscribe/ada')).statusCode).toBe(200);
        const refused = await visitor.request('GET', '/unsubscribe/ada');

        expect(refused.statusCode).toBe(429);
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
        expect(refused.text()).toBe('That address was invited too often.');
    });

    it('treats a charge the policy cannot take as the app bug it is', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor();
        const causeOf = async (how: string) => {
            const outcome = await visitor.apiOutcome('test.misuse', { how });
            assertApiFailure(outcome, 'server');
            return String((outcome.error.cause as Error).message);
        };

        expect(await causeOf('keyForIp')).toMatch(/keyed per "ip", so charging it takes no key/);
        expect(await causeOf('noKey')).toMatch(/declares no per, so the code charging it passes the key/);
        expect(await causeOf('unknown')).toMatch(/unknown rate-limit policy "nope"/);
        expect(await causeOf('payloadKeyed')).toMatch(/derives its key from an API's payload/);
    });

    it('fails open the way a declared limit does, and refuses to when failOpen is off', async () => {
        const failing: LambderRateLimiter = { isRateLimited: async () => { throw new Error('limiter down'); } };
        const build = (failOpen: boolean) => {
            const instance = lambderInit.create({ apiPath: '/api', rateLimits: { limiter: failing, failOpen, policies } });
            return instance.registerApiGroups(instance.defineApiGroup('test', {
                invite: instance.defineApi({ input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx) => {
                    await ctx.rateLimit('invitesPerRecipient', ctx.apiPayload.email);
                    return { sent: true };
                }),
            }));
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        // The test app is given the failing limiter as its own, so the throw is what runs.
        const open = lambderTestApp(build(true), { rateLimits: { limiter: failing } });
        expect(await open.visitor().api('test.invite', { email: 'ada@example.com' })).toEqual({ sent: true });
        expect(String(error.mock.calls[0]?.[0])).toMatch(/policy "invitesPerRecipient" \(perMin: 2\) could not be checked for API "test.invite"/);

        const closed = lambderTestApp(build(false), { rateLimits: { limiter: failing } });
        assertApiFailure(await closed.visitor().apiOutcome('test.invite', { email: 'ada@example.com' }), 'server');
    });

    it('counts a hook\'s charge for a call no API matched under no API, so a fresh posted name is no fresh counter', async () => {
        const app = lambderTestApp(lambderInit.create({
            apiPath: '/api',
            rateLimits: { limiter: productionRateLimiter, policies: { everyCallPerIp: { perMin: 2, per: 'ip' } } },
        }).addHook('beforeRender', async (ctx) => {
            // A hook's context does not know the app's policies: the name is
            // any string, and the key optional.
            await ctx.rateLimit('everyCallPerIp');
            return ctx;
        }));
        const call = app.visitor().apiOutcome as (apiName: string, payload: unknown) => Promise<LambderApiOutcome<unknown>>;

        assertApiFailure(await call('nope.n0', {}), 'refusal', { code: LAMBDER_REFUSAL_CODES.apiNotFound });
        assertApiFailure(await call('nope.n1', {}), 'refusal', { code: LAMBDER_REFUSAL_CODES.apiNotFound });
        assertApiFailure(await call('nope.n2', {}), 'refusal', { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
    });

    it('takes a policy typed as the general config wherever its per may fit', () => {
        const general: { perIp: LambderApiRateLimitPolicyConfig } = { perIp: { perMin: 1, per: 'ip' } };
        const instance = initLambder().create({ apiPath: '/api', rateLimits: { limiter: productionRateLimiter, policies: general } });
        instance.registerApiGroups(instance.defineApiGroup('test', {
            limited: instance.defineApi({ input: z.object({}), output: z.object({}), rateLimit: 'perIp' }, async (ctx) => {
                if(Math.random() > 2){
                    // The type cannot say whether the policy takes a key.
                    await ctx.rateLimit('perIp');
                    await ctx.rateLimit('perIp', 'key');
                }
                return {};
            }),
        }));
    });

    it('counts on the limiter the test app put under the instance', async () => {
        const limiter = new LambderMemoryRateLimiter();
        const app = lambderTestApp(createApp(), { rateLimits: { limiter } });

        await app.visitor().api('test.invite', { email: 'ada@example.com' });
        const recipientKey = await new LambderKeyFieldDigest('salt').digestOf('custom', 'ada@example.com');
        expect(limiter.countOf(joinKeyFields('api', 'test.invite', 'invitesPerRecipient', recipientKey), 'perMin')).toBe(1);
    });
});

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
import { initLambder } from '../src/core/Lambder.js';
import { createContext } from '../src/core/LambderContext.js';
import { lambderRateLimitKey } from '../src/core/LambderPolicyBuilders.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { LAMBDER_REFUSAL_CODES } from '../src/shared/wire/LambderApiRefusal.js';
import type { LambderRateLimiter } from '../src/shared/contracts/LambderRateLimiter.js';
import type LambderSessionController from '../src/session/LambderSessionController.js';
import type { LambderApiRateLimitPolicyConfig, LambderRateLimitCheckResult } from '../src/api/LambderApiRateLimits.js';
import type { LambderApiOutcome } from '../src/shared/wire/LambderApiOutcome.js';
import { lambderTestApp, assertApiSuccess, assertApiFailure } from '../src/testing.js';
import { joinKeyFields } from '../src/shared/util/joinKeyFields.js';
import { createApiEvent, createMockContext } from './helpers.js';

type SessionData = { userId: string; role: 'admin' | 'member' };

const productionRateLimiter: LambderRateLimiter = {
    isRateLimited: () => { throw new Error('a test reached the production rate limiter'); },
};

afterEach(() => { vi.restoreAllMocks(); });

const lambderInit = initLambder<SessionData>();

const policies = {
    // Keyed by the code that charges it: one invited address.
    invitesPerRecipient: { perMin: 2, errorMessage: { type: 'warning', content: 'That address was invited too often.' } },
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
    })
        .addHook('beforeRender', async (ctx) => (ctx.path === '/spread' ? { ...ctx, pathParams: { spread: 'yes' } } : ctx))
        .addApi('login', { input: z.object({ user: z.string() }), output: z.object({ ok: z.boolean() }) }, async (ctx, res) => {
            await ctx.sessionController.createSession(ctx.apiPayload.user, { userId: ctx.apiPayload.user, role: 'member' });
            return res.api({ ok: ctx.session?.data.userId === ctx.apiPayload.user });
        })
        .addApi('whoAmI', { input: z.object({}), output: z.object({ userId: z.string().nullable() }) }, async (ctx, res) => {
            const session = await ctx.sessionController.fetchSessionIfExists();
            return res.api({ userId: session?.data.userId ?? null });
        })
        .addSessionApi('guarded', { input: z.object({}), output: z.object({ userId: z.string() }), guards: 'signedInAs' },
            async (ctx, res) => res.api({ userId: ctx.guardData.signedInAs.userId }))
        .addApi('invite', { input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx, res) => {
            await ctx.rateLimit('invitesPerRecipient', ctx.apiPayload.email);
            return res.api({ sent: true });
        })
        .addApi('inviteAgain', { input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx, res) => {
            await ctx.rateLimit('invitesPerRecipient', ctx.apiPayload.email);
            return res.api({ sent: true });
        })
        .addApi('inviteShared', { input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx, res) => {
            await ctx.rateLimit('invitesShared', ctx.apiPayload.email);
            return res.api({ sent: true });
        })
        .addApi('inviteSharedAgain', { input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx, res) => {
            await ctx.rateLimit('invitesShared', ctx.apiPayload.email);
            return res.api({ sent: true });
        })
        // A handler that says "too many" in its own output shape.
        .addApi('pair', { input: z.object({}), output: z.object({ error: z.string().nullable(), retryAfterSeconds: z.number().nullable() }) }, async (ctx, res) => {
            const verdict = await ctx.isRateLimited('pairPerIp');
            return res.api(verdict ? { error: 'too-many-attempts', retryAfterSeconds: verdict.retryAfterSeconds } : { error: null, retryAfterSeconds: null });
        })
        // The same policy, declared: the charge from code lands on the same counter.
        .addApi('pairDeclared', { input: z.object({}), output: z.object({ ok: z.boolean() }), rateLimit: 'pairPerIp' }, async (_ctx, res) => res.api({ ok: true }))
        .addSessionApi('remind', { input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'signedInAs' }, async (ctx, res) => {
            await ctx.rateLimit('remindPerSession');
            return res.api({ ok: true });
        })
        .addApi('misuse', { input: z.object({ how: z.string() }), output: z.object({ ok: z.boolean() }) }, async (ctx, res) => {
            const loose = ctx.rateLimit as (policy: string, key?: string) => Promise<void>;
            if(ctx.apiPayload.how === 'keyForIp') await loose('pairPerIp', 'someone');
            if(ctx.apiPayload.how === 'noKey') await loose('invitesPerRecipient');
            if(ctx.apiPayload.how === 'unknown') await loose('nope', 'x');
            if(ctx.apiPayload.how === 'payloadKeyed') await loose('loginPerEmail');
            return res.api({ ok: true });
        })
        .addRoute('/unsubscribe/:email', async (ctx, res) => {
            await ctx.rateLimit('invitesPerRecipient', ctx.pathParams.email);
            return res.text('unsubscribed');
        })
        .addRoute('/spread', async (ctx, res) => {
            // The hook answered a spread copy; the tools are bound to it.
            await ctx.sessionController.fetchSessionIfExists();
            return res.json({ spread: ctx.pathParams.spread ?? null, userId: ctx.session?.data.userId ?? null });
        });

    // Compile-time: the policy names are the app's, the key is required where
    // the policy has no per and refused where the request supplies it.
    app.addApi('types', { input: z.object({}), output: z.object({}) }, async (ctx, res) => {
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
        return res.api({});
    });
    return app;
};

describe('ctx.sessionController', () => {
    it('creates a session a later call reads, from a handler holding no instance', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor();

        assertApiSuccess(await visitor.apiOutcome('whoAmI', {}));
        expect(await visitor.api('whoAmI', {})).toEqual({ userId: null });
        // The controller writes onto the context it was reached through.
        expect(await visitor.api('login', { user: 'ada' })).toEqual({ ok: true });
        expect(await visitor.api('whoAmI', {})).toEqual({ userId: 'ada' });
    });

    it('is typed to the app session in a guard built with initLambder().guard', async () => {
        const app = lambderTestApp(createApp());
        const ada = await app.signIn('ada', { userId: 'ada', role: 'admin' });
        expect(await ada.api('guarded', {})).toEqual({ userId: 'ada' });
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
        const app = lambderTestApp(initLambder().create({ apiPath: '/api' })
            .addApi('touch', { input: z.object({}), output: z.object({}) }, async (ctx, res) => { await ctx.sessionController.fetchSessionIfExists(); return res.api({}); }));

        const outcome = await app.visitor().apiOutcome('touch', {});
        assertApiFailure(outcome, 'server');
        expect(String((outcome.error.cause as Error).message)).toMatch(/Session is not enabled/);
    });

    it('says what is missing on a context built by createContext() alone', () => {
        const ctx = createContext(createApiEvent({ apiName: 'whoAmI', payload: {} }), createMockContext(), { apiPath: '/api' });
        expect(() => ctx.sessionController).toThrow(/bound by the Lambder instance rendering the request/);
        expect(Object.keys(ctx)).not.toContain('sessionController');
    });

    it('lets createContext() default apiPath to the one create() defaults to', () => {
        // The option has create()'s obvious default, so it stays optional here too.
        const defaulted = createContext(createApiEvent({ apiName: 'whoAmI', payload: {} }), createMockContext());
        expect(defaulted.apiName).toBe('whoAmI');
        expect(initLambder().create({}).apiPath).toBe('/api');
        expect(createContext(createApiEvent({ apiName: 'whoAmI', payload: {} }), createMockContext(), { apiPath: '/rpc' }).apiName).toBeNull();
    });
});

describe('ctx.rateLimit and ctx.isRateLimited', () => {
    it('counts a key the handler supplies and refuses past the policy, with its message, 429 and Retry-After', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor();

        assertApiSuccess(await visitor.apiOutcome('invite', { email: 'ada@example.com' }));
        assertApiSuccess(await visitor.apiOutcome('invite', { email: 'ada@example.com' }));
        const refused = await visitor.apiOutcome('invite', { email: 'ada@example.com' });

        assertApiFailure(refused, 'errorMessage', { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
        expect(refused.errorMessage?.content).toBe('That address was invited too often.');
        expect(refused.retryAfterSeconds).toBeGreaterThan(0);
        // Another key has its own counter, from the same visitor.
        assertApiSuccess(await visitor.apiOutcome('invite', { email: 'grace@example.com' }));
    });

    it('counts per API by default and once across APIs on a perPolicy budget, as a declared limit does', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor();

        for(let attempt = 0; attempt < 2; attempt += 1){
            assertApiSuccess(await visitor.apiOutcome('invite', { email: 'a@example.com' }));
            assertApiSuccess(await visitor.apiOutcome('inviteAgain', { email: 'a@example.com' }));
        }

        assertApiSuccess(await visitor.apiOutcome('inviteShared', { email: 'b@example.com' }));
        assertApiSuccess(await visitor.apiOutcome('inviteSharedAgain', { email: 'b@example.com' }));
        assertApiFailure(await visitor.apiOutcome('inviteShared', { email: 'b@example.com' }), 'errorMessage', { status: 429 });
    });

    it('answers the check result instead of refusing, and shares the counter the declared limit charges', async () => {
        const app = lambderTestApp(createApp());
        const visitor = app.visitor({ clientIp: '203.0.113.7' });

        expect(await visitor.api('pair', {})).toEqual({ error: null, retryAfterSeconds: null });
        assertApiSuccess(await visitor.apiOutcome('pairDeclared', {}));
        // Two attempts on the per-ip counter this API keeps: the third is over,
        // whichever way it was charged.
        const pairedApart = await visitor.api('pair', {});
        expect(pairedApart).toEqual({ error: null, retryAfterSeconds: null });
        const over = await visitor.api('pair', {});
        expect(over?.error).toBe('too-many-attempts');
        expect(over?.retryAfterSeconds).toBeGreaterThan(0);

        // Another address is another counter.
        expect(await app.visitor({ clientIp: '203.0.113.8' }).api('pair', {})).toEqual({ error: null, retryAfterSeconds: null });
    });

    it('keys a per-session policy off the session the call carries', async () => {
        const app = lambderTestApp(createApp());
        const ada = await app.signIn('ada', { userId: 'ada', role: 'admin' });
        const grace = await app.signIn('grace', { userId: 'grace', role: 'member' });

        assertApiSuccess(await ada.apiOutcome('remind', {}));
        assertApiFailure(await ada.apiOutcome('remind', {}), 'errorMessage', { status: 429 });
        assertApiSuccess(await grace.apiOutcome('remind', {}));
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
            const outcome = await visitor.apiOutcome('misuse', { how });
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
        const build = (failOpen: boolean) => lambderInit.create({ apiPath: '/api', rateLimits: { limiter: failing, failOpen, policies } })
            .addApi('invite', { input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }) }, async (ctx, res) => {
                await ctx.rateLimit('invitesPerRecipient', ctx.apiPayload.email);
                return res.api({ sent: true });
            });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        // The test app is given the failing limiter as its own, so the throw is what runs.
        const open = lambderTestApp(build(true), { rateLimits: { limiter: failing } });
        expect(await open.visitor().api('invite', { email: 'ada@example.com' })).toEqual({ sent: true });
        expect(String(error.mock.calls[0]?.[0])).toMatch(/policy "invitesPerRecipient" \(perMin: 2\) could not be checked for API "invite"/);

        const closed = lambderTestApp(build(false), { rateLimits: { limiter: failing } });
        assertApiFailure(await closed.visitor().apiOutcome('invite', { email: 'ada@example.com' }), 'server');
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

        assertApiFailure(await call('nope0', {}), 'errorMessage', { code: LAMBDER_REFUSAL_CODES.apiNotFound });
        assertApiFailure(await call('nope1', {}), 'errorMessage', { code: LAMBDER_REFUSAL_CODES.apiNotFound });
        assertApiFailure(await call('nope2', {}), 'errorMessage', { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
    });

    it('takes a policy typed as the general config wherever its per may fit', () => {
        const general: { perIp: LambderApiRateLimitPolicyConfig } = { perIp: { perMin: 1, per: 'ip' } };
        initLambder().create({ apiPath: '/api', rateLimits: { limiter: productionRateLimiter, policies: general } })
            .addApi('limited', { input: z.object({}), output: z.object({}), rateLimit: 'perIp' }, async (ctx, res) => {
                if(Math.random() > 2){
                    // The type cannot say whether the policy takes a key.
                    await ctx.rateLimit('perIp');
                    await ctx.rateLimit('perIp', 'key');
                }
                return res.api({});
            });
    });

    it('counts on the limiter the test app put under the instance', async () => {
        const limiter = new LambderMemoryRateLimiter();
        const app = lambderTestApp(createApp(), { rateLimits: { limiter } });

        await app.visitor().api('invite', { email: 'ada@example.com' });
        expect(limiter.countOf(joinKeyFields('api', 'invite', 'invitesPerRecipient', 'custom:ada@example.com'), 'perMin')).toBe(1);
    });
});

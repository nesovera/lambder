/**
 * What create() accepts.
 *
 * Mostly a COMPILE-time suite: the assertions that matter are the
 * `@ts-expect-error` directives, which `npm run typecheck` evaluates and
 * vitest alone never would. A misspelled nested option key is the failure
 * mode this file exists for: `const TOptions` switches excess-property
 * checking off for the whole literal, so before the nested rule every one of
 * these typos compiled and silently disabled the control it named.
 *
 * The runtime `it` blocks cover the option values validated at construction
 * and the registration checks that must not burn an API name.
 */

import { testPublicFiles } from './helpers.js';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import type { LambderCreateOptions } from '../src/core/LambderCreateOptions.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';

const store = new LambderMemorySessionStore();
const limiter = new LambderMemoryRateLimiter();
const idempotencyStore = new LambderMemoryIdempotencyStore();
const sessionSalt = 'salt';
const policies = { perIp: { perMin: 5, per: 'ip' } } as const;

describe('create(): surplus keys at the top level', () => {
    it('accepts the documented options and refuses a misspelled one', () => {
        initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            maxResponseBytes: 1_000,
            requirePublicApiGuards: false,
        });

        // @ts-expect-error requireSessionApiGuard, no trailing "s"
        initLambder().create({ apiPath: '/api', requireSessionApiGuard: true });
        // @ts-expect-error maxResponseByte, no trailing "s"
        initLambder().create({ apiPath: '/api', maxResponseByte: 1000 });
    });
});

describe('create(): surplus keys one level down', () => {
    it('accepts a legitimate session option and refuses a misspelled cookie name key', () => {
        initLambder<{ userId: string }>().create({
            apiPath: '/api',
            session: {
                store,
                sessionSalt,
                tokenCookieKey: 'APPTOKEN',
                csrfCookieKey: 'APPCSRF',
                enableSlidingExpiration: true,
                cookie: { domain: '.example.com', path: '/', sameSite: 'Lax', secure: true },
            },
        });

        initLambder<{ userId: string }>().create({
            apiPath: '/api',
            // @ts-expect-error tokenCookieKe, no trailing "y"
            session: { store, sessionSalt, tokenCookieKe: 'APPTOKEN' },
        });

        initLambder<{ userId: string }>().create({
            apiPath: '/api',
            // @ts-expect-error sameSit, inside session.cookie
            session: { store, sessionSalt, cookie: { sameSit: 'Lax' } },
        });
    });

    it('accepts a legitimate idempotency option and refuses the two typos that disable it', () => {
        initLambder().create({
            apiPath: '/api',
            idempotency: {
                store: idempotencyStore,
                failOpen: false,
                defaultTtlSeconds: 60,
                defaultPendingTtlSeconds: 30,
                callerIdentity: () => null,
            },
        });

        // @ts-expect-error failOpn: the engine would keep failing open
        initLambder().create({ apiPath: '/api', idempotency: { store: idempotencyStore, failOpn: false } });
        // @ts-expect-error callerIdentitiy: every public replay key stays a bearer token
        initLambder().create({ apiPath: '/api', idempotency: { store: idempotencyStore, callerIdentitiy: () => null } });
    });

    it('accepts a legitimate rateLimits option and refuses a surplus key on it or on a policy', () => {
        initLambder().create({
            apiPath: '/api',
            rateLimits: { limiter, policies: { perIp: { perMin: 1, per: 'ip', budget: 'perPolicy' } } },
        });

        // @ts-expect-error extraKey is not a field of the rateLimits config
        initLambder().create({ apiPath: '/api', rateLimits: { limiter, policies, extraKey: 1 } });

        initLambder().create({
            apiPath: '/api',
            // @ts-expect-error budgt, inside one named policy
            rateLimits: { limiter, policies: { p: { perMin: 1, per: 'ip', budgt: 'perPolicy' } } },
        });
    });

    it('accepts a legitimate cors config and refuses the typo that opens it to every origin', () => {
        initLambder().create({
            apiPath: '/api',
            cors: { origins: ['https://app.example.com'], credentials: true, methods: ['GET'], allowHeaders: ['Content-Type'], exposeHeaders: ['Retry-After'], maxAge: 600 },
        });

        // @ts-expect-error origns: the allowlist is gone, which means "*", and credentials are on
        initLambder().create({ apiPath: '/api', cors: { credentials: true, origns: ['https://app.example.com'] } });
        // @ts-expect-error credential, no trailing "s"
        initLambder().create({ apiPath: '/api', cors: { origins: ['https://app.example.com'], credential: true } });
    });

    it('accepts a legitimate compression config and refuses a surplus key on it', () => {
        initLambder().create({ apiPath: '/api', compression: { minBytes: 10, encodings: ['gzip'], quality: 5 } });

        // @ts-expect-error minByte, no trailing "s": the default threshold would stand
        initLambder().create({ apiPath: '/api', compression: { quality: 5, minByte: 10 } });
    });

    it('accepts a legitimate guard and refuses a surplus key on one', () => {
        initLambder().create({
            apiPath: '/api',
            guards: { g: { apiInput: z.object({}), handler: () => true } },
        });

        initLambder().create({
            apiPath: '/api',
            // @ts-expect-error apiinput, lowercase i
            guards: { g: { apiinput: z.object({}), handler: () => true } },
        });

        initLambder().create({
            apiPath: '/api',
            // @ts-expect-error sesion, one s: the guard would read a context with no session
            guards: { g: { sesion: true, handler: () => true } },
        });
    });
});

describe('create(): the require*ApiGuards flags outside a fresh literal', () => {
    it('keeps the compile-time half when the options are spread from a typed object', () => {
        const baseOptions: LambderCreateOptions = {
            apiPath: '/api',
            guards: { g: { handler: () => true } },
            requirePublicApiGuards: true,
        };
        const app = initLambder().create({ ...baseOptions });

        // The flag survived the spread: guards is still required here, even
        // though the spread widened `true` to `boolean`.
        // @ts-expect-error guards is required on this instance
        const missing = () => app.addApi('open', { input: z.object({}), output: z.object({}) }, async (ctx, res) => res.api({}));
        expect(missing).toThrow(/declares no guards/);
    });

    it('an instance that names neither flag keeps guards optional', () => {
        const app = initLambder().create({ apiPath: '/api', guards: { g: { handler: () => true } } });
        expect(() => app.addApi('open', { input: z.object({}), output: z.object({}) }, async (ctx, res) => res.api({}))).not.toThrow();
    });
});

describe('create(): session registrations need the session option', () => {
    it('refuses a session API at compile time and at registration', () => {
        const app = initLambder().create({ apiPath: '/api' });

        // @ts-expect-error sessions are not configured on this instance
        expect(() => app.addSessionApi('me', { input: z.any(), output: z.any() }, async (ctx, res) => res.api(null)))
            .toThrow(/needs the session option at creation/);

        // @ts-expect-error sessions are not configured on this instance
        app.addSessionRoute('/me', async (ctx, res) => res.text('never reached'));
    });

    it('accepts both once the session option is there', () => {
        const app = initLambder<{ userId: string }>().create({ apiPath: '/api', session: { store, sessionSalt } });
        expect(() => app
            .addSessionApi('me', { input: z.any(), output: z.any() }, async (ctx, res) => res.api({ userId: ctx.session.data.userId }))
            .addSessionRoute('/me', async (ctx, res) => res.text(ctx.session.data.userId))).not.toThrow();
    });
});

describe('create(): option values checked at construction', () => {
    it('refuses an apiPath that is not a path', () => {
        expect(() => new Lambder({ apiPath: 'api' })).toThrow(/Lambder: apiPath must be a path starting with "\/"/);
        expect(() => new Lambder({ apiPath: '' })).toThrow(/Lambder: apiPath/);
        expect(() => new Lambder({ apiPath: '/api' })).not.toThrow();
    });

    it('refuses an empty apiVersion', () => {
        expect(() => new Lambder({ apiVersion: '' })).toThrow(/Lambder: apiVersion must not be empty/);
        expect(() => new Lambder({ apiVersion: '2' })).not.toThrow();
        expect(() => new Lambder({})).not.toThrow();
    });

    it('refuses a maxResponseBytes that is not a positive integer', () => {
        expect(() => new Lambder({ maxResponseBytes: 0 })).toThrow(/Lambder: maxResponseBytes must be a positive integer/);
        expect(() => new Lambder({ maxResponseBytes: -1 })).toThrow(/Lambder: maxResponseBytes/);
        expect(() => new Lambder({ maxResponseBytes: 1.5 })).toThrow(/Lambder: maxResponseBytes/);
        expect(() => new Lambder({ maxResponseBytes: 1_000 })).not.toThrow();
    });
});

describe('API registration does not burn the name it refused', () => {
    it('reports the same reason on the second attempt', () => {
        const app = new Lambder({ apiPath: '/api' });
        const register = () => app.addSessionApi('user.profile', { input: z.any(), output: z.any() }, async (ctx, res) => res.api(null));

        expect(register).toThrow(/needs the session option at creation/);
        // Not "duplicate API name": the first attempt registered nothing, so
        // the retry has to report the problem the app is trying to fix.
        expect(register).toThrow(/needs the session option at creation/);
    });

    it('still refuses a genuine duplicate', () => {
        const app = new Lambder({ apiPath: '/api' })
            .addApi('thing', { input: z.any(), output: z.any() }, async (ctx, res) => res.api(null));

        expect(() => app.addApi('thing', { input: z.any(), output: z.any() }, async (ctx, res) => res.api(null)))
            .toThrow(/duplicate API name/);
    });
});

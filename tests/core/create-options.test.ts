/**
 * What create() accepts.
 *
 * Mostly a COMPILE-time suite: the assertions that matter are the
 * `@ts-expect-error` directives, which `npm run typecheck` evaluates and
 * vitest alone never would. A misspelled nested option key is the failure
 * mode this file exists for: `const TOptions` switches excess-property
 * checking off for the whole literal, so without the nested rule every one of
 * these typos would compile and silently disable the control it names.
 *
 * The runtime `it` blocks cover the option values validated at construction
 * and the registration checks that must not burn an API name.
 */

import { testPublicFiles } from '../helpers.js';
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import Lambder, { initLambder, type LambderInitCreateOptions } from '../../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import { lambderTestApp, assertApiSuccess } from '../../src/testing.js';

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
            requireApiGuards: false,
        });

        // @ts-expect-error requireApiGuard, no trailing "s"
        initLambder().create({ apiPath: '/api', requireApiGuard: true });
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

        // The typo is a compile error, and at runtime the allowlist it lost
        // leaves credentials on for every origin, which create() refuses.
        // @ts-expect-error origns: the allowlist is gone, which means "*", and credentials are on
        expect(() => initLambder().create({ apiPath: '/api', cors: { credentials: true, origns: ['https://app.example.com'] } })).toThrow(/allowlist or a predicate/);
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

describe('create(): guards and rate-limit policies as a list of maps', () => {
    const ordersGuards = { orderOwner: lambderGuard({ handler: () => 'owner' }) };
    const catalogGuards = { catalogEditor: lambderGuard({ handler: () => 'editor' }) };
    const ordersPolicies = { checkoutPerIp: { perMin: 5, per: 'ip' } } as const;
    const catalogPolicies = { searchPerIp: { perMin: 60, per: 'ip' } } as const;

    it('declares every name in the list, so an API names a guard or a policy from any map', async () => {
        const app = initLambder().create({
            apiPath: '/api',
            rateLimits: { limiter, policies: [ordersPolicies, catalogPolicies] },
            guards: [ordersGuards, catalogGuards],
        });
        const lambder = app.registerApiGroups(
            app.defineApiGroup('orders', {
                checkout: app.defineApi({ input: z.object({}), output: z.object({ by: z.string() }), guards: 'orderOwner', rateLimit: 'checkoutPerIp' },
                    async (ctx) => ({ by: ctx.guardData.orderOwner })),
            }),
            app.defineApiGroup('catalog', {
                edit: app.defineApi({ input: z.object({}), output: z.object({ by: z.string() }), guards: 'catalogEditor', rateLimit: 'searchPerIp' },
                    async (ctx) => ({ by: ctx.guardData.catalogEditor })),
            }),
        );

        const visitor = lambderTestApp(lambder).visitor();
        const checkout = await visitor.apiOutcome('orders.checkout', {});
        assertApiSuccess(checkout);
        expect(checkout.payload).toEqual({ by: 'owner' });
        const edit = await visitor.apiOutcome('catalog.edit', {});
        assertApiSuccess(edit);
        expect(edit.payload).toEqual({ by: 'editor' });
        expect(Object.keys((await lambder.apiOptionEntries()).guards).sort()).toEqual(['catalogEditor', 'orderOwner']);
        const refunds = app.defineApiGroup('refunds', {
            // @ts-expect-error a guard no map declares
            refund: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'refundClerk' }, async () => ({})),
        });
        expect(() => app.registerApiGroups(refunds)).toThrow(/unknown guard "refundClerk"/);
    });

    it('refuses a name two maps declare, at compile time and at creation', () => {
        expect(() => initLambder().create({
            apiPath: '/api',
            // @ts-expect-error orderOwner is declared in both maps
            guards: [ordersGuards, { orderOwner: lambderGuard({ handler: () => 'someone else' }) }],
        })).toThrow(/guard "orderOwner" is declared in two of the maps/);
        expect(() => initLambder().create({
            apiPath: '/api',
            // @ts-expect-error checkoutPerIp is declared in both maps
            rateLimits: { limiter, policies: [ordersPolicies, { checkoutPerIp: { perMin: 1, per: 'ip' } }] },
        })).toThrow(/rate-limit policy "checkoutPerIp" is declared in two of the maps/);
    });

    it('names the repeated name in the compile error, however different the two declarations are', () => {
        // Compiled apart with the package's own compiler options, since a
        // file that fails to compile cannot sit among the tests. The two
        // declarations of each name differ in shape, as they do when two
        // parts of an app pick the same name for different things.
        const directory = mkdtempSync(join(tmpdir(), 'lambder-named-maps-'));
        try {
            const sourceOf = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
            const app = join(directory, 'app.mts');
            writeFileSync(app, [
                `import { initLambder } from ${sourceOf('../../src/core/Lambder.js')};`,
                `import { lambderGuard } from ${sourceOf('../../src/core/LambderPolicyBuilders.js')};`,
                `import { LambderMemoryRateLimiter } from ${sourceOf('../../src/stores/LambderMemoryRateLimiter.js')};`,
                `initLambder().create({ guards: [{ orderOwner: lambderGuard({ handler: () => 'owner' }) }, { orderOwner: lambderGuard({ handler: () => {} }) }] });`,
                `initLambder().create({ rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: [{ checkoutPerIp: { perMin: 5, per: 'ip' } }, { checkoutPerIp: { perHour: 100, per: 'ip' } }] } });`,
            ].join('\n'));
            const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL('../../tsconfig.json', import.meta.url)), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
            const program = ts.createProgram([app], { ...config!.options, noEmit: true, declaration: false, rootDir: undefined, outDir: undefined });
            const messages = ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

            expect(messages).toHaveLength(2);
            expect(messages[0]).toContain('lambder: a name is declared in more than one of these maps');
            expect(messages[0]).toContain('"orderOwner"');
            expect(messages[1]).toContain('lambder: a name is declared in more than one of these maps');
            expect(messages[1]).toContain('"checkoutPerIp"');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 120_000);

    it('holds every map of a list to the same surplus-key checks as a lone map', () => {
        initLambder().create({
            apiPath: '/api',
            // @ts-expect-error budgt, inside a policy of the second map
            rateLimits: { limiter, policies: [ordersPolicies, { p: { perMin: 1, per: 'ip', budgt: 'perPolicy' } }] },
        });
        initLambder().create({
            apiPath: '/api',
            // @ts-expect-error sesion, inside a guard of the second map
            guards: [ordersGuards, { g: { sesion: true, handler: () => true } }],
        });
    });
});

describe('create(): the requireApiGuards flag outside a fresh literal', () => {
    it('keeps the compile-time half when the options are spread from a typed object', () => {
        // create()'s options: the constructor's less the vocabulary, which declareRefusals() supplies.
        const baseOptions: LambderInitCreateOptions<any> = {
            apiPath: '/api',
            guards: { g: { handler: () => true } },
            requireApiGuards: true,
        };
        const app = initLambder().create({ ...baseOptions });

        // The flag survived the spread: guards is still required here, even
        // though the spread widened `true` to `boolean`.
        const tools = app.defineApiGroup('tools', {
            // @ts-expect-error guards is required on this instance
            open: app.defineApi({ input: z.object({}), output: z.object({}) }, async (ctx) => ({})),
        });
        const missing = () => app.registerApiGroups(tools);
        expect(missing).toThrow(/declares no guards/);
    });

    it('an instance that does not name the flag keeps guards optional', () => {
        const app = initLambder().create({ apiPath: '/api', guards: { g: { handler: () => true } } });
        const tools = app.defineApiGroup('tools', {
            open: app.defineApi({ input: z.object({}), output: z.object({}) }, async (ctx) => ({})),
        });
        expect(() => app.registerApiGroups(tools)).not.toThrow();
    });
});

describe('create(): session registrations need the session option', () => {
    it('refuses a session endpoint at compile time and at registration', () => {
        const app = initLambder().create({ apiPath: '/api', guards: { signedIn: lambderGuard({ session: true, handler: async () => {} }) } });

        const account = app.defineApiGroup('account', {
            // @ts-expect-error sessions are not configured on this instance
            me: app.defineApi({ input: z.any(), output: z.any(), guards: 'signedIn' }, async (ctx) => null),
        });
        expect(() => app.registerApiGroups(account))
            .toThrow(/needs a session, and the instance was created without the session option/);

        // @ts-expect-error sessions are not configured on this instance
        app.addSessionRoute('/me', async (ctx, res) => res.text('never reached'));
    });

    it('accepts both once the session option is there', () => {
        const app = initLambder<{ userId: string }>().create({
            apiPath: '/api',
            session: { store, sessionSalt },
            guards: { signedIn: initLambder<{ userId: string }>().guard({ session: true, handler: async () => {} }) },
        });
        const account = app.defineApiGroup('account', {
            me: app.defineApi({ input: z.any(), output: z.any(), guards: 'signedIn' }, async (ctx) => ({ userId: ctx.session.data.userId })),
        });
        expect(() => app
            .registerApiGroups(account)
            .addSessionRoute('/me', async (ctx, res) => res.text(ctx.session.data.userId))).not.toThrow();
    });
});

describe('create(): option values checked at construction', () => {
    it('refuses an apiPath that is not a path', () => {
        expect(() => new Lambder({ apiPath: 'api' })).toThrow(/Lambder: apiPath must be a path starting with "\/"/);
        expect(() => new Lambder({ apiPath: '' })).toThrow(/Lambder: apiPath/);
        expect(() => new Lambder({ apiPath: '/api' })).not.toThrow();
    });

    it('takes a dotted apiVersion as the envelope stamp, and a dotted minApiVersion at or below it', () => {
        expect(() => new Lambder({ apiVersion: '' })).toThrow(/Lambder: apiVersion must be a dotted version/);
        expect(() => new Lambder({ apiVersion: 'dev' })).toThrow(/Lambder: apiVersion must be a dotted version/);
        expect(() => new Lambder({ apiVersion: '2026-09-15' })).toThrow(/Lambder: apiVersion must be a dotted version/);
        expect(() => new Lambder({ apiVersion: '2' })).not.toThrow();
        expect(() => new Lambder({ apiVersion: '1.2.2' })).not.toThrow();
        expect(() => new Lambder({})).not.toThrow();
        expect(() => new Lambder({ apiVersion: '1.2.32', minApiVersion: '1.2.10' })).not.toThrow();
        expect(() => new Lambder({ apiVersion: '1.2.32', minApiVersion: '1.2.32' })).not.toThrow();
        expect(() => new Lambder({ minApiVersion: '1.2.10' })).not.toThrow();
        // A floor above the build's own version would refuse its own clients.
        expect(() => new Lambder({ apiVersion: '1.2.5', minApiVersion: '1.2.10' })).toThrow(/Lambder: minApiVersion 1\.2\.10 is above apiVersion 1\.2\.5/);
        expect(() => initLambder().create({ apiVersion: '1.2.5', minApiVersion: '1.2.10' })).toThrow(/Lambder: minApiVersion 1\.2\.10 is above apiVersion 1\.2\.5/);
        expect(() => new Lambder({ minApiVersion: '' })).toThrow(/Lambder: minApiVersion must be a dotted version/);
        expect(() => new Lambder({ minApiVersion: '1.2.' })).toThrow(/Lambder: minApiVersion must be a dotted version/);
    });

    it('keeps apiPath, apiVersion and files as created, since what was built from them keeps its own copy', () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api', apiVersion: '1.2.0' });
        // @ts-expect-error read-only: callers post to the apiPath they were built with
        lambder.apiPath = '/v2';
        // @ts-expect-error read-only: the pipeline stamps the apiVersion it was given
        lambder.apiVersion = '2.0.0';
        // @ts-expect-error read-only: servePublicFiles serves through the reader it was given
        lambder.files = null;
    });

    it('documents initLambder where an editor shows it: on the declaration itself', () => {
        const source = fileURLToPath(new URL('../../src/core/Lambder.ts', import.meta.url));
        const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL('../../tsconfig.json', import.meta.url)), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
        const program = ts.createProgram([source], { ...config!.options, noEmit: true, declaration: false });
        const checker = program.getTypeChecker();
        const documentationOf = (name: string): string => {
            const file = program.getSourceFile(source)!;
            const symbol = checker.getSymbolsInScope(file, ts.SymbolFlags.Value | ts.SymbolFlags.Type).find((candidate) => candidate.name === name);
            return ts.displayPartsToString(symbol?.getDocumentationComment(checker) ?? []);
        };
        const initDoc = documentationOf('initLambder');
        expect(initDoc).toMatch(/^The entry point of an app, and the canonical way to create an instance/);
        expect(initDoc).toContain('declareRefusals()');
        expect(initDoc).toContain('Curried because');
        expect(documentationOf('LambderInitCreateOptions')).toBe("The options create() takes: the constructor's, less the two declareRefusals() supplies.");
    }, 120_000);

    it('refuses a maxResponseBytes that is not a positive integer', () => {
        expect(() => new Lambder({ maxResponseBytes: 0 })).toThrow(/Lambder: maxResponseBytes must be a positive integer/);
        expect(() => new Lambder({ maxResponseBytes: -1 })).toThrow(/Lambder: maxResponseBytes/);
        expect(() => new Lambder({ maxResponseBytes: 1.5 })).toThrow(/Lambder: maxResponseBytes/);
        expect(() => new Lambder({ maxResponseBytes: 1_000 })).not.toThrow();
    });
});

describe('API registration does not burn the name it refused', () => {
    it('reports the same reason on the second attempt', () => {
        const app = initLambder().create({ apiPath: '/api', guards: { signedIn: lambderGuard({ session: true, handler: async () => {} }) } });
        const register = () => app.registerApiGroups(app.defineApiGroup('user', {
            // @ts-expect-error sessions are not configured on this instance
            profile: app.defineApi({ input: z.any(), output: z.any(), guards: 'signedIn' }, async (ctx) => null),
        }));

        expect(register).toThrow(/needs a session, and the instance was created without the session option/);
        // Not a duplicate: the first attempt registered nothing, so the retry
        // has to report the problem the app is trying to fix.
        expect(register).toThrow(/needs a session, and the instance was created without the session option/);
    });

    it('still refuses a genuine duplicate', () => {
        const app = new Lambder({ apiPath: '/api' });
        const tools = () => app.defineApiGroup('tools', { thing: app.defineApi({ input: z.any(), output: z.any() }, async (ctx) => null) });
        app.registerApiGroups(tools());

        expect(() => app.registerApiGroups(tools()))
            .toThrow(/group "tools" is registered twice/);
    });
});

/**
 * Endpoints as values: declared with defineApi on the instance, gathered by
 * defineApiGroup, registered by registerApiGroups, and called at
 * `{apiPath}/{group}/{action}`, by name or through a caller's group. The mode
 * is read off the guards: a guard that needs a session makes a session
 * endpoint, and nothing else says so.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { lambderTestApp, assertApiFailure, assertApiSuccess } from '../../src/testing.js';
import { createApiEvent, createMockContext, createMockEvent } from '../helpers.js';
import LambderCaller from '../../src/client/LambderCaller.js';
import LambderInvokeCaller from '../../src/invoke/LambderInvokeCaller.js';
import { LambderTestVisitor } from '../../src/testing/LambderTestVisitor.js';
import { LAMBDER_REFUSAL_CODES } from '../../src/shared/wire/LambderApiRefusal.js';
import type { LambderRegistrableApiGroup } from '../../src/api/LambderApiDeclarations.js';
import type { LambderFallbackHandler } from '../../src/core/LambderCreateOptions.js';
import { LAMBDER_CALLER_MEMBER_NAMES, LAMBDER_RESERVED_GROUP_NAMES, apiCallPath, apiNameOfCallPath } from '../../src/shared/wire/LambderApiNames.js';
import { html } from '../../src/shared/LambderHtml.js';

type Session = { userId: string };

/** An app with one guard that needs a session and one that does not. */
const createApp = () => initLambder<Session>().create({
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    rateLimits: {
        limiter: new LambderMemoryRateLimiter(),
        policies: { perIp: { perMin: 100, per: 'ip' }, perSession: { perMin: 100, per: 'session' } },
    },
    guards: {
        signedIn: initLambder<Session>().guard({ session: true, handler: async (ctx) => ({ userId: ctx.session.data.userId }) }),
        anyone: initLambder<Session>().guard({ handler: async () => {} }),
    },
});

describe('An endpoint declared as a value', () => {
    it('is called at its group and action, by name and through the group', async () => {
        const app = createApp();
        const lambder = app.registerApiGroups(app.defineApiGroup('greetings', {
            hello: app.defineApi({ input: z.object({ name: z.string() }), output: z.object({ text: z.string() }), guards: 'anyone' },
                async (ctx) => ({ text: `hello ${ctx.apiPayload.name}` })),
        }));
        const visitor = lambderTestApp(lambder).visitor();

        expect(await visitor.api('greetings.hello', { name: 'Ada' })).toEqual({ text: 'hello Ada' });
        expect(await visitor.greetings.hello({ name: 'Ada' })).toEqual({ text: 'hello Ada' });
        const outcome = await visitor.greetings.hello.outcome({ name: 'Ada' });
        assertApiSuccess(outcome);
        expect(outcome.payload.text).toBe('hello Ada');
    });

    it('is a session endpoint exactly when one of its guards needs a session', async () => {
        const app = createApp();
        const lambder = app.registerApiGroups(app.defineApiGroup('account', {
            whoAmI: app.defineApi({ input: z.object({}), output: z.object({ userId: z.string() }), guards: 'signedIn' },
                async (ctx) => {
                    // The session guard makes the session present, in the types as at runtime.
                    expectTypeOf(ctx.session.data).toEqualTypeOf<Session>();
                    return { userId: ctx.session.data.userId };
                }),
            status: app.defineApi({ input: z.object({}), output: z.object({ open: z.boolean() }), guards: 'anyone' },
                async (ctx) => {
                    expectTypeOf(ctx.session).toEqualTypeOf<typeof ctx.session>();
                    return { open: ctx.session === null };
                }),
        }));
        const testApp = lambderTestApp(lambder);

        assertApiFailure(await testApp.visitor().account.whoAmI.outcome({}), 'sessionExpired');
        expect(await testApp.visitor().account.status({})).toEqual({ open: true });
        const signedIn = await testApp.signIn('u1', { userId: 'u1' });
        expect(await signedIn.account.whoAmI({})).toEqual({ userId: 'u1' });

        expect((await lambder.apiOptionEntries()).apis).toMatchObject({
            'account.whoAmI': { mode: 'session' },
            'account.status': { mode: 'public' },
        });
    });

    it('answers a call on the path callers posted to before endpoints had paths with versionExpired', async () => {
        const app = createApp();
        const lambder = app.registerApiGroups(app.defineApiGroup('greetings', {
            hello: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})),
        }));
        const response = await lambder.render(createMockEvent('/api', {
            httpMethod: 'POST',
            headers: { Host: 'localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiName: 'greetings.hello', payload: {} }),
        }), createMockContext());
        expect(JSON.parse(String(response.body))).toMatchObject({ payload: null, versionExpired: true });
    });
});

describe('A lazy group', () => {
    const lazyApp = () => {
        const app = createApp();
        let loads = 0;
        const reportApis = app.defineApiGroup('reports', {
            daily: app.defineApi({ input: z.object({}), output: z.object({ count: z.number() }), guards: 'anyone' }, async () => ({ count: 3 })),
        });
        const lambder = app.registerApiGroups(app.lazyApiGroup('reports', async () => { loads += 1; return reportApis; }));
        return { lambder, loads: () => loads };
    };

    it('is loaded on the first call to one of its endpoints, once', async () => {
        const { lambder, loads } = lazyApp();
        const visitor = lambderTestApp(lambder).visitor();
        expect(loads()).toBe(0);
        const [first, second] = await Promise.all([visitor.reports.daily({}), visitor.reports.daily({})]);
        expect(first).toEqual({ count: 3 });
        expect(second).toEqual({ count: 3 });
        expect(loads()).toBe(1);
    });

    it('is loaded by loadApiGroups, and its endpoints are signed with the rest', async () => {
        const { lambder, loads } = lazyApp();
        const entries = await lambder.apiSignatureEntries();
        expect(loads()).toBe(1);
        expect(entries.map((entry) => entry.name)).toEqual(['reports.daily']);
    });

    it('keeps the loaded group\'s type where a list of groups is expected, as a module declaration does', async () => {
        const app = createApp();
        const reportApis = app.defineApiGroup('reports', {
            daily: app.defineApi({ input: z.object({}), output: z.object({ count: z.number() }), guards: 'anyone' }, async () => ({ count: 3 })),
        });
        const loaded = Promise.resolve({ reportApis });
        // The loader's callback is contextually typed, so the expected
        // LambderLazyApiGroup<string, any> is what the group would be read
        // off, were the loader not the only place it is read from.
        const declaration = {
            apiGroups: [app.lazyApiGroup('reports', () => loaded.then((m) => m.reportApis))] as const,
        } satisfies { apiGroups: readonly LambderRegistrableApiGroup[] };
        const lambder = app.registerApiGroups(...declaration.apiGroups);
        expectTypeOf<keyof typeof lambder.ApiContract>().toEqualTypeOf<'reports.daily'>();
        const daily = await lambderTestApp(lambder).visitor().reports.daily({});
        expectTypeOf(daily).toEqualTypeOf<{ count: number }>();
        expect(daily).toEqual({ count: 3 });
    });

    it('forgets a load that failed, so the next one tries again', async () => {
        const app = createApp();
        const reportApis = app.defineApiGroup('reports', {
            daily: app.defineApi({ input: z.object({}), output: z.object({ count: z.number() }), guards: 'anyone' }, async () => ({ count: 3 })),
        });
        let attempts = 0;
        const lambder = app.registerApiGroups(app.lazyApiGroup('reports', async () => {
            attempts += 1;
            if(attempts === 1) throw new Error('the import failed');
            return reportApis;
        }));
        await expect(lambder.loadApiGroups()).rejects.toThrow('the import failed');
        expect(await lambderTestApp(lambder).visitor().reports.daily({})).toEqual({ count: 3 });
        expect(attempts).toBe(2);
    });

    it('checks a refusal a hook throws before the group loaded against the endpoint called, as an eager group\'s', async () => {
        const init = initLambder<Session>().declareRefusals({ maintenance: {} });
        const app = init.create({ apiPath: '/api', guards: { anyone: init.guard({ handler: async () => {} }) } });
        const reportApis = app.defineApiGroup('reports', {
            daily: app.defineApi({ input: z.object({}), output: z.object({ count: z.number() }), guards: 'anyone', refusals: 'maintenance' }, async () => ({ count: 3 })),
        });
        // The hook refuses every call, so no call ever reaches the group to
        // load it: the refusal's code is checked against the endpoint anyway.
        const lambder = app
            .addHook('beforeRender', async (ctx) => {
                if(ctx.api) init.refuse('Down for maintenance.', { code: 'maintenance' });
                return ctx;
            })
            .registerApiGroups(app.lazyApiGroup('reports', async () => reportApis));
        assertApiFailure(await lambderTestApp(lambder).visitor().reports.daily.outcome({}), 'refusal', { code: 'maintenance' });
    });

    it('counts a per-API budget a hook charges against the endpoint called, before the group loaded as after', async () => {
        const app = initLambder<Session>().create({
            apiPath: '/api',
            rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { oncePerApi: { perMin: 1, per: 'ip' } } },
            guards: { anyone: initLambder<Session>().guard({ handler: async () => {} }) },
        });
        const reportApis = app.defineApiGroup('reports', {
            daily: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})),
            weekly: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})),
        });
        const lambder = app
            .addHook('beforeRender', async (ctx) => {
                if(ctx.api) await ctx.rateLimit('oncePerApi');
                return ctx;
            })
            .registerApiGroups(app.lazyApiGroup('reports', async () => reportApis));
        const visitor = lambderTestApp(lambder).visitor();
        assertApiSuccess(await visitor.reports.daily.outcome({}));
        assertApiSuccess(await visitor.reports.weekly.outcome({}));
        // The first call, made before the group loaded, counted as reports.daily's.
        assertApiFailure(await visitor.reports.daily.outcome({}), 'refusal', { code: LAMBDER_REFUSAL_CODES.rateLimited });
    });

    it('refuses to load a group of another name', async () => {
        const app = createApp();
        const other = app.defineApiGroup('other', {
            ping: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})),
        });
        // A loader typed any is refused at compile time; loading checks the name again.
        // @ts-expect-error what the lazy group loads is typed any
        const lambder = app.registerApiGroups(app.lazyApiGroup('reports', async () => other as any));
        await expect(lambder.loadApiGroups()).rejects.toThrow(/lazy group "reports" loaded the group "other"/);
    });
});

describe('Where registered groups stand among routes', () => {
    const call = (lambder: { render: (event: never, context: never) => Promise<{ body?: unknown }> }, apiName: string) =>
        lambder.render(createApiEvent({ apiName, payload: {} }) as never, createMockContext() as never)
            .then((response) => JSON.parse(String(response.body)));
    const pingApis = (app: ReturnType<typeof createApp>) => app.defineApiGroup('ping', {
        pong: app.defineApi({ input: z.object({}), output: z.object({ from: z.string() }), guards: 'anyone' }, async () => ({ from: 'api' })),
    });

    it('lets a route registered before them see their calls first, and one registered after them never', async () => {
        const app = createApp();
        const earlier = app
            .addRoute((ctx) => ctx.path.endsWith('/pong'), (_ctx, res) => res.json({ from: 'route' }))
            .registerApiGroups(pingApis(app));
        expect(await call(earlier, 'ping.pong')).toEqual({ from: 'route' });

        const later = createApp();
        const registeredFirst = later.registerApiGroups(pingApis(later))
            .addRoute((ctx) => ctx.path.endsWith('/pong'), (_ctx, res) => res.json({ from: 'route' }));
        expect(await call(registeredFirst, 'ping.pong')).toMatchObject({ payload: { from: 'api' } });
    });

    it('runs the beforeRender hooks before a lazy group loads, so a hook that answers the call spares the import', async () => {
        const app = createApp();
        let loads = 0;
        const group = pingApis(app);
        const lambder = app
            .addHook('beforeRender', async (ctx, res) => {
                if(ctx.get.blocked) res.die.status404(html`Not found`);
                return ctx;
            })
            .registerApiGroups(app.lazyApiGroup('ping', async () => { loads += 1; return group; }));
        const blocked = await lambder.render(createApiEvent({ apiName: 'ping.pong', payload: {} }, { queryStringParameters: { blocked: '1' } }), createMockContext());
        expect(blocked.statusCode).toBe(404);
        expect(loads).toBe(0);
        expect(await call(lambder, 'ping.pong')).toMatchObject({ payload: { from: 'api' } });
        expect(loads).toBe(1);
    });

    it('answers what is under apiPath as the API, and leaves the site to a root apiPath', async () => {
        const fallback: LambderFallbackHandler = (ctx, res) => res.text(`page ${ctx.path}`);
        const nested = createApp().setRouteFallbackHandler(fallback);
        const underApi = await nested.render(createMockEvent('/api/ping/pong'), createMockContext());
        expect(JSON.parse(String(underApi.body))).toMatchObject({ refusal: { code: LAMBDER_REFUSAL_CODES.apiNotFound } });
        expect((await nested.render(createMockEvent('/about/team'), createMockContext())).body).toBe('page /about/team');

        // A root apiPath shares every path with the site: only its calls are the API's.
        const rootApp = initLambder<Session>().create({ apiPath: '/', guards: { anyone: initLambder<Session>().guard({ handler: async () => {} }) } });
        const root = rootApp
            .registerApiGroups(rootApp.defineApiGroup('ping', {
                pong: rootApp.defineApi({ input: z.object({}), output: z.object({ from: z.string() }), guards: 'anyone' }, async () => ({ from: 'api' })),
            }))
            .setRouteFallbackHandler(fallback);
        expect((await root.render(createMockEvent('/about/team'), createMockContext())).body).toBe('page /about/team');
        // The site root too: under a root apiPath it is the site's home page.
        expect((await root.render(createMockEvent('/'), createMockContext())).body).toBe('page /');
        // And under a nested one, apiPath itself is still the API's.
        const atApiPath = await nested.render(createMockEvent('/api'), createMockContext());
        expect(JSON.parse(String(atApiPath.body))).toMatchObject({ refusal: { code: LAMBDER_REFUSAL_CODES.apiNotFound } });
        const call = await root.render(createMockEvent('/ping/pong', {
            httpMethod: 'POST', body: JSON.stringify({ payload: {} }), headers: { Host: 'localhost', 'Content-Type': 'application/json' },
        }), createMockContext());
        expect(JSON.parse(String(call.body))).toMatchObject({ payload: { from: 'api' } });
    });

    it('answers an action its group does not have as an unknown API, after the fallback hooks', async () => {
        const app = createApp();
        const fallbacks: string[] = [];
        const lambder = app
            .addHook('fallback', async (ctx) => { fallbacks.push(ctx.path); })
            .registerApiGroups(pingApis(app));
        expect(await call(lambder, 'ping.missing')).toMatchObject({ payload: null, refusal: { code: LAMBDER_REFUSAL_CODES.apiNotFound } });
        expect(fallbacks).toEqual(['/api/ping/missing']);
    });
});

describe('What registration refuses', () => {
    it('refuses a group name a caller already answers for, and an action name a function does', () => {
        const app = createApp();
        const ping = app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({}));
        // @ts-expect-error a caller has a member named api
        expect(() => app.defineApiGroup('api', { ping })).toThrow(/cannot name a group/);
        // @ts-expect-error then would make every caller look like a promise
        expect(() => app.defineApiGroup('then', { ping })).toThrow(/cannot name a group/);
        // @ts-expect-error a function has a member named call
        expect(() => app.defineApiGroup('tools', { call: ping })).toThrow(/cannot name an endpoint/);
        expect(() => app.defineApiGroup('two-words', { ping })).toThrow(/cannot name a group/);
    });

    it('refuses a group registered twice, at compile time and at startup', () => {
        const app = createApp();
        const first = app.defineApiGroup('tools', { ping: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})) });
        const second = app.defineApiGroup('tools', { pong: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})) });
        // @ts-expect-error two groups of one name
        expect(() => app.registerApiGroups(first, second)).toThrow(/group "tools" is registered twice/);
    });

    it('leaves the instance as it was when it refuses a registration, so the fixed call goes through', async () => {
        const app = createApp();
        const tools = app.defineApiGroup('tools', { ping: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})) });
        const reports = app.defineApiGroup('reports', {
            // @ts-expect-error a public call carries no session to count against
            daily: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone', rateLimit: 'perSession' }, async () => ({})),
        });
        expect(() => app.registerApiGroups(tools, reports)).toThrow(/counts per session/);

        const fixed = app.defineApiGroup('reports', {
            daily: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'signedIn', rateLimit: 'perSession' }, async () => ({})),
        });
        const lambder = app.registerApiGroups(tools, fixed);
        expect((await lambder.apiSignatureEntries()).map((entry) => entry.name).sort()).toEqual(['reports.daily', 'tools.ping']);
    });

    it('refuses a group typed any at compile time', () => {
        const app = createApp();
        const untyped: any = app.defineApiGroup('tools', { ping: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})) });
        // @ts-expect-error its endpoints would be any to every client
        app.registerApiGroups(untyped);
        const lazyApp = createApp();
        // @ts-expect-error so would a lazy group's, loading it
        lazyApp.registerApiGroups(lazyApp.lazyApiGroup('tools', async () => untyped));
        const partsApp = createApp();
        const endpoints: any = { ping: partsApp.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})) };
        // @ts-expect-error and a group whose endpoints are typed any
        partsApp.registerApiGroups(partsApp.defineApiGroup('tools', endpoints));
    });

    it('refuses a per-session rate limit on an endpoint none of whose guards needs a session', () => {
        const app = createApp();
        const tools = app.defineApiGroup('tools', {
            // @ts-expect-error a public call carries no session to count against
            ping: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone', rateLimit: 'perSession' }, async () => ({})),
        });
        expect(() => app.registerApiGroups(tools)).toThrow(/counts per session, and none of its guards needs a session/);
    });

    it('requires a guard on every endpoint of an instance created with requireApiGuards', () => {
        const app = initLambder<Session>().create({
            apiPath: '/api',
            requireApiGuards: true,
            guards: { anyone: initLambder<Session>().guard({ handler: async () => {} }) },
        });
        const tools = app.defineApiGroup('tools', {
            // @ts-expect-error guards is required on this instance
            ping: app.defineApi({ input: z.object({}), output: z.object({}) }, async () => ({})),
        });
        expect(() => app.registerApiGroups(tools)).toThrow(/declares no guards, and requireApiGuards is on/);
    });
});

describe('The contract of registered groups', () => {
    it('keys every endpoint by group and action, with its mode', async () => {
        const app = createApp();
        const lambder = app.registerApiGroups(
            app.defineApiGroup('account', { whoAmI: app.defineApi({ input: z.object({}), output: z.object({ userId: z.string() }), guards: 'signedIn' }, async (ctx) => ({ userId: ctx.session.data.userId })) }),
            app.defineApiGroup('greetings', { hello: app.defineApi({ input: z.object({ name: z.string() }), output: z.object({ text: z.string() }), guards: 'anyone' }, async () => ({ text: '' })) }),
        );
        type Contract = typeof lambder.ApiContract;
        expectTypeOf<keyof Contract>().toEqualTypeOf<'account.whoAmI' | 'greetings.hello'>();
        expectTypeOf<Contract['account.whoAmI']['mode']>().toEqualTypeOf<'session'>();
        expectTypeOf<Contract['greetings.hello']['mode']>().toEqualTypeOf<'public'>();
        expectTypeOf<Contract['greetings.hello']['input']>().toEqualTypeOf<{ name: string }>();
        // The same modes, as the options the server reports.
        expect((await lambder.apiOptionEntries()).apis).toEqual({
            'account.whoAmI': { mode: 'session', guards: 'signedIn' },
            'greetings.hello': { mode: 'public', guards: 'anyone' },
        });
    });
});

describe('Names and paths', () => {
    it('writes a call path and reads it back', () => {
        expect(apiCallPath('/api', 'orders.place')).toBe('/api/orders/place');
        expect(apiCallPath('https://example.com/api/', 'orders.place')).toBe('https://example.com/api/orders/place');
        expect(apiNameOfCallPath('/api', '/api/orders/place')).toBe('orders.place');
        expect(apiNameOfCallPath('/api', '/api/orders/place/extra')).toBeNull();
        expect(apiNameOfCallPath('/api', '/api/orders')).toBeNull();
        expect(apiNameOfCallPath('/api', '/apiary/orders/place')).toBeNull();
        expect(() => apiCallPath('/api', 'place')).toThrow(/not an endpoint name/);
    });

    it('reserves every public member of the three callers, so no group can shadow one', () => {
        const app = createApp();
        const lambder = app.registerApiGroups(app.defineApiGroup('tools', { ping: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({})) }));
        const membersOf = (instance: object): string[] => {
            const names = new Set(Object.getOwnPropertyNames(instance));
            for(let prototype = Object.getPrototypeOf(instance); prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)){
                for(const name of Object.getOwnPropertyNames(prototype)) names.add(name);
            }
            return [...names];
        };
        const members = new Set([
            new LambderCaller({ apiPath: '/api' }),
            new LambderInvokeCaller({ functionName: 'callee', transport: async () => ({ result: {} }) as never }),
            lambderTestApp(lambder).visitor(),
        ].flatMap(membersOf).filter((name) => name !== 'constructor'));
        // Both ways: a member missing from the list could be shadowed by a
        // group, and a name on the list no caller has would refuse a group
        // for nothing.
        expect([...members].sort()).toEqual([...LAMBDER_CALLER_MEMBER_NAMES].sort());
        for(const name of members) expect(LAMBDER_RESERVED_GROUP_NAMES).toContain(name);
        // In the types too, where a member added to a caller and left off the
        // list is a compile error rather than a group it shadows. By name
        // alone: a symbol-keyed member can never be read as a group.
        expectTypeOf<typeof LAMBDER_CALLER_MEMBER_NAMES[number]>()
            .toEqualTypeOf<Extract<keyof LambderCaller<{}> | keyof LambderInvokeCaller<{}> | keyof LambderTestVisitor<{}>, string>>();
    });

    it('lets a group take a name the callers use for their own state, which is #private', async () => {
        const app = createApp();
        const lambder = app.registerApiGroups(app.defineApiGroup('transport', {
            status: app.defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'anyone' }, async () => ({ ok: true })),
        }));
        const visitor = lambderTestApp(lambder).visitor();
        expect(await visitor.transport.status({})).toEqual({ ok: true });
        expect(await visitor.caller.transport.status({})).toEqual({ ok: true });
        // A method runs on the caller itself, and one that hands the caller
        // back hands back its groups with it.
        const caller = new LambderCaller<typeof lambder.ApiContract>({ apiPath: '/api' });
        const replaced = caller.setTransport(async () => ({ status: 200, body: {} }) as never);
        expect(replaced).toBe(caller);
        expect(typeof replaced.transport.status).toBe('function');
        expect(caller.api).toBe(caller.api);
    });

    it('keeps an ordinary object\'s members on a group, so turning one into a string calls nothing', async () => {
        const sent: string[] = [];
        const caller = new LambderCaller<{ 'orders.place': { input: {}; output: {}; mode: 'public' } }>({
            apiPath: '/api',
            transport: async (request) => { sent.push(request.apiName); return { status: 200, body: { payload: {} } } as never; },
        });
        expect(`${caller.orders}`).toBe('[object Object]');
        expect(caller.orders.hasOwnProperty).toBe(Object.prototype.hasOwnProperty);
        expect(caller.orders.constructor).toBe(Object);
        expect(sent).toEqual([]);
        await caller.orders.place({});
        expect(sent).toEqual(['orders.place']);
        // A group is read-only, as its type is.
        expect(() => { (caller.orders as Record<string, unknown>).place = 1; }).toThrow(TypeError);

        // So no action may take one of those names: it could never be called through its group.
        const app = createApp();
        const ping = app.defineApi({ input: z.object({}), output: z.object({}), guards: 'anyone' }, async () => ({}));
        // @ts-expect-error every object already has a toString
        expect(() => app.defineApiGroup('tools', { toString: ping })).toThrow(/cannot name an endpoint/);
    });
});

describe('A group declared across files', () => {
    it('is assembled from each file\'s part, and refuses an action two parts declare', async () => {
        const app = createApp();
        const reads = { list: app.defineApi({ input: z.object({}), output: z.object({ ids: z.array(z.string()) }), guards: 'anyone' }, async () => ({ ids: ['a'] })) };
        const writes = { place: app.defineApi({ input: z.object({ id: z.string() }), output: z.object({ placed: z.boolean() }), guards: 'anyone' }, async () => ({ placed: true })) };
        const lambder = app.registerApiGroups(app.defineApiGroup('orders', reads, writes));
        expectTypeOf<keyof typeof lambder.ApiContract>().toEqualTypeOf<'orders.list' | 'orders.place'>();
        const visitor = lambderTestApp(lambder).visitor();
        expect(await visitor.orders.list({})).toEqual({ ids: ['a'] });
        expect(await visitor.orders.place({ id: 'x' })).toEqual({ placed: true });

        const again = { list: reads.list };
        // @ts-expect-error list is declared by two parts
        expect(() => app.defineApiGroup('orders', reads, again)).toThrow(/"orders.list" is declared by two parts of group "orders"/);
    });
});

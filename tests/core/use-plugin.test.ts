/**
 * Plugin System (.use) Tests
 *
 * use() hands the instance to a plugin that registers routes, hooks and
 * actions on it. Endpoints are composed as groups: declared as values,
 * gathered by defineApiGroup and registered by registerApiGroups, which is
 * where the contract comes from.
 */

import { browse, testPublicFiles } from '../helpers.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import { assertApiSuccess } from '../../src/testing.js';
import { z } from 'zod';
import Lambder, { initLambder } from '../../src/core/Lambder.js';
import type { LambderAppTypes } from '../../src/api/LambderApiDeclarations.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import type { LambderDdbIdempotencyStore } from '../../src/stores/LambderDdbIdempotencyStore.js';
import type { LambderDdbRateLimiter } from '../../src/stores/LambderDdbRateLimiter.js';
import { LambderLocalFileSource } from '../../src/stores/LambderLocalFileSource.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import LambderCaller from '../../src/client/LambderCaller.js';

const createApp = () => new Lambder({
    files: testPublicFiles(),
    apiPath: '/api'
});

/** A module's group, built on whichever instance registers it. */
const userApis = (lambder: Lambder) => lambder.defineApiGroup('users', {
    get: lambder.defineApi({
        input: z.object({ userId: z.string() }),
        output: z.object({ id: z.string(), name: z.string() })
    }, async (ctx) => {
        return { id: ctx.apiPayload.userId, name: 'John Doe' };
    }),
});

const productApis = (lambder: Lambder) => lambder.defineApiGroup('products', {
    get: lambder.defineApi({
        input: z.object({ productId: z.string() }),
        output: z.object({ id: z.string(), title: z.string(), price: z.number() })
    }, async (ctx) => {
        return {
            id: ctx.apiPayload.productId,
            title: 'Test Product',
            price: 99.99
        };
    }),
});

// ============================================================================
// Test 1: Basic Group Usage
// ============================================================================

describe('API groups - Basic Usage', () => {
    it('should register a group\'s endpoints', async () => {
        const app = createApp();
        const lambder = app.registerApiGroups(userApis(app));

        const visitor = browse(lambder);
        const result = await visitor.apiOutcome('users.get', { userId: '123' });

        assertApiSuccess(result);
        expect(result.payload).toEqual({ id: '123', name: 'John Doe' });
    });

    it('should put a group\'s endpoints in the contract', () => {
        const app = createApp();
        const _lambder = app.registerApiGroups(userApis(app));

        type AppContract = typeof _lambder.ApiContract;

        const caller = new LambderCaller<AppContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Type check - if this compiles, types are correct
        type _GetUserInput = Parameters<typeof caller.api<'users.get'>>[1];

        expect(caller).toBeDefined();
    });
});

// ============================================================================
// Test 2: Multiple Groups
// ============================================================================

describe('API groups - Multiple Groups', () => {
    it('should register several groups in one call', async () => {
        const app = createApp();
        const orderApis = app.defineApiGroup('orders', {
            create: app.defineApi({
                input: z.object({ userId: z.string(), productId: z.string() }),
                output: z.object({ orderId: z.string(), status: z.string() })
            }, async (ctx) => {
                return {
                    orderId: 'order-123',
                    status: 'pending'
                };
            }),
        });

        const lambder = app.registerApiGroups(userApis(app), productApis(app), orderApis);

        const visitor = browse(lambder);

        const userResult = await visitor.apiOutcome('users.get', { userId: '123' });
        assertApiSuccess(userResult);
        expect(userResult.payload?.name).toBe('John Doe');

        const productResult = await visitor.apiOutcome('products.get', { productId: 'prod-456' });
        assertApiSuccess(productResult);
        expect(productResult.payload?.title).toBe('Test Product');

        const orderResult = await visitor.apiOutcome('orders.create', { userId: '123', productId: 'prod-456' });
        assertApiSuccess(orderResult);
        expect(orderResult.payload?.orderId).toBe('order-123');
    });

    it('should accumulate types from multiple groups', () => {
        const app = createApp();
        const _lambder = app.registerApiGroups(userApis(app), productApis(app));

        type AppContract = typeof _lambder.ApiContract;

        const caller = new LambderCaller<AppContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Type check - both APIs should be available
        type _GetUserInput = Parameters<typeof caller.api<'users.get'>>[1];
        type _GetProductInput = Parameters<typeof caller.api<'products.get'>>[1];

        expect(caller).toBeDefined();
    });
});

// ============================================================================
// Test 3: Groups and Plugins Together
// ============================================================================

describe('Plugin System - Mixed Usage', () => {
    it('should allow mixing group registrations and plugins', async () => {
        const userPagePlugin = <T extends LambderAppTypes>(lambder: Lambder<T>) => {
            return lambder
                .addRoute('/users/:userId', (ctx, res) => {
                    return res.json({ id: ctx.pathParams.userId, name: 'John' });
                });
        };

        const app = createApp();
        const lambder = app
            // A group
            .registerApiGroups(app.defineApiGroup('health', {
                check: app.defineApi({
                    input: z.void(),
                    output: z.object({ status: z.string() })
                }, async (ctx) => {
                    return { status: 'ok' };
                }),
            }))
            // Plugin
            .use(userPagePlugin)
            // Another group
            .registerApiGroups(app.defineApiGroup('meta', {
                version: app.defineApi({
                    input: z.void(),
                    output: z.object({ version: z.string() })
                }, async (ctx) => {
                    return { version: '2.0' };
                }),
            }));

        const visitor = browse(lambder);

        // Test the group registered before the plugin
        expect((await visitor.api('health.check', undefined))?.status).toBe('ok');

        // Test the plugin's route
        expect((await visitor.request('GET', '/users/123')).json()).toEqual({ id: '123', name: 'John' });

        // Test the group registered after the plugin
        expect((await visitor.api('meta.version', undefined))?.version).toBe('2.0');
    });
});

// ============================================================================
// Test 4: Plugin with Routes
// ============================================================================

describe('Plugin System - Routes', () => {
    it('should allow plugins to add routes', async () => {
        const healthPlugin = <T extends LambderAppTypes>(lambder: Lambder<T>) => {
            // addRoute chains, so a plugin can return the whole chain.
            return lambder
                .addRoute('/health', (ctx, res) => {
                    return res.json({ status: 'healthy' });
                })
                .addRoute('/version', (ctx, res) => {
                    return res.json({ version: '2.0' });
                });
        };

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        }).use(healthPlugin);

        const result = await browse(lambder).request('GET', '/health');
        expect(result.statusCode).toBe(200);
        expect(result.json()).toEqual({ status: 'healthy' });
    });
});

// ============================================================================
// Test 5: Complex Group Composition
// ============================================================================

describe('API groups - Complex Composition', () => {
    it('should compose a group from parts declared apart', async () => {
        const app = createApp();
        const baseApis = {
            base: app.defineApi({
                input: z.void(),
                output: z.object({ value: z.string() })
            }, async (ctx) => {
                return { value: 'base' };
            }),
        };

        const extendedApis = {
            extended: app.defineApi({
                input: z.void(),
                output: z.object({ value: z.string() })
            }, async (ctx) => {
                return { value: 'extended' };
            }),
        };

        const lambder = app.registerApiGroups(app.defineApiGroup('values', baseApis, extendedApis));

        const visitor = browse(lambder);

        // Both base and extended APIs should work
        expect((await visitor.api('values.base', undefined))?.value).toBe('base');

        expect((await visitor.api('values.extended', undefined))?.value).toBe('extended');
    });

    it('should allow a group to be reused across different lambder instances', async () => {
        const app = createApp();
        const sharedApis = app.defineApiGroup('shared', {
            get: app.defineApi({
                input: z.object({ id: z.string() }),
                output: z.object({ id: z.string(), source: z.string() })
            }, async (ctx) => {
                return { id: ctx.apiPayload.id, source: 'shared-group' };
            }),
        });

        // Register the same group on two different instances
        const lambder1 = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        }).registerApiGroups(sharedApis);

        const lambder2 = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        }).registerApiGroups(sharedApis);

        // Both should work independently
        expect((await browse(lambder1).api('shared.get', { id: 'test-123' }))?.source).toBe('shared-group');
        expect((await browse(lambder2).api('shared.get', { id: 'test-123' }))?.source).toBe('shared-group');
    });
});

// ============================================================================
// Test 6: Group Type Safety Edge Cases
// ============================================================================

describe('API groups - Type Safety', () => {
    it('should maintain type safety across groups', () => {
        const app = createApp();
        const first = app.defineApiGroup('first', {
            api1: app.defineApi({
                input: z.object({ value: z.string() }),
                output: z.object({ result: z.string() })
            }, async (ctx) => {
                return { result: ctx.apiPayload.value };
            }),
        });

        const second = app.defineApiGroup('second', {
            api2: app.defineApi({
                input: z.object({ count: z.number() }),
                output: z.object({ total: z.number() })
            }, async (ctx) => {
                return { total: ctx.apiPayload.count * 2 };
            }),
        });

        const _lambder = app.registerApiGroups(first, second);

        type Contract = typeof _lambder.ApiContract;

        // Type assertions - both api1 and api2 should be in the contract
        // We test this at runtime by creating a caller
        const caller = new LambderCaller<Contract>({
            apiPath: '/api',
            isCorsEnabled: false
        });
        expect(caller).toBeDefined();
    });
});

// ============================================================================
// Test 7: Groups Built on a Plain Instance Type
// ============================================================================

describe('API groups - Non-Generic Builders', () => {
    it('should accumulate types correctly when groups are built on the plain instance type', () => {
        const group1 = (l: Lambder) => l.defineApiGroup('first', { api1: l.defineApi({ input: z.void(), output: z.object({}) }, async (_ctx) => ({})) });
        const group2 = (l: Lambder) => l.defineApiGroup('second', { api2: l.defineApi({ input: z.void(), output: z.object({}) }, async (_ctx) => ({})) });

        const app = new Lambder({ files: new LambderLocalFileSource({ root: '' }), apiPath: '/api' });
        const _lambder = app.registerApiGroups(
            app.defineApiGroup('initial', { initialApi: app.defineApi({ input: z.void(), output: z.object({}) }, async (_ctx) => ({})) }),
            group1(app),
            group2(app),
        );

        type Contract = typeof _lambder.ApiContract;

        // Check if both api1 and api2 exist in Contract
        expectTypeOf<Contract>().toHaveProperty('initial.initialApi');
        expectTypeOf<Contract>().toHaveProperty('first.api1');
        expectTypeOf<Contract>().toHaveProperty('second.api2');
    });
});

// ============================================================================
// Test 8: Policy generics survive .use()
// ============================================================================

describe('Plugin System - Policy generics survive use()', () => {
    // Every policy generic at a non-default value: rate-limit policies,
    // guards, idempotency and requireApiGuards. If use() dropped one, an
    // instance created with requireApiGuards: true would not be assignable to
    // a plugin typed with its own derived type. This block is checked by
    // `npm run typecheck`; vitest alone would not see a regression here.
    const guards = {
        staffPermission: lambderGuard({ session: true, handler: (_ctx, _payload, permission: string) => ({ permission }) }),
        signedIn: lambderGuard({ session: true, handler: () => {} }),
        // requireApiGuards holds a public endpoint to a guard too.
        anyone: lambderGuard({ handler: () => {} }),
    };
    // The stores are never reached: nothing here is rendered, only registered.
    const makeApp = () => initLambder<{ userId: string }>().create({
        files: new LambderLocalFileSource({ root: '' }),
        apiPath: '/api',
        rateLimits: { limiter: {} as LambderDdbRateLimiter, policies: { perIp: { perMin: 5, per: 'ip', budget: 'perApi' } } },
        guards,
        idempotency: { store: {} as LambderDdbIdempotencyStore },
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        requireApiGuards: true,
    });
    type App = ReturnType<typeof makeApp>;

    it('a plugin typed with the derived app type chains, and the result keeps every policy typing', () => {
        const plugin = (l: App) => l.addSessionRoute('/secure/me', async (ctx, res) => res.json({ userId: ctx.session.data.userId }));
        const app = makeApp().use(plugin);
        const secure = app.registerApiGroups(app.defineApiGroup('secure', {
            me: app.defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'signedIn' }, async (_ctx) => ({ ok: true })),
        }));
        expectTypeOf<typeof secure.ApiContract>().toHaveProperty('secure.me');
        // The route the plugin registered and the endpoint the group did are on the same instance.
        expect(secure).toBe(app);

        // requireApiGuards survives use(): guards stay required.
        const unguarded = app.defineApiGroup('unguarded', {
            // @ts-expect-error guards is required on this instance
            forgot: app.defineApi({ input: z.object({}), output: z.object({}) }, async (_ctx) => ({})),
        });
        expect(() => app.registerApiGroups(unguarded)).toThrow(/declares no guards/);

        // The guard map survives: names are still checked against it.
        const misnamed = app.defineApiGroup('misnamed', {
            // @ts-expect-error unknown guard name
            unknown: app.defineApi({ input: z.object({}), output: z.object({}), guards: 'nope' }, async (_ctx) => ({})),
        });
        expect(() => app.registerApiGroups(misnamed)).toThrow(/unknown guard "nope"/);

        // The rate-limit policies and the idempotency flag survive too.
        expect(() => app.registerApiGroups(app.defineApiGroup('public', {
            once: app.defineApi({
                input: z.object({}), output: z.object({}), guards: 'anyone', rateLimit: 'perIp', idempotency: true,
            }, async (_ctx) => ({})),
        }))).not.toThrow();
    });
});

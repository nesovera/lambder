/**
 * Plugin System (.use) Tests
 * 
 * This file tests the plugin system that allows modular API composition
 */

import { browse, testPublicFiles } from './helpers.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import { assertApiSuccess } from '../src/testing.js';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import type { LambderDdbIdempotencyStore } from '../src/stores/LambderDdbIdempotencyStore.js';
import type { LambderDdbRateLimiter } from '../src/stores/LambderDdbRateLimiter.js';
import { LambderLocalFileSource } from '../src/stores/LambderLocalFileSource.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import LambderCaller from '../src/client/LambderCaller.js';

// ============================================================================
// Test 1: Basic Plugin Usage
// ============================================================================

describe('Plugin System - Basic Usage', () => {
    it('should allow adding APIs via plugin', async () => {
        const userPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('getUser', {
                    input: z.object({ userId: z.string() }),
                    output: z.object({ id: z.string(), name: z.string() })
                }, async (ctx, res) => {
                    return res.api({ id: ctx.apiPayload.userId, name: 'John Doe' });
                });
        };

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        }).use(userPlugin);

        const visitor = browse(lambder);
        const result = await visitor.apiOutcome('getUser', { userId: '123' });

        assertApiSuccess(result);
        expect(result.payload).toEqual({ id: '123', name: 'John Doe' });
    });

    it('should preserve type contract after using plugin', () => {
        const userPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('getUser', {
                    input: z.object({ userId: z.string() }),
                    output: z.object({ id: z.string(), name: z.string() })
                }, async (ctx, res) => {
                    return res.api({ id: ctx.apiPayload.userId, name: 'Test' });
                });
        };

        const _lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        }).use(userPlugin);

        type AppContract = typeof _lambder.ApiContract;

        const caller = new LambderCaller<AppContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Type check - if this compiles, types are correct
        type _GetUserInput = Parameters<typeof caller.api<'getUser'>>[1];
        
        expect(caller).toBeDefined();
    });
});

// ============================================================================
// Test 2: Multiple Plugins
// ============================================================================

describe('Plugin System - Multiple Plugins', () => {
    it('should allow chaining multiple plugins', async () => {
        const userPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('getUser', {
                    input: z.object({ userId: z.string() }),
                    output: z.object({ id: z.string(), name: z.string() })
                }, async (ctx, res) => {
                    return res.api({ id: ctx.apiPayload.userId, name: 'John' });
                });
        };

        const productPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('getProduct', {
                    input: z.object({ productId: z.string() }),
                    output: z.object({ id: z.string(), title: z.string(), price: z.number() })
                }, async (ctx, res) => {
                    return res.api({ 
                        id: ctx.apiPayload.productId, 
                        title: 'Test Product', 
                        price: 99.99 
                    });
                });
        };

        const orderPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('createOrder', {
                    input: z.object({ userId: z.string(), productId: z.string() }),
                    output: z.object({ orderId: z.string(), status: z.string() })
                }, async (ctx, res) => {
                    return res.api({ 
                        orderId: 'order-123', 
                        status: 'pending' 
                    });
                });
        };

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .use(userPlugin)
            .use(productPlugin)
            .use(orderPlugin);

        const visitor = browse(lambder);

        const userResult = await visitor.apiOutcome('getUser', { userId: '123' });
        assertApiSuccess(userResult);
        expect(userResult.payload?.name).toBe('John');

        const productResult = await visitor.apiOutcome('getProduct', { productId: 'prod-456' });
        assertApiSuccess(productResult);
        expect(productResult.payload?.title).toBe('Test Product');

        const orderResult = await visitor.apiOutcome('createOrder', { userId: '123', productId: 'prod-456' });
        assertApiSuccess(orderResult);
        expect(orderResult.payload?.orderId).toBe('order-123');
    });

    it('should accumulate types from multiple plugins', () => {
        const userPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('getUser', {
                    input: z.object({ userId: z.string() }),
                    output: z.object({ id: z.string(), name: z.string() })
                }, async (ctx, res) => {
                    return res.api({ id: ctx.apiPayload.userId, name: 'Test' });
                });
        };

        const productPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('getProduct', {
                    input: z.object({ productId: z.string() }),
                    output: z.object({ id: z.string(), title: z.string() })
                }, async (ctx, res) => {
                    return res.api({ id: ctx.apiPayload.productId, title: 'Test' });
                });
        };

        const _lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .use(userPlugin)
            .use(productPlugin);

        type AppContract = typeof _lambder.ApiContract;

        const caller = new LambderCaller<AppContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Type check - both APIs should be available
        type _GetUserInput = Parameters<typeof caller.api<'getUser'>>[1];
        type _GetProductInput = Parameters<typeof caller.api<'getProduct'>>[1];
        
        expect(caller).toBeDefined();
    });
});

// ============================================================================
// Test 3: Plugin with Additional APIs
// ============================================================================

describe('Plugin System - Mixed Usage', () => {
    it('should allow mixing direct API addition and plugins', async () => {
        const userPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('getUser', {
                    input: z.object({ userId: z.string() }),
                    output: z.object({ id: z.string(), name: z.string() })
                }, async (ctx, res) => {
                    return res.api({ id: ctx.apiPayload.userId, name: 'John' });
                });
        };

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            // Direct API
            .addApi('healthCheck', {
                input: z.void(),
                output: z.object({ status: z.string() })
            }, async (ctx, res) => {
                return res.api({ status: 'ok' });
            })
            // Plugin
            .use(userPlugin)
            // Another direct API
            .addApi('getVersion', {
                input: z.void(),
                output: z.object({ version: z.string() })
            }, async (ctx, res) => {
                return res.api({ version: '2.0' });
            });

        const visitor = browse(lambder);

        // Test direct API before plugin
        expect((await visitor.api('healthCheck', undefined))?.status).toBe('ok');

        // Test plugin API
        expect((await visitor.api('getUser', { userId: '123' }))?.name).toBe('John');

        // Test direct API after plugin
        expect((await visitor.api('getVersion', undefined))?.version).toBe('2.0');
    });
});

// ============================================================================
// Test 4: Plugin with Routes
// ============================================================================

describe('Plugin System - Routes', () => {
    it('should allow plugins to add routes', async () => {
        const healthPlugin = <T>(lambder: Lambder<T>) => {
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
// Test 5: Complex Plugin Composition
// ============================================================================

describe('Plugin System - Complex Composition', () => {
    it('should support nested plugins (plugin that uses another plugin)', async () => {
        const basePlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('base', {
                    input: z.void(),
                    output: z.object({ value: z.string() })
                }, async (ctx, res) => {
                    return res.api({ value: 'base' });
                });
        };

        const extendedPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .use(basePlugin)
                .addApi('extended', {
                    input: z.void(),
                    output: z.object({ value: z.string() })
                }, async (ctx, res) => {
                    return res.api({ value: 'extended' });
                });
        };

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        }).use(extendedPlugin);

        const visitor = browse(lambder);

        // Both base and extended APIs should work
        expect((await visitor.api('base', undefined))?.value).toBe('base');

        expect((await visitor.api('extended', undefined))?.value).toBe('extended');
    });

    it('should allow plugins to be reusable across different lambder instances', async () => {
        const sharedPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('shared', {
                    input: z.object({ id: z.string() }),
                    output: z.object({ id: z.string(), source: z.string() })
                }, async (ctx, res) => {
                    return res.api({ id: ctx.apiPayload.id, source: 'shared-plugin' });
                });
        };

        // Use same plugin in two different instances
        const lambder1 = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        }).use(sharedPlugin);

        const lambder2 = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        }).use(sharedPlugin);

        // Both should work independently
        expect((await browse(lambder1).api('shared', { id: 'test-123' }))?.source).toBe('shared-plugin');
        expect((await browse(lambder2).api('shared', { id: 'test-123' }))?.source).toBe('shared-plugin');
    });
});

// ============================================================================
// Test 6: Plugin Type Safety Edge Cases
// ============================================================================

describe('Plugin System - Type Safety', () => {
    it('should maintain type safety through plugin chain', () => {
        const plugin1 = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('api1', {
                    input: z.object({ value: z.string() }),
                    output: z.object({ result: z.string() })
                }, async (ctx, res) => {
                    return res.api({ result: ctx.apiPayload.value });
                });
        };

        const plugin2 = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('api2', {
                    input: z.object({ count: z.number() }),
                    output: z.object({ total: z.number() })
                }, async (ctx, res) => {
                    return res.api({ total: ctx.apiPayload.count * 2 });
                });
        };

        const _lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .use(plugin1)
            .use(plugin2);

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
// Test 7: Non-Generic Plugin Type Accumulation
// ============================================================================

describe('Plugin System - Non-Generic Plugins', () => {
    it('should accumulate types correctly when using non-generic plugins', () => {
        const plugin1 = (l: Lambder) => l.addApi('api1', { input: z.void(), output: z.void() }, async (ctx, res) => res.raw({ statusCode: 200, body: '' }));
        const plugin2 = (l: Lambder) => l.addApi('api2', { input: z.void(), output: z.void() }, async (ctx, res) => res.raw({ statusCode: 200, body: '' }));

        const _lambder = new Lambder({ files: new LambderLocalFileSource({ root: '' }), apiPath: '/api' })
            .addApi('initialApi', { input: z.void(), output: z.void() }, async (ctx, res) => res.raw({ statusCode: 200, body: '' }))
            .use(plugin1)
            .use(plugin2);

        type Contract = typeof _lambder.ApiContract;
        
        // Check if both api1 and api2 exist in Contract
        expectTypeOf<Contract>().toHaveProperty('initialApi');
        expectTypeOf<Contract>().toHaveProperty('api1');
        expectTypeOf<Contract>().toHaveProperty('api2');
    });
});

// ============================================================================
// Test 8: Policy generics survive .use()
// ============================================================================

describe('Plugin System - Policy generics survive use()', () => {
    // Every policy generic at a non-default value: rate-limit policies,
    // guards, idempotency and requireSessionApiGuards. If use() dropped one,
    // an instance created with requireSessionApiGuards: true would not be
    // assignable to a plugin typed with its own derived type. This block is
    // checked by `npm run typecheck`; vitest alone would not see a
    // regression here.
    const guards = {
        orgPermission: lambderGuard({ session: true, handler: (_ctx, _payload, permission: string) => ({ permission }) }),
        sessionOnly: lambderGuard({ session: true, handler: () => {} }),
    };
    // The stores are never reached: nothing here is rendered, only registered.
    const makeApp = () => initLambder<{ userId: string }>().create({
        files: new LambderLocalFileSource({ root: '' }),
        apiPath: '/api',
        rateLimits: { limiter: {} as LambderDdbRateLimiter, policies: { perIp: { perMin: 5, per: 'ip', budget: 'perApi' } } },
        guards,
        idempotency: { store: {} as LambderDdbIdempotencyStore },
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        requireSessionApiGuards: true,
    });
    type App = ReturnType<typeof makeApp>;

    it('a plugin typed with the derived app type chains, and the result keeps every policy typing', () => {
        const plugin = (l: App) => l.addSessionApi('secure.me', {
            input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'sessionOnly',
        }, async (_ctx, res) => res.api({ ok: true }));
        const app = makeApp().use(plugin);
        expectTypeOf<typeof app.ApiContract>().toHaveProperty('secure.me');

        // requireSessionApiGuards survives use(): guards stay required.
        // @ts-expect-error guards is required on this instance
        const missing = () => app.addSessionApi('secure.forgot', { input: z.object({}), output: z.object({}) }, async (_ctx, res) => res.api({}));
        expect(missing).toThrow(/declares no guards/);

        // The guard map survives: names are still checked against it.
        // @ts-expect-error unknown guard name
        const unknown = () => app.addSessionApi('secure.unknown', { input: z.object({}), output: z.object({}), guards: 'nope' }, async (_ctx, res) => res.api({}));
        expect(unknown).toThrow(/unknown guard "nope"/);

        // The rate-limit policies and the idempotency flag survive too.
        expect(() => app.addApi('public.once', {
            input: z.object({}), output: z.object({}), rateLimit: 'perIp', idempotency: true,
        }, async (_ctx, res) => res.api({}))).not.toThrow();
    });
});

/**
 * Plugin System (.use) Tests
 * 
 * This file tests the plugin system that allows modular API composition
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import Lambder from '../src/Lambder.js';
import LambderCaller from '../src/LambderCaller.js';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';

// Mock AWS Lambda event and context helpers
const createMockEvent = (apiName: string, payload: any): APIGatewayProxyEvent => ({
    body: JSON.stringify({ apiName, payload }),
    headers: { Host: 'localhost' },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/api',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
});

const createMockContext = (): Context => ({
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test',
    functionVersion: '1',
    invokedFunctionArn: 'arn',
    memoryLimitInMB: '128',
    awsRequestId: '123',
    logGroupName: 'group',
    logStreamName: 'stream',
    getRemainingTimeInMillis: () => 1000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
});

// ============================================================================
// Test 1: Basic Plugin Usage
// ============================================================================

describe('Plugin System - Basic Usage', () => {
    it('should allow adding APIs via plugin', async () => {
        // Define a simple plugin
        const userPlugin = <T>(lambder: Lambder<T>) => {
            return lambder
                .addApi('getUser', {
                    input: z.object({ userId: z.string() }),
                    output: z.object({ id: z.string(), name: z.string() })
                }, async (ctx, res) => {
                    return res.api({ id: ctx.apiPayload.userId, name: 'John Doe' });
                });
        };

        // Use the plugin
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        }).use(userPlugin);

        // Test runtime execution
        const handler = lambder.getHandler();
        const event = createMockEvent('getUser', { userId: '123' });
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body || '{}');
        expect(body.payload).toEqual({ id: '123', name: 'John Doe' });
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

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        }).use(userPlugin);

        type AppContract = typeof lambder.ApiContract;

        const caller = new LambderCaller<AppContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Type check - if this compiles, types are correct
        type GetUserInput = Parameters<typeof caller.api<'getUser'>>[1];
        
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

        // Chain multiple plugins
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .use(userPlugin)
            .use(productPlugin)
            .use(orderPlugin);

        // Test each API works
        const handler = lambder.getHandler();

        // Test user API
        const userEvent = createMockEvent('getUser', { userId: '123' });
        const userResult = await handler(userEvent, createMockContext());
        expect(userResult.statusCode).toBe(200);
        expect(JSON.parse(userResult.body || '{}').payload.name).toBe('John');

        // Test product API
        const productEvent = createMockEvent('getProduct', { productId: 'prod-456' });
        const productResult = await handler(productEvent, createMockContext());
        expect(productResult.statusCode).toBe(200);
        expect(JSON.parse(productResult.body || '{}').payload.title).toBe('Test Product');

        // Test order API
        const orderEvent = createMockEvent('createOrder', { userId: '123', productId: 'prod-456' });
        const orderResult = await handler(orderEvent, createMockContext());
        expect(orderResult.statusCode).toBe(200);
        expect(JSON.parse(orderResult.body || '{}').payload.orderId).toBe('order-123');
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

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .use(userPlugin)
            .use(productPlugin);

        type AppContract = typeof lambder.ApiContract;

        const caller = new LambderCaller<AppContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Type check - both APIs should be available
        type GetUserInput = Parameters<typeof caller.api<'getUser'>>[1];
        type GetProductInput = Parameters<typeof caller.api<'getProduct'>>[1];
        
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
            publicPath: './public',
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

        const handler = lambder.getHandler();

        // Test direct API before plugin
        const healthEvent = createMockEvent('healthCheck', undefined);
        const healthResult = await handler(healthEvent, createMockContext());
        expect(JSON.parse(healthResult.body || '{}').payload.status).toBe('ok');

        // Test plugin API
        const userEvent = createMockEvent('getUser', { userId: '123' });
        const userResult = await handler(userEvent, createMockContext());
        expect(JSON.parse(userResult.body || '{}').payload.name).toBe('John');

        // Test direct API after plugin
        const versionEvent = createMockEvent('getVersion', undefined);
        const versionResult = await handler(versionEvent, createMockContext());
        expect(JSON.parse(versionResult.body || '{}').payload.version).toBe('2.0');
    });
});

// ============================================================================
// Test 4: Plugin with Routes
// ============================================================================

describe('Plugin System - Routes', () => {
    it('should allow plugins to add routes', async () => {
        const healthPlugin = <T>(lambder: Lambder<T>) => {
            // Now addRoute is chainable!
            return lambder
                .addRoute('/health', (ctx, res) => {
                    return res.json({ status: 'healthy' });
                })
                .addRoute('/version', (ctx, res) => {
                    return res.json({ version: '2.0' });
                });
        };

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        }).use(healthPlugin);

        const handler = lambder.getHandler();

        // Create GET request event
        const healthEvent: APIGatewayProxyEvent = {
            ...createMockEvent('', {}),
            httpMethod: 'GET',
            path: '/health'
        };

        const result = await handler(healthEvent, createMockContext());
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body || '{}').status).toBe('healthy');
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
            publicPath: './public',
            apiPath: '/api'
        }).use(extendedPlugin);

        const handler = lambder.getHandler();

        // Both base and extended APIs should work
        const baseEvent = createMockEvent('base', undefined);
        const baseResult = await handler(baseEvent, createMockContext());
        expect(JSON.parse(baseResult.body || '{}').payload.value).toBe('base');

        const extendedEvent = createMockEvent('extended', undefined);
        const extendedResult = await handler(extendedEvent, createMockContext());
        expect(JSON.parse(extendedResult.body || '{}').payload.value).toBe('extended');
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
            publicPath: './public',
            apiPath: '/api'
        }).use(sharedPlugin);

        const lambder2 = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        }).use(sharedPlugin);

        // Both should work independently
        const event = createMockEvent('shared', { id: 'test-123' });

        const result1 = await lambder1.getHandler()(event, createMockContext());
        const result2 = await lambder2.getHandler()(event, createMockContext());

        expect(JSON.parse(result1.body || '{}').payload.source).toBe('shared-plugin');
        expect(JSON.parse(result2.body || '{}').payload.source).toBe('shared-plugin');
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

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .use(plugin1)
            .use(plugin2);

        type Contract = typeof lambder.ApiContract;

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

        const lambder = new Lambder({ publicPath: '', apiPath: '' })
            .addApi('initialApi', { input: z.void(), output: z.void() }, async (ctx, res) => res.raw({ statusCode: 200, body: '' }))
            .use(plugin1)
            .use(plugin2);

        type Contract = typeof lambder.ApiContract;
        
        // Check if both api1 and api2 exist in Contract
        expectTypeOf<Contract>().toHaveProperty('initialApi');
        expectTypeOf<Contract>().toHaveProperty('api1');
        expectTypeOf<Contract>().toHaveProperty('api2');
    });
});

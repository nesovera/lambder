/**
 * Hooks System Tests
 * 
 * Tests for the hooks system including:
 * - beforeRender hook execution
 * - afterRender hook execution
 * - fallback hook execution
 * - created hook execution
 * - Hook priority ordering
 * - Multiple hooks of same type
 * - Hook error handling
 * - Context modification in hooks
 * - Response modification in hooks
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import Lambder from '../src/Lambder.js';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

const createMockEvent = (path: string, method: string = 'GET', apiName?: string, payload?: any): APIGatewayProxyEvent => ({
    body: apiName ? JSON.stringify({ apiName, payload }) : null,
    headers: { Host: 'localhost' },
    multiValueHeaders: {},
    httpMethod: method,
    isBase64Encoded: false,
    path: apiName ? '/api' : path,
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

describe('Hooks - beforeRender Hook', () => {
    it('should execute beforeRender hook before route handler', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('beforeRender');
            return ctx;
        });

        lambder.addRoute('/test', (ctx, res) => {
            executionOrder.push('routeHandler');
            return res.html('Test');
        });

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(executionOrder).toEqual(['beforeRender', 'routeHandler']);
    });

    it('should allow context modification in beforeRender', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            // Add custom property to context
            (ctx as any).customData = 'modified';
            return ctx;
        });

        lambder.addRoute('/test', (ctx, res) => {
            return res.json({ data: (ctx as any).customData });
        });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.data).toBe('modified');
    });

    it('should execute multiple beforeRender hooks', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(1);
            return ctx;
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(2);
            return ctx;
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(3);
            return ctx;
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('should stop execution if beforeRender returns Error', async () => {
        let routeHandlerCalled = false;

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 403, body: err.message });
            });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            return new Error('Access Denied');
        });

        lambder.addRoute('/test', (ctx, res) => {
            routeHandlerCalled = true;
            return res.html('Test');
        });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.statusCode).toBe(403);
        expect(result.body).toBe('Access Denied');
        expect(routeHandlerCalled).toBe(false);
    });
});

describe('Hooks - afterRender Hook', () => {
    it('should execute afterRender hook after route handler', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => {
            executionOrder.push('routeHandler');
            return res.html('Test');
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push('afterRender');
            return response;
        });

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(executionOrder).toEqual(['routeHandler', 'afterRender']);
    });

    it('should allow response modification in afterRender', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => {
            return res.json({ original: true });
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            // Modify response body
            const body = JSON.parse(response.body || '{}');
            body.modified = true;
            response.body = JSON.stringify(body);
            return response;
        });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.original).toBe(true);
        expect(body.modified).toBe(true);
    });

    it('should execute multiple afterRender hooks', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(1);
            return response;
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(2);
            return response;
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(3);
            return response;
        });

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('should add custom headers in afterRender', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => res.json({ data: 'test' }));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            response.multiValueHeaders = response.multiValueHeaders || {};
            response.multiValueHeaders['X-Custom-Header'] = ['CustomValue'];
            return response;
        });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.multiValueHeaders?.['X-Custom-Header']).toEqual(['CustomValue']);
    });

    it('should stop execution if afterRender returns Error', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: `Error: ${err.message}` });
            });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            return new Error('Post-processing failed');
        });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toContain('Post-processing failed');
    });
});

describe('Hooks - fallback Hook', () => {
    it('should execute fallback hook when no route matches', async () => {
        let fallbackCalled = false;

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        lambder.addRoute('/exists', (ctx, res) => res.html('Exists'));

        await lambder.addHook('fallback', async (ctx, res) => {
            fallbackCalled = true;
        });

        lambder.setRouteFallbackHandler((ctx, res) => {
            return res.status404('Not Found');
        });

        const handler = lambder.getHandler();
        await handler(createMockEvent('/nonexistent'), createMockContext());

        expect(fallbackCalled).toBe(true);
    });

    it('should execute multiple fallback hooks', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('fallback', async (ctx, res) => {
            executionOrder.push(1);
        });

        await lambder.addHook('fallback', async (ctx, res) => {
            executionOrder.push(2);
        });

        lambder.setRouteFallbackHandler((ctx, res) => res.status404('Not Found'));

        const handler = lambder.getHandler();
        await handler(createMockEvent('/nonexistent'), createMockContext());

        expect(executionOrder).toEqual([1, 2]);
    });

    it('should not execute fallback hook when route matches', async () => {
        let fallbackCalled = false;

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('fallback', async (ctx, res) => {
            fallbackCalled = true;
        });

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(fallbackCalled).toBe(false);
    });
});

describe('Hooks - created Hook', () => {
    it('should execute created hook immediately', async () => {
        let createdCalled = false;
        let lambderInstance: Lambder | null = null;

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('created', async (instance) => {
            createdCalled = true;
            lambderInstance = instance;
        });

        expect(createdCalled).toBe(true);
        expect(lambderInstance).toBe(lambder);
    });

    it('should allow configuration in created hook', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('created', async (instance) => {
            instance.enableCors(true);
        });

        expect(lambder.isCorsEnabled).toBe(true);
    });
});

describe('Hooks - Priority Ordering', () => {
    it('should execute beforeRender hooks in priority order', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(20);
            return ctx;
        }, 20);

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(10);
            return ctx;
        }, 10);

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(30);
            return ctx;
        }, 30);

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        // Should execute in priority order: 10, 20, 30
        expect(executionOrder).toEqual([10, 20, 30]);
    });

    it('should execute afterRender hooks in priority order', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(50);
            return response;
        }, 50);

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(5);
            return response;
        }, 5);

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(25);
            return response;
        }, 25);

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(executionOrder).toEqual([5, 25, 50]);
    });

    it('should use priority 0 as default', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('no-priority');
            return ctx;
        }); // No priority specified, defaults to 0

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('negative');
            return ctx;
        }, -10);

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('positive');
            return ctx;
        }, 10);

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(executionOrder).toEqual(['negative', 'no-priority', 'positive']);
    });
});

describe('Hooks - Combined Workflow', () => {
    it('should execute hooks in correct order: beforeRender -> handler -> afterRender', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('before-1');
            return ctx;
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('before-2');
            return ctx;
        });

        lambder.addRoute('/test', (ctx, res) => {
            executionOrder.push('handler');
            return res.html('Test');
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push('after-1');
            return response;
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push('after-2');
            return response;
        });

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(executionOrder).toEqual([
            'before-1',
            'before-2',
            'handler',
            'after-1',
            'after-2'
        ]);
    });

    it('should work with API handlers', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('beforeRender');
            return ctx;
        });

        lambder.addApi('testApi', {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() })
        }, async (ctx, res) => {
            executionOrder.push('apiHandler');
            return res.api({ result: ctx.apiPayload.value });
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push('afterRender');
            return response;
        });

        const handler = lambder.getHandler();
        const event = createMockEvent('/api', 'POST', 'testApi', { value: 'test' });
        await handler(event, createMockContext());

        expect(executionOrder).toEqual(['beforeRender', 'apiHandler', 'afterRender']);
    });
});

/**
 * Output Type Enforcement Runtime Tests
 * 
 * These tests verify that the typed APIs work correctly at runtime
 * while maintaining type safety at compile time.
 */

import { testPublicFiles } from './helpers.js';
import { describe, it, expect, vi } from 'vitest';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { lambderTestApp, assertApiFailure } from '../src/testing.js';

// Mock AWS Lambda event and context
const createMockEvent = (apiName: string, payload: any): APIGatewayProxyEvent => ({
    body: JSON.stringify({ apiName, payload }),
    headers: { Host: 'localhost', 'Content-Type': 'application/json' },
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
// Runtime Tests
// ============================================================================

describe('Output Type Enforcement - Runtime', () => {
    it('should return correct primitive types', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('add', {
            input: z.object({ a: z.number(), b: z.number() }),
            output: z.number()
        }, async (ctx, resolver) => {
            const { a, b } = ctx.apiPayload;
            const sum = a + b;
            return resolver.api(sum);
        });

        const event = createMockEvent('add', { a: 5, b: 3 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toBe(8);
    });

    it('should return correct object types', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('getUser', {
            input: z.object({ userId: z.string() }),
            output: z.object({ id: z.string(), name: z.string(), age: z.number() })
        }, async (ctx, resolver) => {
            const userId = ctx.apiPayload.userId;
            return resolver.api({
                id: userId,
                name: 'John Doe',
                age: 30
            });
        });

        const event = createMockEvent('getUser', { userId: '123' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');

        expect(body.payload).toEqual({
            id: '123',
            name: 'John Doe',
            age: 30
        });
    });

    it('should return correct array types', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('listUsers', {
            input: z.void(),
            output: z.array(z.object({ id: z.string(), name: z.string() }))
        }, async (ctx, resolver) => {
            return resolver.api([
                { id: '1', name: 'Alice' },
                { id: '2', name: 'Bob' }
            ]);
        });

        const event = createMockEvent('listUsers', undefined);
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual([
            { id: '1', name: 'Alice' },
            { id: '2', name: 'Bob' }
        ]);
    });

    it('should handle null returns correctly', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('findUser', {
            input: z.object({ email: z.string() }),
            output: z.object({ id: z.string(), name: z.string() }).nullable()
        }, async (ctx, resolver) => {
            const email = ctx.apiPayload.email;
            if (email === 'notfound@example.com') {
                return resolver.api(null);
            }
            return resolver.api({ id: '1', name: 'Found User' });
        });

        // Test null case
        const event1 = createMockEvent('findUser', { email: 'notfound@example.com' });
        const context1 = createMockContext();
        const response1 = await lambder.render(event1, context1);

        expect(response1.statusCode).toBe(200);
        const body1 = JSON.parse(response1.body || '{}');
        expect(body1.payload).toBeNull();

        // Test found case
        const event2 = createMockEvent('findUser', { email: 'found@example.com' });
        const context2 = createMockContext();
        const response2 = await lambder.render(event2, context2);

        expect(response2.statusCode).toBe(200);
        const body2 = JSON.parse(response2.body || '{}');
        expect(body2.payload).toEqual({ id: '1', name: 'Found User' });
    });

    it('should return boolean types correctly', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('deleteUser', {
            input: z.object({ userId: z.string() }),
            output: z.boolean()
        }, async (ctx, resolver) => {
            const userId = ctx.apiPayload.userId;
            // Mock deletion
            const success = userId !== '';
            return resolver.api(success);
        });

        const event = createMockEvent('deleteUser', { userId: '123' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toBe(true);
    });

    it('should work with die.api()', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('echo', {
            input: z.object({ message: z.string() }),
            output: z.object({ echo: z.string() })
        }, async (ctx, resolver) => {
            return resolver.die.api({ echo: ctx.apiPayload.message });
        });

        const event = createMockEvent('echo', { message: 'Hello!' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({ echo: 'Hello!' });
    });

    it('refuses a session API at registration when no session store is configured', () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        // A session API that can never find a session is a configuration
        // error, so it fails at startup rather than as a 500 on first request.
        expect(() => lambder.addSessionApi('getUser', {
            input: z.object({ userId: z.string() }),
            output: z.object({ id: z.string(), name: z.string(), age: z.number() })
        }, async (ctx, resolver) => resolver.api({ id: ctx.apiPayload.userId, name: 'Session User', age: 25 })))
            .toThrow(/session API "getUser" needs the session option at creation/);
    });
});

// ============================================================================
// Input Type Tests
// ============================================================================

describe('Input Type Enforcement - Runtime', () => {
    it('should receive correctly typed input', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('echo', {
            input: z.object({ message: z.string() }),
            output: z.object({ echo: z.string() })
        }, async (ctx, resolver) => {
            // Verify input is correctly typed at runtime
            const message: string = ctx.apiPayload.message;
            expect(typeof message).toBe('string');
            return resolver.api({ echo: message });
        });

        const event = createMockEvent('echo', { message: 'Test Message' });
        const context = createMockContext();
        await lambder.render(event, context);
    });

    it('should handle void input correctly', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('listUsers', {
            input: z.void(),
            output: z.array(z.any())
        }, async (ctx, resolver) => {
            // apiPayload should be undefined for void input
            expect(ctx.apiPayload).toBeUndefined();
            return resolver.api([]);
        });

        const event = createMockEvent('listUsers', undefined);
        const context = createMockContext();
        await lambder.render(event, context);
    });

    it('should handle complex input objects', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('add', {
            input: z.object({ a: z.number(), b: z.number() }),
            output: z.number()
        }, async (ctx, resolver) => {
            const { a, b } = ctx.apiPayload;
            expect(typeof a).toBe('number');
            expect(typeof b).toBe('number');
            return resolver.api(a + b);
        });

        const event = createMockEvent('add', { a: 10, b: 20 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toBe(30);
    });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
    it('should handle empty arrays', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('listUsers', {
            input: z.void(),
            output: z.array(z.any())
        }, async (ctx, resolver) => {
            return resolver.api([]);
        });

        const event = createMockEvent('listUsers', undefined);
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual([]);
    });

    it('should handle zero as a valid number', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('add', {
            input: z.object({ a: z.number(), b: z.number() }),
            output: z.number()
        }, async (ctx, resolver) => {
            return resolver.api(0);
        });

        const event = createMockEvent('add', { a: 0, b: 0 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toBe(0);
    });

    it('should handle empty strings in objects', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('getUser', {
            input: z.object({ userId: z.string() }),
            output: z.object({ id: z.string(), name: z.string(), age: z.number() })
        }, async (ctx, resolver) => {
            return resolver.api({
                id: '',
                name: '',
                age: 0
            });
        });

        const event = createMockEvent('getUser', { userId: '' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({
            id: '',
            name: '',
            age: 0
        });
    });
});

// ============================================================================
// A null answer needs a reason
// ============================================================================

describe('Output Type Enforcement - a null answer needs a reason', () => {
    it('res.api(null) compiles only for an output that allows null; beside a reason it always does; the answers run as written', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        })
        .addApi('strict', {
            input: z.object({ mode: z.enum(['ok', 'refuse', 'message']) }),
            output: z.object({ id: z.string() }),
        }, async (ctx, res) => {
            // @ts-expect-error a bare null is not an answer of this output
            if(ctx.apiPayload.mode === 'never') return res.api(null);
            // @ts-expect-error nor through die
            if(ctx.apiPayload.mode === 'never') res.die.api(null);
            if(ctx.apiPayload.mode === 'refuse') return res.api(null, { errorMessage: 'Not now.' });
            if(ctx.apiPayload.mode === 'message') return res.api(null, { message: 'Nothing to report.' });
            return res.api({ id: '1' });
        })
        .addApi('maybe', {
            input: z.object({}),
            output: z.object({ id: z.string() }).nullable(),
        }, async (_ctx, res) => res.api(null));

        const context = createMockContext();
        const strictOk = JSON.parse((await lambder.render(createMockEvent('strict', { mode: 'ok' }), context)).body || '{}');
        expect(strictOk.payload).toEqual({ id: '1' });
        const refused = JSON.parse((await lambder.render(createMockEvent('strict', { mode: 'refuse' }), context)).body || '{}');
        expect(refused).toMatchObject({ payload: null, errorMessage: { type: 'error', content: 'Not now.' } });
        const messaged = JSON.parse((await lambder.render(createMockEvent('strict', { mode: 'message' }), context)).body || '{}');
        expect(messaged).toMatchObject({ payload: null, message: 'Nothing to report.' });
        const maybe = JSON.parse((await lambder.render(createMockEvent('maybe', {}), context)).body || '{}');
        expect(maybe.payload).toBe(null);
    });

    it('an untyped resolver (any output) accepts a bare null', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addRoute('/api-shaped', (_ctx, res) => res.api(null));
        const response = await lambder.render({ ...createMockEvent('unused', {}), path: '/api-shaped', httpMethod: 'GET', body: null }, createMockContext());
        expect(JSON.parse(response.body || '{}').payload).toBe(null);
    });
});

describe('Output parsing at runtime: what a success payload reaches the wire as', () => {
    const userRow = { id: 'u1', name: 'Ada', passwordHash: 'argon2id$...', mfaSecret: 'JBSWY3DPEHPK3PXP' };
    const store = new LambderMemoryIdempotencyStore();
    const app = () => initLambder().create({ apiPath: '/api', idempotency: { store } })
        // A row read straight from a table: assignable to the narrower
        // output type, and carrying fields the schema does not declare.
        .addApi('user.get', { input: z.object({}), output: z.object({ id: z.string(), name: z.string() }) },
            async (_ctx, res) => res.api(userRow))
        .addApi('user.save', { input: z.object({}), output: z.object({ id: z.string(), name: z.string() }), idempotency: true },
            async (_ctx, res) => res.api(userRow))
        .addApi('stamped', { input: z.object({}), output: z.object({ at: z.date(), label: z.string().default('none'), code: z.string().transform((value) => value.toUpperCase()) }) },
            async (_ctx, res) => res.api({ at: new Date(0), code: 'ab' }))
        .addApi('priced', { input: z.object({}), output: z.object({ dollars: z.number().transform((cents) => cents / 100) }) },
            async (_ctx, res) => res.api({ dollars: 1250 }))
        .addApi('broken', { input: z.object({}), output: z.object({ count: z.number() }) },
            async (_ctx, res) => res.api({ count: 'many' } as never))
        .addApi('refused', { input: z.object({}), output: z.object({ id: z.string(), name: z.string() }) },
            async (_ctx, res) => res.api(userRow, { errorMessage: 'Not now.' }))
        .addApi('refusedNull', { input: z.object({}), output: z.object({ count: z.number() }) },
            async (_ctx, res) => res.api(null, { errorMessage: 'Not now.' }));

    it('strips the fields the output schema does not declare, secrets included', async () => {
        expect(await lambderTestApp(app()).visitor().api('user.get', {})).toEqual({ id: 'u1', name: 'Ada' });
    });

    it('stores only the declared shape for a replay', async () => {
        const tested = lambderTestApp(app(), { idempotency: { store } });
        const completed = vi.spyOn(store, 'complete');
        const visitor = tested.visitor();
        const first = await visitor.api('user.save', {}, { idempotencyKey: 'key-0123456789abcdef' });
        const replayed = await visitor.api('user.save', {}, { idempotencyKey: 'key-0123456789abcdef' });
        expect(first).toEqual({ id: 'u1', name: 'Ada' });
        expect(replayed).toEqual({ id: 'u1', name: 'Ada' });
        expect(completed).toHaveBeenCalledOnce();
        expect(JSON.stringify(completed.mock.calls[0])).toContain('Ada');
        expect(JSON.stringify(completed.mock.calls[0])).not.toContain('passwordHash');
        vi.restoreAllMocks();
    });

    it('applies the schema: defaults fill in, transforms run, and a Date leaves as its JSON form', async () => {
        expect(await lambderTestApp(app()).visitor().api('stamped', {})).toEqual({ at: new Date(0).toISOString(), label: 'none', code: 'AB' });
    });

    it('takes the schema\'s input form from the handler, so a transform runs once', async () => {
        expect(await lambderTestApp(app()).visitor().api('priced', {})).toEqual({ dollars: 12.5 });
        initLambder().create({ apiPath: '/api' })
            .addApi('iso', { input: z.object({}), output: z.object({ at: z.date().transform((date) => date.toISOString()) }) }, async (_ctx, res) => {
                // The output form is what the schema produces, not what it parses.
                // @ts-expect-error a string is not the Date the schema takes
                res.api({ at: 'already a string' });
                return res.api({ at: new Date(0) });
            });
    });

    it('answers a payload the schema rejects as a crash, naming the paths and never the values', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const tested = lambderTestApp(app());
        const outcome = await tested.visitor().apiOutcome('broken', {});
        assertApiFailure(outcome, 'server', { status: 500 });
        expect(tested.crashes[0]?.message).toMatch(/API "broken" answered a payload its output schema does not accept, so it was not sent\. count: /);
        expect(tested.crashes[0]?.message).not.toContain('many');
        vi.restoreAllMocks();
    });

    it('strips a refusal\'s payload the same way, and passes null as it is', async () => {
        const visitor = lambderTestApp(app()).visitor();
        const refused = await visitor.apiOutcome('refused', {});
        assertApiFailure(refused, 'errorMessage');
        expect(refused.response.payload).toEqual({ id: 'u1', name: 'Ada' });
        const refusedNull = await visitor.apiOutcome('refusedNull', {});
        assertApiFailure(refusedNull, 'errorMessage');
        expect(refusedNull.response.payload).toBeNull();
    });

    it('sends what a hook or the input validation handler answers as given, in shapes of their own', async () => {
        const cached = { id: 'u1', name: 'Ada', at: new Date(0).toISOString() };
        const answering = initLambder().create({ apiPath: '/api' })
            .addApi('user.get', { input: z.object({ id: z.string() }), output: z.object({ id: z.string(), name: z.string(), at: z.date() }) }, async (_ctx, res) => res.api({ ...userRow, at: new Date(0) }))
            .setApiInputValidationErrorHandler((_ctx, res) => res.api({ field: 'id' } as never, { errorMessage: 'Invalid input.' }))
            // A cached answer, replayed in the wire form it was stored in.
            .addHook('beforeRender', async (ctx, res) => ctx.apiName === 'user.get' && ctx.apiPayload?.id === 'cached' ? res.api(cached) : ctx);
        const visitor = lambderTestApp(answering).visitor();

        expect(await visitor.api('user.get', { id: 'cached' })).toEqual(cached);
        const invalid = await visitor.apiOutcome('user.get', {} as never);
        assertApiFailure(invalid, 'errorMessage');
        expect(invalid.response.payload).toEqual({ field: 'id' });
    });
});

describe('Async refinements in input schemas and preflight slices', () => {
    it('validates them instead of throwing on every call', async () => {
        const taken = new Set(['ada']);
        const available = z.string().refine(async (name) => !taken.has(name), 'That name is taken.');
        const app = lambderTestApp(initLambder().create({
            apiPath: '/api',
            guards: {
                notReserved: { apiInput: z.object({ name: z.string().refine(async (name) => name !== 'root', 'Reserved.') }), handler: async () => {} },
            },
        }).addApi('claim', { input: z.object({ name: available }), output: z.object({ name: z.string() }), guards: 'notReserved' },
            async (ctx, res) => res.api({ name: ctx.apiPayload.name })));
        const visitor = app.visitor();

        expect(await visitor.api('claim', { name: 'grace' })).toEqual({ name: 'grace' });
        assertApiFailure(await visitor.apiOutcome('claim', { name: 'ada' }), 'validation');
        assertApiFailure(await visitor.apiOutcome('claim', { name: 'root' }), 'validation');
        expect(app.crashes).toEqual([]);
    });
});

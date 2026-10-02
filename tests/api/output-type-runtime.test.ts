/**
 * Output Type Enforcement Runtime Tests
 * 
 * These tests verify that the typed APIs work correctly at runtime
 * while maintaining type safety at compile time.
 */

import { testPublicFiles } from '../helpers.js';
import { describe, it, expect, vi } from 'vitest';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { z } from 'zod';
import Lambder, { initLambder } from '../../src/core/Lambder.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { lambderTestApp, assertApiFailure } from '../../src/testing.js';
import { refuse } from '../../src/shared/wire/LambderApiRefusal.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import { apiCallPath } from '../../src/shared/wire/LambderApiNames.js';

// Mock AWS Lambda event and context: a call posted to its endpoint's path
const createMockEvent = (apiName: string, payload: any): APIGatewayProxyEvent => ({
    body: JSON.stringify({ payload }),
    headers: { Host: 'localhost', 'Content-Type': 'application/json' },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: apiCallPath('/api', apiName),
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
    it('should return a primitive inside its object', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('math', {
            add: app.defineApi({
                input: z.object({ a: z.number(), b: z.number() }),
                output: z.object({ sum: z.number() })
            }, async (ctx) => {
                const { a, b } = ctx.apiPayload;
                return { sum: a + b };
            }),
        }));

        const event = createMockEvent('math.add', { a: 5, b: 3 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({ sum: 8 });
    });

    it('should return correct object types', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('users', {
            get: app.defineApi({
                input: z.object({ userId: z.string() }),
                output: z.object({ id: z.string(), name: z.string(), age: z.number() })
            }, async (ctx) => {
                const userId = ctx.apiPayload.userId;
                return {
                    id: userId,
                    name: 'John Doe',
                    age: 30
                };
            }),
        }));

        const event = createMockEvent('users.get', { userId: '123' });
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
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('users', {
            list: app.defineApi({
                input: z.void(),
                output: z.array(z.object({ id: z.string(), name: z.string() }))
            }, async (ctx) => {
                return [
                    { id: '1', name: 'Alice' },
                    { id: '2', name: 'Bob' }
                ];
            }),
        }));

        const event = createMockEvent('users.list', undefined);
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual([
            { id: '1', name: 'Alice' },
            { id: '2', name: 'Bob' }
        ]);
    });

    it('should handle a nullable member correctly', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('users', {
            find: app.defineApi({
                input: z.object({ email: z.string() }),
                output: z.object({ user: z.object({ id: z.string(), name: z.string() }).nullable() })
            }, async (ctx) => {
                const email = ctx.apiPayload.email;
                if (email === 'notfound@example.com') {
                    return { user: null };
                }
                return { user: { id: '1', name: 'Found User' } };
            }),
        }));

        // Test null case
        const event1 = createMockEvent('users.find', { email: 'notfound@example.com' });
        const context1 = createMockContext();
        const response1 = await lambder.render(event1, context1);

        expect(response1.statusCode).toBe(200);
        const body1 = JSON.parse(response1.body || '{}');
        expect(body1.payload).toEqual({ user: null });

        // Test found case
        const event2 = createMockEvent('users.find', { email: 'found@example.com' });
        const context2 = createMockContext();
        const response2 = await lambder.render(event2, context2);

        expect(response2.statusCode).toBe(200);
        const body2 = JSON.parse(response2.body || '{}');
        expect(body2.payload).toEqual({ user: { id: '1', name: 'Found User' } });
    });

    it('should return boolean types correctly', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('users', {
            delete: app.defineApi({
                input: z.object({ userId: z.string() }),
                output: z.object({ deleted: z.boolean() })
            }, async (ctx) => {
                const userId = ctx.apiPayload.userId;
                // Mock deletion
                return { deleted: userId !== '' };
            }),
        }));

        const event = createMockEvent('users.delete', { userId: '123' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({ deleted: true });
    });

    it('refuses a session API at registration when no session store is configured', () => {
        const app = initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            guards: { signedIn: lambderGuard({ session: true, handler: async () => {} }) },
        });
        // A session API that can never find a session is a configuration
        // error, so it fails at compile time and at startup rather than as a
        // 500 on first request.
        const users = app.defineApiGroup('users', {
            // @ts-expect-error the guard needs a session, and the instance has none
            get: app.defineApi({ input: z.object({ userId: z.string() }), output: z.object({ id: z.string(), name: z.string(), age: z.number() }), guards: 'signedIn' }, async (ctx) => ({ id: ctx.apiPayload.userId, name: 'Session User', age: 25 })),
        });
        expect(() => app.registerApiGroups(users))
            .toThrow(/a guard of API "users\.get" needs a session, and the instance was created without the session option/);
    });
});

// ============================================================================
// Input Type Tests
// ============================================================================

describe('Input Type Enforcement - Runtime', () => {
    it('should receive correctly typed input', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            echo: app.defineApi({
                input: z.object({ message: z.string() }),
                output: z.object({ echo: z.string() })
            }, async (ctx) => {
                // Verify input is correctly typed at runtime
                const message: string = ctx.apiPayload.message;
                expect(typeof message).toBe('string');
                return { echo: message };
            }),
        }));

        const event = createMockEvent('test.echo', { message: 'Test Message' });
        const context = createMockContext();
        await lambder.render(event, context);
    });

    it('should handle void input correctly', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('users', {
            list: app.defineApi({
                input: z.void(),
                output: z.array(z.any())
            }, async (ctx) => {
                // apiPayload should be undefined for void input
                expect(ctx.apiPayload).toBeUndefined();
                return [];
            }),
        }));

        const event = createMockEvent('users.list', undefined);
        const context = createMockContext();
        await lambder.render(event, context);
    });

    it('should handle complex input objects', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('math', {
            add: app.defineApi({
                input: z.object({ a: z.number(), b: z.number() }),
                output: z.object({ sum: z.number() })
            }, async (ctx) => {
                const { a, b } = ctx.apiPayload;
                expect(typeof a).toBe('number');
                expect(typeof b).toBe('number');
                return { sum: a + b };
            }),
        }));

        const event = createMockEvent('math.add', { a: 10, b: 20 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({ sum: 30 });
    });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
    it('should handle empty arrays', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('users', {
            list: app.defineApi({
                input: z.void(),
                output: z.array(z.any())
            }, async (ctx) => {
                return [];
            }),
        }));

        const event = createMockEvent('users.list', undefined);
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual([]);
    });

    it('should handle zero as a valid number', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('math', {
            add: app.defineApi({
                input: z.object({ a: z.number(), b: z.number() }),
                output: z.object({ sum: z.number() })
            }, async (ctx) => {
                return { sum: 0 };
            }),
        }));

        const event = createMockEvent('math.add', { a: 0, b: 0 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({ sum: 0 });
    });

    it('should handle empty strings in objects', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('users', {
            get: app.defineApi({
                input: z.object({ userId: z.string() }),
                output: z.object({ id: z.string(), name: z.string(), age: z.number() })
            }, async (ctx) => {
                return {
                    id: '',
                    name: '',
                    age: 0
                };
            }),
        }));

        const event = createMockEvent('users.get', { userId: '' });
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

describe('Output Type Enforcement - a handler answers with its output or refuses', () => {
    it('returns null only for an output that allows null, and says no with refuse()', async () => {
        const app = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            strict: app.defineApi({
                input: z.object({ mode: z.enum(['ok', 'refuse']) }),
                output: z.object({ id: z.string() }),
            }, async (ctx) => {
                if(ctx.apiPayload.mode === 'refuse') refuse('Not now.');
                return { id: '1' };
            }),
            // @ts-expect-error a bare null is not an answer of this output
            never: app.defineApi({ input: z.object({}), output: z.object({ id: z.string() }) }, async (_ctx) => null),
        }));

        const context = createMockContext();
        const strictOk = JSON.parse((await lambder.render(createMockEvent('test.strict', { mode: 'ok' }), context)).body || '{}');
        expect(strictOk.payload).toEqual({ id: '1' });
        const refused = JSON.parse((await lambder.render(createMockEvent('test.strict', { mode: 'refuse' }), context)).body || '{}');
        expect(refused).toMatchObject({ payload: null, refusal: { type: 'warning', content: 'Not now.' } });
    });

    it('refuses an output that is not an object or an array where it is written, and crashes a handler that answers one', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = initLambder().create({ apiPath: '/api' });
        const tested = lambderTestApp(app.registerApiGroups(app.defineApiGroup('test', {
            // @ts-expect-error an output that may be null is not an object
            maybe: app.defineApi({ input: z.object({}), output: z.object({ id: z.string() }).nullable() }, async (_ctx) => null),
            // @ts-expect-error nor is one that may be undefined, which JSON would drop
            perhaps: app.defineApi({ input: z.object({}), output: z.object({ id: z.string() }).optional() }, async (_ctx) => undefined),
            // @ts-expect-error nor is a boolean
            flag: app.defineApi({ input: z.object({}), output: z.boolean() }, async (_ctx) => false),
            // @ts-expect-error nor a Date, which JSON writes as a string
            clock: app.defineApi({ input: z.object({}), output: z.date() }, async (_ctx) => new Date(0)),
            // @ts-expect-error nor nothing at all
            silent: app.defineApi({ input: z.object({}), output: z.void() }, async (_ctx) => undefined),
            loose: app.defineApi({ input: z.object({}), output: z.any() }, async (_ctx) => 0),
        })));
        for(const name of ['test.maybe', 'test.perhaps', 'test.flag', 'test.clock', 'test.silent', 'test.loose'] as const){
            const outcome = await tested.visitor().apiOutcome(name, {});
            assertApiFailure(outcome, 'server', { status: 500 });
        }
        expect(tested.crashes.map((crash) => crash.message)).toEqual([
            expect.stringContaining('API "test.maybe" answered null, and an API answers with an object or an array'),
            expect.stringContaining('API "test.perhaps" answered nothing'),
            expect.stringContaining('API "test.flag" answered a boolean'),
            expect.stringContaining('API "test.clock" answered an object that JSON writes as something else'),
            expect.stringContaining('API "test.silent" answered nothing'),
            expect.stringContaining('API "test.loose" answered a number'),
        ]);
        vi.restoreAllMocks();
    });

    it('a route writing an API envelope by hand writes a refusal, and one that says nothing is refused', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addRoute('/api-shaped', (_ctx, res) => res.apiRefusal({ notAuthorized: true }))
            .addRoute('/api-empty', (_ctx, res) => res.apiRefusal({} as never))
            .addRoute('/api-coded', (_ctx, res) => res.apiRefusal({ refusal: { type: 'error', content: 'No.', code: 'app/no' as never } }));
        const render = async (path: string) => await lambder.render({ ...createMockEvent('test.unused', {}), path, httpMethod: 'GET', body: null }, createMockContext());
        expect(JSON.parse((await render('/api-shaped')).body || '{}')).toEqual({ apiVersion: null, payload: null, notAuthorized: true });
        expect((await render('/api-empty')).statusCode).toBe(500);
        expect((await render('/api-coded')).statusCode).toBe(500);
        vi.restoreAllMocks();
    });
});

describe('Output parsing at runtime: what a success payload reaches the wire as', () => {
    const userRow = { id: 'u1', name: 'Ada', passwordHash: 'argon2id$...', mfaSecret: 'JBSWY3DPEHPK3PXP' };
    const store = new LambderMemoryIdempotencyStore();
    const app = () => {
        const instance = initLambder().create({ apiPath: '/api', idempotency: { store } });
        return instance.registerApiGroups(
            instance.defineApiGroup('user', {
                // A row read straight from a table: assignable to the narrower
                // output type, and carrying fields the schema does not declare.
                get: instance.defineApi({ input: z.object({}), output: z.object({ id: z.string(), name: z.string() }) },
                    async (_ctx) => userRow),
                save: instance.defineApi({ input: z.object({}), output: z.object({ id: z.string(), name: z.string() }), idempotency: true },
                    async (_ctx) => userRow),
            }),
            instance.defineApiGroup('test', {
                stamped: instance.defineApi({ input: z.object({}), output: z.object({ at: z.date(), label: z.string().default('none'), code: z.string().transform((value) => value.toUpperCase()) }) },
                    async (_ctx) => ({ at: new Date(0), code: 'ab' })),
                priced: instance.defineApi({ input: z.object({}), output: z.object({ dollars: z.number().transform((cents) => cents / 100) }) },
                    async (_ctx) => ({ dollars: 1250 })),
                broken: instance.defineApi({ input: z.object({}), output: z.object({ count: z.number() }) },
                    async (_ctx) => ({ count: 'many' } as never)),
            }),
        );
    };

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
        expect(await lambderTestApp(app()).visitor().api('test.stamped', {})).toEqual({ at: new Date(0).toISOString(), label: 'none', code: 'AB' });
    });

    it('takes the schema\'s input form from the handler, so a transform runs once', async () => {
        expect(await lambderTestApp(app()).visitor().api('test.priced', {})).toEqual({ dollars: 12.5 });
        const iso = { input: z.object({}), output: z.object({ at: z.date().transform((date) => date.toISOString()) }) };
        const isoApp = initLambder().create({ apiPath: '/api' });
        isoApp.registerApiGroups(isoApp.defineApiGroup('test', {
            iso: isoApp.defineApi(iso, async (_ctx) => ({ at: new Date(0) })),
            // The output form is what the schema produces, not what it parses.
            // @ts-expect-error a string is not the Date the schema takes
            isoString: isoApp.defineApi(iso, async (_ctx) => ({ at: 'already a string' })),
        }));
    });

    it('answers a payload the schema rejects as a crash, naming the paths and never the values', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const tested = lambderTestApp(app());
        const outcome = await tested.visitor().apiOutcome('test.broken', {});
        assertApiFailure(outcome, 'server', { status: 500 });
        expect(tested.crashes[0]?.message).toMatch(/API "test\.broken" answered a payload its output schema does not accept, so it was not sent\. count: /);
        expect(tested.crashes[0]?.message).not.toContain('many');
        vi.restoreAllMocks();
    });

    it('reads what a hook or the input validation handler answers as a refusal, never as a success', async () => {
        const answeringApp = initLambder().create({ apiPath: '/api' });
        const answering = answeringApp.registerApiGroups(answeringApp.defineApiGroup('user', {
            get: answeringApp.defineApi({ input: z.object({ id: z.string() }), output: z.object({ id: z.string(), name: z.string() }) }, async (_ctx) => userRow),
        }))
            .setApiInputValidationErrorHandler((_ctx, res) => res.apiRefusal({ refusal: 'Invalid input.' }))
            .addHook('beforeRender', async (ctx, res) => {
                if(ctx.apiName !== 'user.get') return ctx;
                if(ctx.apiPayload?.id === 'blocked') return res.apiRefusal({ notAuthorized: true });
                // An envelope shaped like a success, written by hand: no
                // handler wrote it, and its payload is not an object.
                if(ctx.apiPayload?.id === 'forged') return res.json({ apiVersion: null, payload: null });
                return ctx;
            });
        const visitor = lambderTestApp(answering).visitor();

        const invalid = await visitor.apiOutcome('user.get', {} as never);
        assertApiFailure(invalid, 'refusal');
        expect(invalid.response.payload).toBe(null);
        assertApiFailure(await visitor.apiOutcome('user.get', { id: 'blocked' }), 'notAuthorized');
        assertApiFailure(await visitor.apiOutcome('user.get', { id: 'forged' }), 'server');
        await expect(visitor.api('user.get', { id: 'forged' })).rejects.toThrow(/^user\.get: .*reason "server"/);
        expect(await visitor.api('user.get', { id: 'u1' })).toEqual({ id: 'u1', name: 'Ada' });
    });
});

describe('Async refinements in input schemas and preflight slices', () => {
    it('validates them instead of throwing on every call', async () => {
        const taken = new Set(['ada']);
        const available = z.string().refine(async (name) => !taken.has(name), 'That name is taken.');
        const names = initLambder().create({
            apiPath: '/api',
            guards: {
                notReserved: { apiInput: z.object({ name: z.string().refine(async (name) => name !== 'root', 'Reserved.') }), handler: async () => {} },
            },
        });
        const app = lambderTestApp(names.registerApiGroups(names.defineApiGroup('names', {
            claim: names.defineApi({ input: z.object({ name: available }), output: z.object({ name: z.string() }), guards: 'notReserved' },
                async (ctx) => ({ name: ctx.apiPayload.name })),
        })));
        const visitor = app.visitor();

        expect(await visitor.api('names.claim', { name: 'grace' })).toEqual({ name: 'grace' });
        assertApiFailure(await visitor.apiOutcome('names.claim', { name: 'ada' }), 'validation');
        assertApiFailure(await visitor.apiOutcome('names.claim', { name: 'root' }), 'validation');
        expect(app.crashes).toEqual([]);
    });
});

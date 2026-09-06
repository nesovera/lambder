/**
 * Declarative API policies: rate limits, guards, idempotency, and the
 * registration-time assertions (duplicate names, unknown references,
 * session-keyed policies on public APIs, options without their enable call).
 */

import {
    DynamoDBClient,
    UpdateItemCommand,
    PutItemCommand,
    GetItemCommand,
    DeleteItemCommand,
    type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { describe, it, expect } from 'vitest';
import nodeCrypto from 'crypto';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { LambderApiError } from '../src/shared/LambderApiError.js';
import { LambderDdbRateLimiter } from '../src/stores/LambderDdbRateLimiter.js';
import { LambderDdbIdempotency } from '../src/stores/LambderDdbIdempotency.js';
import { lambderGuard } from '../src/policies/LambderApiGuards.js';
import { lambderRateLimitKey } from '../src/policies/LambderApiRateLimits.js';
import { createMockContext } from './helpers.js';
import type { APIGatewayProxyEvent } from 'aws-lambda';

type Item = Record<string, AttributeValue>;

const conditionalFailure = (): Error =>
    Object.assign(new Error("conditional request failed"), { name: "ConditionalCheckFailedException" });

/** In-memory DynamoDB covering the limiter's ADD counters and the idempotency put/get/delete. */
class MemoryDdb extends DynamoDBClient {
    readonly items = new Map<string, Item>();
    failAll = false;

    constructor(){
        super({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    }

    async send(command: any): Promise<any> {
        if(this.failAll) throw new Error("ddb down");
        const input = command.input;
        const keyOf = (key: any) => `${key.pk.S}|${key.sk.S}`;

        if(command instanceof UpdateItemCommand){
            const k = keyOf(input.Key);
            const existing = this.items.get(k);
            const count = existing ? Number(existing.count?.N ?? 0) : 0;
            const limit = Number(input.ExpressionAttributeValues[":limit"].N);
            if(existing && count >= limit) throw conditionalFailure();
            this.items.set(k, {
                pk: input.Key.pk, sk: input.Key.sk,
                count: { N: String(count + 1) },
                expiresAt: existing?.expiresAt ?? input.ExpressionAttributeValues[":expiresAt"],
            });
            return {};
        }
        if(command instanceof PutItemCommand){
            const k = keyOf(input.Item);
            const existing = this.items.get(k);
            if(input.ConditionExpression?.includes("attribute_not_exists(pk)") && existing){
                const now = Number(input.ExpressionAttributeValues?.[":now"]?.N ?? Math.floor(Date.now() / 1000));
                const notExpired = Number(existing.expiresAt?.N ?? 0) > now;
                if(notExpired) throw conditionalFailure();
            }
            if(input.ConditionExpression === "ownerToken = :owner"){
                if(existing?.ownerToken?.S !== input.ExpressionAttributeValues?.[":owner"]?.S) throw conditionalFailure();
            }
            this.items.set(k, input.Item);
            return {};
        }
        if(command instanceof GetItemCommand){
            return { Item: this.items.get(keyOf(input.Key)) };
        }
        if(command instanceof DeleteItemCommand){
            if(input.ConditionExpression === "ownerToken = :owner"){
                const existing = this.items.get(keyOf(input.Key));
                if(existing?.ownerToken?.S !== input.ExpressionAttributeValues?.[":owner"]?.S) throw conditionalFailure();
            }
            this.items.delete(keyOf(input.Key));
            return {};
        }
        throw new Error("MemoryDdb: unhandled command " + command?.constructor?.name);
    }
}

const createApiEvent = (apiName: string, payload?: any, extra: Record<string, any> = {}): APIGatewayProxyEvent => ({
    body: JSON.stringify({ apiName, payload, ...extra }),
    headers: { Host: 'localhost', 'X-Forwarded-For': '203.0.113.7' },
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

const testSchema = {
    input: z.object({ value: z.string() }),
    output: z.object({ result: z.string() }),
};

const makeLimiter = (client: MemoryDdb, failOpen = false) =>
    new LambderDdbRateLimiter({ tableName: "test-table", client, failOpen });
const makeStore = (client: MemoryDdb) =>
    new LambderDdbIdempotency({ tableName: "test-table", client });

describe('API policies - registration assertions', () => {
    it('throws on duplicate API names', () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .addApi('dup', testSchema, async (ctx, res) => res.api(null));
        expect(() => lambder.addApi('dup', testSchema as any, async (ctx, res) => res.api(null)))
            .toThrow(/duplicate API name "dup"/);
    });

    it('throws when options are declared with no policy configuration', () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' });
        expect(() => lambder.addApi('x', { ...testSchema, rateLimit: 'nope' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/was configured at creation/);
    });

    it('throws on unknown rate-limit policy and unknown guard names', () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { real: { perMin: 5, per: 'ip' } } }, guards: { realGuard: { handler: async () => {} } } });
        expect(() => lambder.addApi('a', { ...testSchema, rateLimit: 'fake' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/unknown rate-limit policy "fake"/);
        expect(() => lambder.addApi('b', { ...testSchema, guards: 'fakeGuard' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/unknown guard "fakeGuard"/);
    });

    it('rejects session-keyed policies on public APIs', () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { perUser: { perMin: 5, per: 'session' } } } });
        expect(() => lambder.addApi('x', { ...testSchema, rateLimit: 'perUser' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/requires addSessionApi/);
    });

    it('rejects the idempotency option when no idempotency store was configured', () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: { g: { handler: async () => {} } } });
        expect(() => lambder.addApi('x', { ...testSchema, idempotency: true } as any, async (ctx, res) => res.api(null)))
            .toThrow(/no idempotency store was configured/);
    });

    it('rejects policies with no window or no per', () => {
        const client = new MemoryDdb();
        expect(() => initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { bad: { per: 'ip' } as any } } }))
            .toThrow(/declares no window/);
        expect(() => initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { bad: { perMin: 1 } as any } } }))
            .toThrow(/needs per/);
    });
});

describe('API policies - rate limiting', () => {
    it('refuses with a 429 envelope after the limit and stops calling the handler', async () => {
        let handlerRuns = 0;
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { tight: { perMin: 2, per: 'ip' } },
            } })
            .addApi('limited', { ...testSchema, rateLimit: 'tight' }, async (ctx, res) => {
                handlerRuns += 1;
                return res.api({ result: 'ok' });
            });

        const call = () => lambder.render(createApiEvent('limited', { value: 'x' }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        const third = await call();
        expect(third.statusCode).toBe(429);
        expect(JSON.parse(third.body || '{}').errorMessage).toBe('Too many requests. Please try again later.');
        expect(handlerRuns).toBe(2);
    });

    it('keys counters by a custom per function (e.g. per email)', async () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    perEmail: {
                        perMin: 1,
                        per: lambderRateLimitKey({
                            apiInput: z.object({ value: z.string() }),
                            handler: (_ctx, { value }) => value,
                        }),
                        errorMessage: { type: 'warning', content: 'Too many attempts for this address.' },
                    },
                },
            } })
            .addApi('code', { ...testSchema, rateLimit: 'perEmail' }, async (ctx, res) => res.api({ result: 'sent' }));

        const call = (value: string) => lambder.render(createApiEvent('code', { value }), createMockContext());
        expect((await call('a@x.com')).statusCode).toBe(200);
        expect((await call('b@x.com')).statusCode).toBe(200);   // different bucket
        const blocked = await call('a@x.com');
        expect(blocked.statusCode).toBe(429);
        expect(JSON.parse(blocked.body || '{}').errorMessage).toEqual({ type: 'warning', content: 'Too many attempts for this address.' });
    });

    it('stacked policies are checked in order and any of them can refuse', async () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    loose: { perMin: 100, per: 'ip' },
                    strict: { perMin: 1, per: 'ip', errorMessage: 'strict says no' },
                },
            } })
            .addApi('stacked', { ...testSchema, rateLimit: ['loose', 'strict'] }, async (ctx, res) => res.api({ result: 'ok' }));

        const call = () => lambder.render(createApiEvent('stacked', { value: 'x' }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        const second = await call();
        expect(second.statusCode).toBe(429);
        expect(JSON.parse(second.body || '{}').errorMessage).toBe('strict says no');
    });

    it('fails open when the limiter instance says so and DynamoDB is down', async () => {
        const client = new MemoryDdb();
        client.failAll = true;
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: { limiter: makeLimiter(client, true), policies: { p: { perMin: 1, per: 'ip' } } } })
            .addApi('open', { ...testSchema, rateLimit: 'p' }, async (ctx, res) => res.api({ result: 'through' }));

        const result = await lambder.render(createApiEvent('open', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('through');
    });

    it('scope "api" (the default) gives each API its own counter', async () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { one: { perMin: 1, per: 'ip' } },
            } })
            .addApi('first', { ...testSchema, rateLimit: 'one' }, async (ctx, res) => res.api({ result: 'a' }))
            .addApi('second', { ...testSchema, rateLimit: 'one' }, async (ctx, res) => res.api({ result: 'b' }));

        expect((await lambder.render(createApiEvent('first', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        // Separate budget: the second API is untouched by the first one's counter.
        expect((await lambder.render(createApiEvent('second', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        expect((await lambder.render(createApiEvent('first', { value: 'x' }), createMockContext())).statusCode).toBe(429);
    });

    it('scope "policy" shares one counter across every API referencing the policy', async () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { shared: { perMin: 1, per: 'ip', scope: 'policy' } },
            } })
            .addApi('first', { ...testSchema, rateLimit: 'shared' }, async (ctx, res) => res.api({ result: 'a' }))
            .addApi('second', { ...testSchema, rateLimit: 'shared' }, async (ctx, res) => res.api({ result: 'b' }));

        expect((await lambder.render(createApiEvent('first', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        // One combined budget: the first API's call consumed it for both.
        expect((await lambder.render(createApiEvent('second', { value: 'x' }), createMockContext())).statusCode).toBe(429);
    });
});

describe('API policies - guards', () => {
    it('a refusing guard blocks before validation and before the handler', async () => {
        let handlerRan = false;
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: {
                deny: {
                    handler: async () => {
                        throw new LambderApiError('Guard says no', { errorMessage: { type: 'error', content: 'Blocked.' } });
                    },
                },
            } })
            .addApi('guarded', { ...testSchema, guards: 'deny' }, async (ctx, res) => {
                handlerRan = true;
                return res.api({ result: 'never' });
            });

        // Invalid payload on purpose: the guard must win over the 422.
        const result = await lambder.render(createApiEvent('guarded', { wrong: true }), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body || '{}').errorMessage).toEqual({ type: 'error', content: 'Blocked.' });
        expect(handlerRan).toBe(false);
    });

    it('apiInput guards validate their slice of the API payload and answer 422 when it is missing', async () => {
        let sawToken: string | null = null;
        const gatedSchema = {
            input: z.object({ value: z.string(), token: z.string().min(3) }),
            output: z.object({ result: z.string() }),
        };
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: {
                token: lambderGuard({
                    apiInput: z.object({ token: z.string().min(3) }),
                    handler: async (_ctx, { token }) => { sawToken = token; },
                }),
            } })
            .addApi('gated', { ...gatedSchema, guards: 'token' }, async (ctx, res) => res.api({ result: ctx.apiPayload.value }));

        // Missing token: the 422 validation shape, before the guard or handler runs.
        const missing = await lambder.render(createApiEvent('gated', { value: 'x' }), createMockContext());
        expect(missing.statusCode).toBe(422);
        expect(JSON.parse(missing.body || '{}').zodError).toBeDefined();
        expect(sawToken).toBe(null);

        // Present: guard gets its typed slice AND the field flows on into the
        // API's own validated payload (it stays part of the API input shape).
        const ok = await lambder.render(createApiEvent('gated', { value: 'x', token: 'abc' }), createMockContext());
        expect(ok.statusCode).toBe(200);
        expect(JSON.parse(ok.body || '{}').payload.result).toBe('x');
        expect(sawToken).toBe('abc');
    });

    it('guardInput guards read their value from the separate guardInputs envelope', async () => {
        let sawToken: string | null = null;
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: {
                captcha: lambderGuard({
                    guardInput: z.object({ token: z.string().min(3) }),
                    handler: async (_ctx, { token }) => { sawToken = token; },
                }),
            } })
            .addApi('gated', { ...testSchema, guards: 'captcha' }, async (ctx, res) => res.api({ result: ctx.apiPayload.value }));

        // Missing guardInputs entry: 422 before the handler runs, and the API
        // payload itself is untouched by the requirement.
        const missing = await lambder.render(createApiEvent('gated', { value: 'x' }), createMockContext());
        expect(missing.statusCode).toBe(422);
        expect(sawToken).toBe(null);

        const ok = await lambder.render(
            createApiEvent('gated', { value: 'x' }, { guardInputs: { captcha: { token: 'abc' } } }),
            createMockContext(),
        );
        expect(ok.statusCode).toBe(200);
        expect(JSON.parse(ok.body || '{}').payload.result).toBe('x');
        expect(sawToken).toBe('abc');
    });

    it('validates a custom rate-limit key slice and answers 422 when it is missing', async () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    perEmail: {
                        perMin: 5,
                        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }),
                    },
                },
            } })
            .addApi('keyed', { ...testSchema, rateLimit: 'perEmail' }, async (ctx, res) => res.api({ result: 'ok' }));

        const missing = await lambder.render(createApiEvent('keyed', { value: 'x' }), createMockContext());
        expect(missing.statusCode).toBe(422);
        const ok = await lambder.render(createApiEvent('keyed', { value: 'x', email: 'a@x.com' }), createMockContext());
        expect(ok.statusCode).toBe(200);
    });

    it('guards run in declared order and passing guards let the handler run', async () => {
        const order: string[] = [];
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: {
                first: { handler: async () => { order.push('first'); } },
                second: { handler: async () => { order.push('second'); } },
            } })
            .addApi('ordered', { ...testSchema, guards: ['first', 'second'] }, async (ctx, res) => res.api({ result: 'ran' }));

        const result = await lambder.render(createApiEvent('ordered', { value: 'x' }), createMockContext());
        expect(order).toEqual(['first', 'second']);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ran');
    });

    it("a guard's return value lands typed on ctx.guardData under its name", async () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: {
                deviceAuth: lambderGuard({
                    apiInput: z.object({ token: z.string() }),
                    handler: async (_ctx, { token }) => ({ deviceId: `dev-${token}` }),
                }),
            } })
            .addApi('withData', {
                input: z.object({ value: z.string(), token: z.string() }),
                output: z.object({ result: z.string() }),
                guards: 'deviceAuth',
            }, async (ctx, res) => res.api({ result: ctx.guardData.deviceAuth.deviceId }));

        const result = await lambder.render(createApiEvent('withData', { value: 'x', token: 'abc' }), createMockContext());
        expect(JSON.parse(result.body || '{}').payload.result).toBe('dev-abc');
    });

    it('the object form passes params, runs in insertion order, and keeps void guards out of guardData', async () => {
        const order: string[] = [];
        let seenGuardData: Record<string, unknown> = {};
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: {
                perm: lambderGuard({
                    handler: (_ctx, _payload, _res, permission: string) => {
                        order.push(`perm:${permission}`);
                        return { granted: permission };
                    },
                }),
                audit: lambderGuard({
                    handler: () => { order.push('audit'); },
                }),
            } })
            .addApi('paramed', {
                ...testSchema,
                guards: { perm: 'ADMIN.MANAGE', audit: true },
            }, async (ctx, res) => {
                seenGuardData = { ...ctx.guardData };
                return res.api({ result: ctx.guardData.perm.granted });
            });

        const result = await lambder.render(createApiEvent('paramed', { value: 'x' }), createMockContext());
        expect(order).toEqual(['perm:ADMIN.MANAGE', 'audit']);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ADMIN.MANAGE');
        // The check-only guard returned nothing, so it never appears.
        expect(Object.keys(seenGuardData)).toEqual(['perm']);
    });

    it('a refusal from a parameterized guard blocks the handler', async () => {
        let handlerRan = false;
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: {
                perm: lambderGuard({
                    handler: (_ctx, _payload, _res, permission: string) => {
                        throw new LambderApiError(`Denied: ${permission}`, { notAuthorized: true });
                    },
                }),
            } })
            .addApi('denied', { ...testSchema, guards: { perm: 'ADMIN.NOPE' } }, async (ctx, res) => {
                handlerRan = true;
                return res.api({ result: 'never' });
            });

        const result = await lambder.render(createApiEvent('denied', { value: 'x' }), createMockContext());
        expect(JSON.parse(result.body || '{}').notAuthorized).toBe(true);
        expect(handlerRan).toBe(false);
    });

    it('session guards are rejected on public APIs at registration', () => {
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', guards: {
                orgPermission: lambderGuard({
                    session: true,
                    handler: (ctx) => ({ orgId: ctx.session.sessionKey }),
                }),
            } });
        expect(() => lambder.addApi('pub', { ...testSchema, guards: 'orgPermission' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/guard "orgPermission" \(session: true\), which requires addSessionApi/);
    });
});

describe('API policies - idempotency', () => {
    // Keys must be at least 16 chars (they scope the replay record for
    // logged-out clients, so they are required to be long and random).
    const KEY_1 = 'k-1-abcdefabcdefabcdef';
    const KEY_2 = 'k-2-abcdefabcdefabcdef';
    const KEY_3 = 'k-3-abcdefabcdefabcdef';
    const KEY_DIE = 'k-die-abcdefabcdefabcdef';
    const KEY_BUSY = 'k-busy-abcdefabcdefabcdef';
    const KEY_OLD = 'k-old-abcdefabcdefabcdef';

    const build = (client: MemoryDdb, onRun?: () => void) =>
        initLambder().create({ publicPath: './public', apiPath: '/api', idempotency: { store: makeStore(client) } })
            .addApi('op', { ...testSchema, idempotency: true }, async (ctx, res) => {
                onRun?.();
                return res.api({ result: `ran:${ctx.apiPayload.value}` });
            });

    it('executes normally when no idempotencyKey is sent', async () => {
        let runs = 0;
        const lambder = build(new MemoryDdb(), () => { runs += 1; });
        await lambder.render(createApiEvent('op', { value: 'a' }), createMockContext());
        await lambder.render(createApiEvent('op', { value: 'a' }), createMockContext());
        expect(runs).toBe(2);
    });

    it('replays the stored response for a repeated key without re-executing', async () => {
        let runs = 0;
        const lambder = build(new MemoryDdb(), () => { runs += 1; });
        const call = () => lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());

        const first = await call();
        const second = await call();
        expect(runs).toBe(1);
        expect(second.statusCode).toBe(first.statusCode);
        expect(second.body).toBe(first.body);
        expect(JSON.parse(second.body || '{}').payload.result).toBe('ran:a');
    });

    it('a replay answers before rate limits, so a retry does not burn quota', async () => {
        let runs = 0;
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { tight: { perMin: 1, per: 'ip' } },
            }, idempotency: { store: makeStore(new MemoryDdb()) } })
            .addApi('op', { ...testSchema, rateLimit: 'tight', idempotency: true }, async (ctx, res) => {
                runs += 1;
                return res.api({ result: 'ok' });
            });

        const call = (key: string) => lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: key }), createMockContext());
        expect((await call(KEY_1)).statusCode).toBe(200);
        // Same key: replayed 200 even though the perMin: 1 budget is spent.
        const retry = await call(KEY_1);
        expect(retry.statusCode).toBe(200);
        expect(JSON.parse(retry.body || '{}').payload.result).toBe('ok');
        expect(runs).toBe(1);
        // A NEW operation is properly rate limited.
        expect((await call(KEY_2)).statusCode).toBe(429);
    });

    it('a response delivered by throwing (res.die.api) is stored and replayed', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', idempotency: { store: makeStore(client) } })
            .addApi('thrower', { ...testSchema, idempotency: true }, async (ctx, res) => {
                runs += 1;
                return res.die.api({ result: 'thrown' });
            });

        const call = () => lambder.render(createApiEvent('thrower', { value: 'a' }, { idempotencyKey: KEY_DIE }), createMockContext());
        const first = await call();
        const second = await call();
        expect(runs).toBe(1);
        expect(second.body).toBe(first.body);
        expect(JSON.parse(second.body || '{}').payload.result).toBe('thrown');
    });

    it('stores response headers, including ones set via res.setHeader, and replays them', async () => {
        let runs = 0;
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } })
            .addApi('headed', { ...testSchema, idempotency: true }, async (ctx, res) => {
                runs += 1;
                res.setHeader('X-Custom', 'stored-value');
                return res.api({ result: 'ok' });
            });

        const call = () => lambder.render(createApiEvent('headed', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        const first = await call();
        const second = await call();
        expect(runs).toBe(1);
        expect(first.multiValueHeaders?.['X-Custom']).toEqual(['stored-value']);
        expect(second.multiValueHeaders?.['X-Custom']).toEqual(['stored-value']);
        expect(second.multiValueHeaders?.['Content-Type']).toEqual(first.multiValueHeaders?.['Content-Type']);
    });

    it('never stores a response that sets cookies: the retry re-executes', async () => {
        let runs = 0;
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } })
            .addApi('cookied', { ...testSchema, idempotency: true }, async (ctx, res) => {
                runs += 1;
                res.addHeader('Set-Cookie', `run=${runs}`);
                return res.api({ result: 'ok' });
            });

        const call = () => lambder.render(createApiEvent('cookied', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        // Not a 409 either: the claim was released, not left dangling.
        const second = await call();
        expect(second.statusCode).toBe(200);
        expect(runs).toBe(2);
        expect(second.multiValueHeaders?.['Set-Cookie']).toEqual(['run=2']);
    });

    it('compression lets large compressible bodies replay (450KB raw is far over a raw cap)', async () => {
        let runs = 0;
        // 150k euro signs: ~450KB UTF-8, but Brotli shrinks it to almost nothing.
        const bigValue = '€'.repeat(150_000);
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } })
            .addApi('big', { ...testSchema, idempotency: true }, async (ctx, res) => {
                runs += 1;
                return res.api({ result: bigValue });
            });

        const call = () => lambder.render(createApiEvent('big', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        const replay = await call();
        expect(replay.statusCode).toBe(200);
        expect(runs).toBe(1);
    });

    it('a body too large even compressed is not stored: the retry re-executes, with no dangling 409', async () => {
        let runs = 0;
        // Random base64 barely compresses: ~533KB stays well over the 350KB item budget.
        const incompressible = nodeCrypto.randomBytes(400_000).toString('base64');
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } })
            .addApi('huge', { ...testSchema, idempotency: true }, async (ctx, res) => {
                runs += 1;
                return res.api({ result: incompressible });
            });

        const call = () => lambder.render(createApiEvent('huge', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        expect(runs).toBe(2);
    });

    it('a slow original that lost its claim cannot clobber the new owner', async () => {
        const client = new MemoryDdb();
        const store = makeStore(client);
        const original = await store.begin('scope-x', { pendingTtlSeconds: 300 });
        expect(original.state).toBe('new');
        if(original.state !== 'new') return;

        // The original stalls past its pending TTL; a retry claims the scope.
        const k = 'IDEM#scope-x|idem';
        client.items.get(k)!.expiresAt = { N: String(Math.floor(Date.now() / 1000) - 10) };
        const retry = await store.begin('scope-x', { pendingTtlSeconds: 300 });
        expect(retry.state).toBe('new');
        if(retry.state !== 'new') return;

        // The stalled original settles late: both paths must be silent no-ops.
        const staleBody = { statusCode: 200, headers: {}, body: 'stale', ttlSeconds: 60 };
        expect(await store.complete('scope-x', original.ownerToken, staleBody)).toBe('lost');
        await store.abandon('scope-x', original.ownerToken);
        expect(client.items.get(k)?.state?.S).toBe('pending');

        // The retry still owns the scope and settles normally.
        expect(await store.complete('scope-x', retry.ownerToken, { ...staleBody, body: 'fresh' })).toBe('stored');
        expect(client.items.get(k)?.body?.S).toBe('fresh');
    });

    it('stores bodies of 1KB+ Brotli-compressed and replays them verbatim; small bodies stay plain', async () => {
        const client = new MemoryDdb();
        const store = makeStore(client);
        const k = 'IDEM#scope-br|idem';

        const big = JSON.stringify({ payload: { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${i}` })) } });
        expect(Buffer.byteLength(big)).toBeGreaterThan(1024);
        const claim = await store.begin('scope-br', { pendingTtlSeconds: 300 });
        if(claim.state !== 'new') throw new Error('expected fresh claim');
        expect(await store.complete('scope-br', claim.ownerToken, { statusCode: 200, headers: {}, body: big, ttlSeconds: 60 })).toBe('stored');

        const item = client.items.get(k)!;
        expect(item.body).toBe(undefined);
        expect(item.bodyBr?.B).toBeDefined();
        expect((item.bodyBr!.B as Uint8Array).byteLength).toBeLessThan(Buffer.byteLength(big));
        expect(Number(item.bodyBytes?.N)).toBe(Buffer.byteLength(big));
        expect((await store.peek('scope-br'))?.body).toBe(big);

        // Below the threshold: plain string attribute, no compression.
        const claim2 = await store.begin('scope-plain', { pendingTtlSeconds: 300 });
        if(claim2.state !== 'new') throw new Error('expected fresh claim');
        await store.complete('scope-plain', claim2.ownerToken, { statusCode: 200, headers: {}, body: 'tiny', ttlSeconds: 60 });
        expect(client.items.get('IDEM#scope-plain|idem')?.body?.S).toBe('tiny');
        expect((await store.peek('scope-plain'))?.body).toBe('tiny');
    });

    it('refuses a duplicate while the original is still pending', async () => {
        const client = new MemoryDdb();
        const lambder = build(client);
        const now = Math.floor(Date.now() / 1000);
        // Pre-seed an unexpired pending claim for this scope (public scope: key-only).
        client.items.set(`IDEM#k|op|${KEY_BUSY}|idem`, {
            pk: { S: `IDEM#k|op|${KEY_BUSY}` }, sk: { S: 'idem' },
            state: { S: 'pending' }, expiresAt: { N: String(now + 100) },
        });

        const result = await lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: KEY_BUSY }), createMockContext());
        expect(result.statusCode).toBe(409);
        expect(JSON.parse(result.body || '{}').errorMessage).toBe('This request is already being processed.');
    });

    it('releases the claim when the handler crashes, so a retry re-executes', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        const lambder = initLambder().create({ publicPath: './public', apiPath: '/api', idempotency: { store: makeStore(client) } })
            .addApi('crashy', { ...testSchema, idempotency: true }, async (ctx, res) => {
                runs += 1;
                if(runs === 1) throw new Error('boom');
                return res.api({ result: 'recovered' });
            });

        const call = () => lambder.render(createApiEvent('crashy', { value: 'a' }, { idempotencyKey: KEY_2 }), createMockContext());
        expect((await call()).statusCode).toBe(500);
        const retry = await call();
        expect(runs).toBe(2);
        expect(JSON.parse(retry.body || '{}').payload.result).toBe('recovered');
    });

    it('treats an expired claim as absent and re-executes', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        const lambder = build(client, () => { runs += 1; });
        const now = Math.floor(Date.now() / 1000);
        client.items.set(`IDEM#k|op|${KEY_OLD}|idem`, {
            pk: { S: `IDEM#k|op|${KEY_OLD}` }, sk: { S: 'idem' },
            state: { S: 'done' }, statusCode: { N: '200' }, body: { S: '{"stale":true}' },
            expiresAt: { N: String(now - 10) },
        });

        const result = await lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: KEY_OLD }), createMockContext());
        expect(runs).toBe(1);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ran:a');
    });

    it('refuses malformed keys with a 400 envelope: too long, and too short to be unguessable', async () => {
        const lambder = build(new MemoryDdb());
        const tooLong = await lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: 'x'.repeat(201) }), createMockContext());
        expect(tooLong.statusCode).toBe(400);
        const tooShort = await lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: 'short-key' }), createMockContext());
        expect(tooShort.statusCode).toBe(400);
    });

    it('fails open by default when DynamoDB is down: the handler still runs, without dedupe', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        client.failAll = true;
        const lambder = build(client, () => { runs += 1; });
        const call = () => lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: KEY_3 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        expect(runs).toBe(2);
    });
});

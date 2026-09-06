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
import { z } from 'zod';
import Lambder from '../src/Lambder.js';
import { LambderApiError } from '../src/LambderApiError.js';
import { LambderDdbRateLimiter } from '../src/LambderDdbRateLimiter.js';
import { LambderDdbIdempotency } from '../src/LambderDdbIdempotency.js';
import { lambderGuard, lambderRateLimitKey } from '../src/LambderApiPolicies.js';
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

    it('throws when options are declared with no enable/define call', () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' });
        expect(() => lambder.addApi('x', { ...testSchema, rateLimit: 'nope' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/was called first/);
    });

    it('throws on unknown rate-limit policy and unknown guard names', () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({ limiter: makeLimiter(new MemoryDdb()), policies: { real: { perMin: 5, per: 'ip' } } })
            .defineApiGuards({ realGuard: { handler: async () => {} } });
        expect(() => lambder.addApi('a', { ...testSchema, rateLimit: 'fake' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/unknown rate-limit policy "fake"/);
        expect(() => lambder.addApi('b', { ...testSchema, guards: 'fakeGuard' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/unknown guard "fakeGuard"/);
    });

    it('rejects session-keyed policies on public APIs', () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({ limiter: makeLimiter(new MemoryDdb()), policies: { perUser: { perMin: 5, per: 'session' } } });
        expect(() => lambder.addApi('x', { ...testSchema, rateLimit: 'perUser' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/requires addSessionApi/);
    });

    it('rejects idempotency without enableApiIdempotency', () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .defineApiGuards({ g: { handler: async () => {} } });
        expect(() => lambder.addApi('x', { ...testSchema, idempotency: true } as any, async (ctx, res) => res.api(null)))
            .toThrow(/enableApiIdempotency\(\) was not called first/);
    });

    it('rejects double enables and colliding guard names', () => {
        const client = new MemoryDdb();
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({ limiter: makeLimiter(client), policies: { p: { perMin: 1, per: 'ip' } } })
            .defineApiGuards({ g: { handler: async () => {} } });
        expect(() => lambder.enableApiRateLimits({ limiter: makeLimiter(client), policies: { q: { perMin: 1, per: 'ip' } } }))
            .toThrow(/already called/);
        expect(() => lambder.defineApiGuards({ g: { handler: async () => {} } })).toThrow(/already defined/);
    });

    it('rejects policies with no window or no per', () => {
        const client = new MemoryDdb();
        expect(() => new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({ limiter: makeLimiter(client), policies: { bad: { per: 'ip' } as any } }))
            .toThrow(/declares no window/);
        expect(() => new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({ limiter: makeLimiter(client), policies: { bad: { perMin: 1 } as any } }))
            .toThrow(/needs per/);
    });
});

describe('API policies - rate limiting', () => {
    it('refuses with a 429 envelope after the limit and stops calling the handler', async () => {
        let handlerRuns = 0;
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({
                limiter: makeLimiter(new MemoryDdb()),
                policies: { tight: { perMin: 2, per: 'ip' } },
            })
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
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({
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
            })
            .addApi('code', { ...testSchema, rateLimit: 'perEmail' }, async (ctx, res) => res.api({ result: 'sent' }));

        const call = (value: string) => lambder.render(createApiEvent('code', { value }), createMockContext());
        expect((await call('a@x.com')).statusCode).toBe(200);
        expect((await call('b@x.com')).statusCode).toBe(200);   // different bucket
        const blocked = await call('a@x.com');
        expect(blocked.statusCode).toBe(429);
        expect(JSON.parse(blocked.body || '{}').errorMessage).toEqual({ type: 'warning', content: 'Too many attempts for this address.' });
    });

    it('stacked policies are checked in order and any of them can refuse', async () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    loose: { perMin: 100, per: 'ip' },
                    strict: { perMin: 1, per: 'ip', errorMessage: 'strict says no' },
                },
            })
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
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({ limiter: makeLimiter(client, true), policies: { p: { perMin: 1, per: 'ip' } } })
            .addApi('open', { ...testSchema, rateLimit: 'p' }, async (ctx, res) => res.api({ result: 'through' }));

        const result = await lambder.render(createApiEvent('open', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('through');
    });
});

describe('API policies - guards', () => {
    it('a refusing guard blocks before validation and before the handler', async () => {
        let handlerRan = false;
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .defineApiGuards({
                deny: {
                    handler: async () => {
                        throw new LambderApiError('Guard says no', { errorMessage: { type: 'error', content: 'Blocked.' } });
                    },
                },
            })
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
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .defineApiGuards({
                token: lambderGuard({
                    apiInput: z.object({ token: z.string().min(3) }),
                    handler: async (_ctx, { token }) => { sawToken = token; },
                }),
            })
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
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .defineApiGuards({
                captcha: lambderGuard({
                    guardInput: z.object({ token: z.string().min(3) }),
                    handler: async (_ctx, { token }) => { sawToken = token; },
                }),
            })
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
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiRateLimits({
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    perEmail: {
                        perMin: 5,
                        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }),
                    },
                },
            })
            .addApi('keyed', { ...testSchema, rateLimit: 'perEmail' }, async (ctx, res) => res.api({ result: 'ok' }));

        const missing = await lambder.render(createApiEvent('keyed', { value: 'x' }), createMockContext());
        expect(missing.statusCode).toBe(422);
        const ok = await lambder.render(createApiEvent('keyed', { value: 'x', email: 'a@x.com' }), createMockContext());
        expect(ok.statusCode).toBe(200);
    });

    it('guards run in declared order and passing guards let the handler run', async () => {
        const order: string[] = [];
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .defineApiGuards({
                first: { handler: async () => { order.push('first'); } },
                second: { handler: async () => { order.push('second'); } },
            })
            .addApi('ordered', { ...testSchema, guards: ['first', 'second'] }, async (ctx, res) => res.api({ result: 'ran' }));

        const result = await lambder.render(createApiEvent('ordered', { value: 'x' }), createMockContext());
        expect(order).toEqual(['first', 'second']);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ran');
    });
});

describe('API policies - idempotency', () => {
    const build = (client: MemoryDdb, onRun?: () => void) =>
        new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiIdempotency({ store: makeStore(client) })
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
        const call = () => lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: 'k-1' }), createMockContext());

        const first = await call();
        const second = await call();
        expect(runs).toBe(1);
        expect(second.statusCode).toBe(first.statusCode);
        expect(second.body).toBe(first.body);
        expect(JSON.parse(second.body || '{}').payload.result).toBe('ran:a');
    });

    it('a response delivered by throwing (res.die.api) is stored and replayed', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiIdempotency({ store: makeStore(client) })
            .addApi('thrower', { ...testSchema, idempotency: true }, async (ctx, res) => {
                runs += 1;
                return res.die.api({ result: 'thrown' });
            });

        const call = () => lambder.render(createApiEvent('thrower', { value: 'a' }, { idempotencyKey: 'k-die' }), createMockContext());
        const first = await call();
        const second = await call();
        expect(runs).toBe(1);
        expect(second.body).toBe(first.body);
        expect(JSON.parse(second.body || '{}').payload.result).toBe('thrown');
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
        const staleBody = { statusCode: 200, contentType: null, body: 'stale', ttlSeconds: 60 };
        expect(await store.complete('scope-x', original.ownerToken, staleBody)).toBe(false);
        await store.abandon('scope-x', original.ownerToken);
        expect(client.items.get(k)?.state?.S).toBe('pending');

        // The retry still owns the scope and settles normally.
        expect(await store.complete('scope-x', retry.ownerToken, { ...staleBody, body: 'fresh' })).toBe(true);
        expect(client.items.get(k)?.body?.S).toBe('fresh');
    });

    it('refuses a duplicate while the original is still pending', async () => {
        const client = new MemoryDdb();
        const lambder = build(client);
        const now = Math.floor(Date.now() / 1000);
        // Pre-seed an unexpired pending claim for this scope.
        client.items.set('IDEM#ip:203.0.113.7|op|k-busy|idem', {
            pk: { S: 'IDEM#ip:203.0.113.7|op|k-busy' }, sk: { S: 'idem' },
            state: { S: 'pending' }, expiresAt: { N: String(now + 100) },
        });

        const result = await lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: 'k-busy' }), createMockContext());
        expect(result.statusCode).toBe(409);
        expect(JSON.parse(result.body || '{}').errorMessage).toBe('This request is already being processed.');
    });

    it('releases the claim when the handler crashes, so a retry re-executes', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .enableApiIdempotency({ store: makeStore(client) })
            .addApi('crashy', { ...testSchema, idempotency: true }, async (ctx, res) => {
                runs += 1;
                if(runs === 1) throw new Error('boom');
                return res.api({ result: 'recovered' });
            });

        const call = () => lambder.render(createApiEvent('crashy', { value: 'a' }, { idempotencyKey: 'k-2' }), createMockContext());
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
        client.items.set('IDEM#ip:203.0.113.7|op|k-old|idem', {
            pk: { S: 'IDEM#ip:203.0.113.7|op|k-old' }, sk: { S: 'idem' },
            state: { S: 'done' }, statusCode: { N: '200' }, body: { S: '{"stale":true}' },
            expiresAt: { N: String(now - 10) },
        });

        const result = await lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: 'k-old' }), createMockContext());
        expect(runs).toBe(1);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ran:a');
    });

    it('refuses malformed keys with a 400 envelope', async () => {
        const lambder = build(new MemoryDdb());
        const result = await lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: 'x'.repeat(201) }), createMockContext());
        expect(result.statusCode).toBe(400);
    });

    it('fails open by default when DynamoDB is down: the handler still runs, without dedupe', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        client.failAll = true;
        const lambder = build(client, () => { runs += 1; });
        const call = () => lambder.render(createApiEvent('op', { value: 'a' }, { idempotencyKey: 'k-3' }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        expect(runs).toBe(2);
    });
});

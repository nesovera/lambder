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
import { LambderLocalFileSource } from '../src/core/LambderFiles.js';
import { LambderApiError, LAMBDER_REFUSAL_CODES } from '../src/shared/LambderApiError.js';
import { LambderDdbRateLimiter } from '../src/stores/LambderDdbRateLimiter.js';
import { LambderDdbIdempotency } from '../src/stores/LambderDdbIdempotency.js';
import { lambderGuard } from '../src/policies/LambderApiGuards.js';
import { lambderRateLimitKey } from '../src/policies/LambderApiRateLimits.js';
import { createApiEvent as createEnvelopeEvent, createMockContext } from './helpers.js';
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

const createApiEvent = (apiName: string, payload?: any, extra: Record<string, any> = {}): APIGatewayProxyEvent =>
    createEnvelopeEvent({ apiName, payload, ...extra });

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
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api' })
            .addApi('dup', testSchema, async (ctx, res) => res.api(null));
        expect(() => lambder.addApi('dup', testSchema as any, async (ctx, res) => res.api(null)))
            .toThrow(/duplicate API name "dup"/);
    });

    it('throws when options are declared with no policy configuration', () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api' });
        expect(() => lambder.addApi('x', { ...testSchema, rateLimit: 'nope' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/was configured at creation/);
    });

    it('throws on unknown rate-limit policy and unknown guard names', () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { real: { perMin: 5, per: 'ip', budget: 'perApi' } } }, guards: { realGuard: { handler: async () => {} } } });
        expect(() => lambder.addApi('a', { ...testSchema, rateLimit: 'fake' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/unknown rate-limit policy "fake"/);
        expect(() => lambder.addApi('b', { ...testSchema, guards: 'fakeGuard' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/unknown guard "fakeGuard"/);
    });

    it('rejects session-keyed policies on public APIs', () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { perUser: { perMin: 5, per: 'session', budget: 'perApi' } } } });
        expect(() => lambder.addApi('x', { ...testSchema, rateLimit: 'perUser' } as any, async (ctx, res) => res.api(null)))
            .toThrow(/requires addSessionApi/);
    });

    it('rejects the idempotency option when no idempotency store was configured', () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: { g: { handler: async () => {} } } });
        expect(() => lambder.addApi('x', { ...testSchema, idempotency: true } as any, async (ctx, res) => res.api(null)))
            .toThrow(/no idempotency store was configured/);
    });

    it('rejects policies with no window or no per', () => {
        const client = new MemoryDdb();
        expect(() => initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { bad: { per: 'ip' } as any } } }))
            .toThrow(/declares no window/);
        expect(() => initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { bad: { perMin: 1 } as any } } }))
            .toThrow(/needs per/);
    });

    it('rejects an unknown budget value', () => {
        const client = new MemoryDdb();
        expect(() => initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { bad: { perMin: 1, per: 'ip', budget: 'global' } as any } } }))
            .toThrow(/has budget "global"; use "perApi" \(default/);
    });

    it('rejects window overrides on a perPolicy policy (one shared counter has one set of limits)', () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
            limiter: makeLimiter(new MemoryDdb()),
            policies: { shared: { perMin: 5, per: 'ip', budget: 'perPolicy' } },
        } });
        expect(() => lambder.addApi('x', { ...testSchema, rateLimit: { shared: { perMin: 1 } } } as any, async (ctx, res) => res.api(null)))
            .toThrow(/overrides the windows of rate-limit policy "shared"/);
    });
});

describe('API policies - rate limiting', () => {
    it('refuses with a 429 envelope after the limit and stops calling the handler', async () => {
        let handlerRuns = 0;
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { tight: { perMin: 2, per: 'ip', budget: 'perApi' } },
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
        // The default is the standard refusal shape, so errorMessageHandlers
        // that read .content work for rate limits like for refuse().
        expect(JSON.parse(third.body || '{}').errorMessage).toEqual({ type: 'warning', code: 'lambder/rate-limited', content: 'Too many requests. Please try again later.' });
        // Retry-After is the exceeded window's reset, which the fixed window already knows.
        const retryAfter = Number(third.multiValueHeaders?.['Retry-After']?.[0]);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);
        expect(handlerRuns).toBe(2);
    });

    it('keys counters by a custom per function (e.g. per email)', async () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    perEmail: {
                        perMin: 1, budget: 'perApi',
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
        // A policy's own message inherits the framework code.
        expect(JSON.parse(blocked.body || '{}').errorMessage).toEqual({ type: 'warning', code: LAMBDER_REFUSAL_CODES.rateLimited, content: 'Too many attempts for this address.' });
    });

    it('a policy message with its own code keeps it (fill, not override)', async () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { coded: { perMin: 1, per: 'ip', errorMessage: { type: 'warning', code: 'EMAIL_CODE_RATE_LIMITED', content: 'Slow down.' } } },
            } })
            .addApi('coded', { ...testSchema, rateLimit: 'coded' }, async (ctx, res) => res.api({ result: 'ok' }));

        const call = () => lambder.render(createApiEvent('coded', { value: 'x' }), createMockContext());
        await call();
        expect(JSON.parse((await call()).body || '{}').errorMessage).toEqual({ type: 'warning', code: 'EMAIL_CODE_RATE_LIMITED', content: 'Slow down.' });
    });

    it('stacked policies are checked in order and any of them can refuse', async () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    loose: { perMin: 100, per: 'ip', budget: 'perApi' },
                    strict: { perMin: 1, per: 'ip', budget: 'perApi', errorMessage: { type: 'error', content: 'strict says no' } },
                },
            } })
            .addApi('stacked', { ...testSchema, rateLimit: ['loose', 'strict'] }, async (ctx, res) => res.api({ result: 'ok' }));

        const call = () => lambder.render(createApiEvent('stacked', { value: 'x' }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        const second = await call();
        expect(second.statusCode).toBe(429);
        expect(JSON.parse(second.body || '{}').errorMessage).toEqual({ type: 'error', code: 'lambder/rate-limited', content: 'strict says no' });
    });

    it('fails open when the limiter instance says so and DynamoDB is down', async () => {
        const client = new MemoryDdb();
        client.failAll = true;
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: { limiter: makeLimiter(client, true), policies: { p: { perMin: 1, per: 'ip', budget: 'perApi' } } } })
            .addApi('open', { ...testSchema, rateLimit: 'p' }, async (ctx, res) => res.api({ result: 'through' }));

        const result = await lambder.render(createApiEvent('open', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('through');
    });

    it('budget "perApi" (the default) gives each API its own counter', async () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
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

    it('budget "perPolicy" shares one counter across every API referencing the policy', async () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { shared: { perMin: 1, per: 'ip', budget: 'perPolicy' } },
            } })
            .addApi('first', { ...testSchema, rateLimit: 'shared' }, async (ctx, res) => res.api({ result: 'a' }))
            .addApi('second', { ...testSchema, rateLimit: 'shared' }, async (ctx, res) => res.api({ result: 'b' }));

        expect((await lambder.render(createApiEvent('first', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        // One combined budget: the first API's call consumed it for both.
        expect((await lambder.render(createApiEvent('second', { value: 'x' }), createMockContext())).statusCode).toBe(429);
    });

    it('the map form tunes a perApi policy per API: overrides merge over the policy windows and never touch other APIs', async () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { lookup: { perMin: 1, perHour: 2, per: 'ip' } },   // budget defaults to perApi, so it is tunable
            } })
            .addApi('tuned', { ...testSchema, rateLimit: { lookup: { perMin: 5, errorMessage: { type: 'warning', content: 'tuned says no' } } } }, async (ctx, res) => res.api({ result: 'a' }))
            .addApi('plain', { ...testSchema, rateLimit: 'lookup' }, async (ctx, res) => res.api({ result: 'b' }));

        const call = (api: string) => lambder.render(createApiEvent(api, { value: 'x' }), createMockContext());
        expect((await call('tuned')).statusCode).toBe(200);
        expect((await call('tuned')).statusCode).toBe(200);
        // perMin raised to 5, but the policy's perHour: 2 still applies (merge, not replace).
        const third = await call('tuned');
        expect(third.statusCode).toBe(429);
        expect(JSON.parse(third.body || '{}').errorMessage).toEqual({ type: 'warning', code: 'lambder/rate-limited', content: 'tuned says no' });
        // The plain API keeps the declared perMin: 1 on its own counter.
        expect((await call('plain')).statusCode).toBe(200);
        expect((await call('plain')).statusCode).toBe(429);
    });

    it('the map form may override errorMessage on a perPolicy policy (text is per API, the counter is not)', async () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { shared: { perMin: 1, per: 'ip', budget: 'perPolicy' } },
            } })
            .addApi('first', { ...testSchema, rateLimit: { shared: { errorMessage: { type: 'error', content: 'first is closed' } } } }, async (ctx, res) => res.api({ result: 'a' }))
            .addApi('second', { ...testSchema, rateLimit: { shared: true } }, async (ctx, res) => res.api({ result: 'b' }));

        expect((await lambder.render(createApiEvent('second', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        const blocked = await lambder.render(createApiEvent('first', { value: 'x' }), createMockContext());
        expect(blocked.statusCode).toBe(429);
        expect(JSON.parse(blocked.body || '{}').errorMessage).toEqual({ type: 'error', code: 'lambder/rate-limited', content: 'first is closed' });
    });

    it('stacked policies charge every counter checked before the refusing one (attempts count)', async () => {
        const client = new MemoryDdb();
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(client),
                policies: {
                    ipWide: { perMin: 100, per: 'ip', budget: 'perApi' },
                    tight: { perMin: 1, per: 'ip', budget: 'perApi' },
                },
            } })
            .addApi('stacked', { ...testSchema, rateLimit: ['ipWide', 'tight'] }, async (ctx, res) => res.api({ result: 'ok' }));

        const call = () => lambder.render(createApiEvent('stacked', { value: 'x' }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(429);
        const ipWideCount = [...client.items.entries()].find(([k]) => k.includes('|ipWide|'))?.[1].count?.N;
        expect(ipWideCount).toBe('2');
    });
});

describe('API policies - requireSessionApiGuards', () => {
    /** An app's authorization vocabulary, plus the named opt-out. */
    const guards = {
        orgPermission: lambderGuard({
            session: true,
            handler: (_ctx, _payload, _res, permission: string) => ({ permission }),
        }),
        // The named opt-out: the session itself is the whole authorization.
        sessionOnly: lambderGuard({ session: true, handler: () => {} }),
    };
    const strict = () => initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards, requireSessionApiGuards: true });

    it('refuses a session API that declares no guards, at registration', () => {
        expect(() => strict().addSessionApi('secure.forgot', { ...testSchema } as any, async (ctx, res) => res.api(null)))
            .toThrow(/"secure.forgot" declares no guards/);
    });

    it('accepts a session API that declares a guard, or the named opt-out', () => {
        expect(() => strict()
            .addSessionApi('secure.admin', { ...testSchema, guards: { orgPermission: 'ORG.MANAGE' } }, async (ctx, res) => res.api(null))
            .addSessionApi('secure.me', { ...testSchema, guards: 'sessionOnly' }, async (ctx, res) => res.api(null)))
            .not.toThrow();
    });

    it('leaves public APIs alone: authorization there is not a session concern', () => {
        expect(() => strict().addApi('public.ping', { ...testSchema }, async (ctx, res) => res.api(null))).not.toThrow();
    });

    it('needs a guards map to declare from', () => {
        expect(() => initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', requireSessionApiGuards: true }))
            .toThrow(/needs a guards map/);
    });

    it('is off by default: a session API without guards still registers', () => {
        const relaxed = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards });
        expect(() => relaxed.addSessionApi('secure.free', { ...testSchema }, async (ctx, res) => res.api(null))).not.toThrow();
    });

    it('makes a missing guards declaration a compile error', () => {
        const lambder = strict();
        // @ts-expect-error guards is required on this instance
        const missing = () => lambder.addSessionApi('secure.typed', { ...testSchema }, async (ctx, res) => res.api(null));
        expect(missing).toThrow(/declares no guards/);
        // The declaration keeps its typing: the guard's output lands on ctx.guardData.
        lambder.addSessionApi('secure.typedOk', { ...testSchema, guards: { orgPermission: 'ORG.READ' } }, async (ctx, res) => {
            const permission: string = ctx.guardData.orgPermission.permission;
            return res.api({ result: permission });
        });
    });
});

describe('API policies - requirePublicApiGuards', () => {
    /** A public surface's vocabulary: a real control, plus the two named opt-outs. */
    const guards = {
        deviceToken: lambderGuard({
            apiInput: z.object({ value: z.string() }),
            handler: (_ctx, { value }) => ({ deviceId: value }),
        }),
        // Anyone may call, and the param records why.
        open: lambderGuard({ handler: (_ctx, _payload, _res, _reason: string) => {} }),
        // The endpoint establishes identity; the handler proves what it needs.
        credentialFlow: lambderGuard({ handler: () => {} }),
    };
    const strict = () => initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards, requirePublicApiGuards: true });

    it('refuses a public API that declares no guards, at registration', () => {
        expect(() => strict().addApi('public.forgot', { ...testSchema } as any, async (ctx, res) => res.api(null)))
            .toThrow(/public API "public\.forgot" declares no guards/);
    });

    it('accepts a public API that declares a guard, or either named opt-out', () => {
        expect(() => strict()
            .addApi('public.device', { ...testSchema, guards: 'deviceToken' }, async (ctx, res) => res.api(null))
            .addApi('public.translations', { ...testSchema, guards: { open: 'Static strings already in the bundle.' } }, async (ctx, res) => res.api(null))
            .addApi('public.login', { ...testSchema, guards: 'credentialFlow' }, async (ctx, res) => res.api(null)))
            .not.toThrow();
    });

    it('leaves session APIs alone: the two requirements are independent', () => {
        // requireSessionApiGuards is off on this instance, so a session API
        // without guards still registers.
        expect(() => strict().addSessionApi('secure.free', { ...testSchema }, async (ctx, res) => res.api(null))).not.toThrow();
    });

    it('is off by default: a public API without guards still registers', () => {
        const relaxed = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards });
        expect(() => relaxed.addApi('public.free', { ...testSchema }, async (ctx, res) => res.api(null))).not.toThrow();
    });

    it('needs a guards map to declare from', () => {
        expect(() => initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', requirePublicApiGuards: true }))
            .toThrow(/needs a guards map/);
    });

    it('makes a missing guards declaration a compile error', () => {
        const lambder = strict();
        // @ts-expect-error guards is required on this instance
        const missing = () => lambder.addApi('public.typed', { ...testSchema }, async (ctx, res) => res.api(null));
        expect(missing).toThrow(/declares no guards/);
        // The declaration keeps its typing: the guard's output lands on ctx.guardData.
        lambder.addApi('public.typedOk', { ...testSchema, guards: 'deviceToken' }, async (ctx, res) => {
            const deviceId: string = ctx.guardData.deviceToken.deviceId;
            return res.api({ result: deviceId });
        });
    });

    it('holds both requirements at once when both flags are on', () => {
        const both = initLambder().create({
            files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api',
            guards: { ...guards, sessionOnly: lambderGuard({ session: true, handler: () => {} }) },
            requireSessionApiGuards: true, requirePublicApiGuards: true,
        });
        expect(() => both.addApi('public.a', { ...testSchema } as any, async (ctx, res) => res.api(null)))
            .toThrow(/public API "public\.a" declares no guards/);
        expect(() => both.addSessionApi('secure.a', { ...testSchema } as any, async (ctx, res) => res.api(null)))
            .toThrow(/session API "secure\.a" declares no guards/);
    });
});

describe('API policies - an empty guards option declares nothing', () => {
    // The one shape that turns a mandatory authorization declaration back into
    // an optional one: the option is present, so the required-field check
    // passes, and it normalizes to zero entries, so no guard runs.
    const guards = {
        orgPermission: lambderGuard({ session: true, handler: (_ctx, _p, _r, permission: string) => ({ permission }) }),
        sessionOnly: lambderGuard({ session: true, handler: () => {} }),
        open: lambderGuard({ handler: (_ctx, _payload, _res, _reason: string) => {} }),
    };
    const strict = () => initLambder().create({
        files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards,
        requireSessionApiGuards: true, requirePublicApiGuards: true,
    });

    it('refuses an empty guards map at registration', () => {
        expect(() => strict().addSessionApi('secure.empty', { ...testSchema, guards: {} } as any, async (ctx, res) => res.api(null)))
            .toThrow(/declares an empty guards option/);
    });

    it('refuses an empty guards list at registration', () => {
        expect(() => strict().addApi('public.empty', { ...testSchema, guards: [] } as any, async (ctx, res) => res.api(null)))
            .toThrow(/declares an empty guards option/);
    });

    it('refuses an empty option even where guards are not required', () => {
        // Not just a hole in the require* flags: an empty declaration reads as
        // an authorization decision and is not one, whoever writes it.
        const relaxed = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards });
        expect(() => relaxed.addApi('public.emptyToo', { ...testSchema, guards: {} } as any, async (ctx, res) => res.api(null)))
            .toThrow(/declares an empty guards option/);
    });

    it('rejects the empty forms at the type level', () => {
        const lambder = strict();
        // @ts-expect-error an empty guards map declares no guard
        expect(() => lambder.addSessionApi('secure.t1', { ...testSchema, guards: {} }, async (ctx, res) => res.api(null))).toThrow();
        // @ts-expect-error an empty guards list declares no guard
        expect(() => lambder.addSessionApi('secure.t2', { ...testSchema, guards: [] }, async (ctx, res) => res.api(null))).toThrow();
    });

    it('rejects a named guard with an undefined param at the type level', () => {
        // Requiring the chosen key (rather than leaving every key optional)
        // is what rejects this: an optional property accepts undefined, and
        // the guard would then run with an undefined param and fail inside its
        // own handler, at request time, as a 500 rather than a refusal.
        //
        // Registration itself does NOT throw here: the option normalizes to
        // one entry naming a real guard, and a guard whose param is legitimately
        // optional would be indistinguishable. The type is the whole check.
        const lambder = strict();
        // @ts-expect-error a named guard with an undefined param is not a declaration
        expect(() => lambder.addSessionApi('secure.t3', { ...testSchema, guards: { orgPermission: undefined } }, async (ctx, res) => res.api(null)))
            .not.toThrow();
    });

    it('still accepts every non-empty form', () => {
        expect(() => strict()
            .addSessionApi('secure.one', { ...testSchema, guards: 'sessionOnly' }, async (ctx, res) => res.api(null))
            .addSessionApi('secure.list', { ...testSchema, guards: ['sessionOnly'] }, async (ctx, res) => res.api(null))
            .addSessionApi('secure.map', { ...testSchema, guards: { orgPermission: 'ORG.READ' } }, async (ctx, res) => res.api(null))
            .addSessionApi('secure.both', { ...testSchema, guards: { sessionOnly: true, orgPermission: 'ORG.READ' } }, async (ctx, res) => res.api(null))
            .addApi('public.open', { ...testSchema, guards: { open: 'Nothing here is anybody\'s.' } }, async (ctx, res) => res.api(null)))
            .not.toThrow();
    });
});

describe('API policies - guards', () => {
    it('a refusing guard blocks before validation and before the handler', async () => {
        let handlerRan = false;
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: {
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: {
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: {
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    perEmail: {
                        perMin: 5, budget: 'perApi',
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

    it('preflight slices (rate-limit keys, guard inputs) answer through setApiInputValidationErrorHandler like the API schema', async () => {
        const seen: string[] = [];
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api',
                rateLimits: {
                    limiter: makeLimiter(new MemoryDdb()),
                    policies: {
                        perEmail: { perMin: 5, budget: 'perApi', per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }) },
                    },
                },
                guards: {
                    captcha: lambderGuard({ guardInput: z.object({ token: z.string() }), handler: async () => {} }),
                },
            })
            .setApiInputValidationErrorHandler((ctx, res, zodError) => {
                seen.push(zodError.issues[0]?.path.join('.') ?? '');
                return res.api(null, { errorMessage: { type: 'error', content: 'bad input' } }, { statusCode: 400 });
            })
            .addApi('keyed', { ...testSchema, rateLimit: 'perEmail' }, async (ctx, res) => res.api({ result: 'ok' }))
            .addApi('guarded', { ...testSchema, guards: 'captcha' }, async (ctx, res) => res.api({ result: 'ok' }))
            .addApi('plain', testSchema, async (ctx, res) => res.api({ result: 'ok' }));

        for(const event of [
            createApiEvent('keyed', { value: 'x' }),                        // rate-limit key slice: email missing
            createApiEvent('guarded', { value: 'x' }, { guardInputs: { captcha: {} } }),  // guardInput slice: token missing
            createApiEvent('plain', {}),                                     // the API's own schema: value missing
        ]){
            const result = await lambder.render(event, createMockContext());
            expect(result.statusCode).toBe(400);
            expect(JSON.parse(result.body || '{}').errorMessage).toEqual({ type: 'error', content: 'bad input' });
        }
        expect(seen).toEqual(['email', 'token', 'value']);
    });

    it('guards run in declared order and passing guards let the handler run', async () => {
        const order: string[] = [];
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: {
                first: { handler: async () => { order.push('first'); } },
                second: { handler: async () => { order.push('second'); } },
            } })
            .addApi('ordered', { ...testSchema, guards: ['first', 'second'] }, async (ctx, res) => res.api({ result: 'ran' }));

        const result = await lambder.render(createApiEvent('ordered', { value: 'x' }), createMockContext());
        expect(order).toEqual(['first', 'second']);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ran');
    });

    it("a guard's return value lands typed on ctx.guardData under its name", async () => {
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: {
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: {
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: {
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', guards: {
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
        initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', idempotency: { store: makeStore(client) } })
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { tight: { perMin: 1, per: 'ip', budget: 'perApi' } },
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', idempotency: { store: makeStore(client) } })
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } })
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } })
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } })
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
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } })
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

    it('compression: false stores every body plain, { minBytes } moves the threshold, and either shape reads back', async () => {
        const big = JSON.stringify({ payload: { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${i}` })) } });
        const settle = async (store: LambderDdbIdempotency, scope: string, body: string) => {
            const claim = await store.begin(scope, { pendingTtlSeconds: 300 });
            if(claim.state !== 'new') throw new Error('expected fresh claim');
            expect(await store.complete(scope, claim.ownerToken, { statusCode: 200, headers: {}, body, ttlSeconds: 60 })).toBe('stored');
        };

        const offClient = new MemoryDdb();
        await settle(new LambderDdbIdempotency({ tableName: 'test-table', client: offClient, compression: false }), 'scope-off', big);
        expect(offClient.items.get('IDEM#scope-off|idem')?.body?.S).toBe(big);
        expect(offClient.items.get('IDEM#scope-off|idem')?.bodyBr).toBe(undefined);
        // Switched back on: the plain record still reads.
        expect((await makeStore(offClient).peek('scope-off'))?.body).toBe(big);

        const alwaysClient = new MemoryDdb();
        await settle(new LambderDdbIdempotency({ tableName: 'test-table', client: alwaysClient, compression: { minBytes: 0 } }), 'scope-always', 'tiny');
        expect(alwaysClient.items.get('IDEM#scope-always|idem')?.bodyBr?.B).toBeDefined();
        // Switched off: the compressed record still reads.
        const offReader = new LambderDdbIdempotency({ tableName: 'test-table', client: alwaysClient, compression: false });
        expect((await offReader.peek('scope-always'))?.body).toBe('tiny');

        expect(() => new LambderDdbIdempotency({ tableName: 'test-table', client: offClient, compression: { quality: 12 } })).toThrow();
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
        expect(JSON.parse(result.body || '{}').errorMessage).toEqual({ type: 'warning', code: 'lambder/duplicate-in-flight', content: 'This request is already being processed.' });
    });

    it('releases the claim when the handler crashes, so a retry re-executes', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        const lambder = initLambder().create({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api', idempotency: { store: makeStore(client) } })
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

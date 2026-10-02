/**
 * Declarative API policies: rate limits, guards, idempotency, and the
 * registration-time assertions (duplicate names, unknown references,
 * session-keyed policies on public APIs, options without their enable call).
 */

import { describe, it, expect, vi } from 'vitest';
import nodeCrypto from 'crypto';
import { z } from 'zod';
import Lambder, { initLambder } from '../../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderApiRefusal, LAMBDER_REFUSAL_CODES } from '../../src/shared/wire/LambderApiRefusal.js';
import { LambderDdbRateLimiter } from '../../src/stores/LambderDdbRateLimiter.js';
import { LambderDdbIdempotencyStore } from '../../src/stores/LambderDdbIdempotencyStore.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import type { LambderRateLimiter, LambderRateLimitPolicy } from '../../src/shared/contracts/LambderRateLimiter.js';
import { lambderGuard, lambderRateLimitKey } from '../../src/core/LambderPolicyBuilders.js';
import { LambderResponse } from '../../src/core/LambderResponse.js';
import { canonicalJson } from '../../src/shared/util/canonicalJson.js';
import { joinKeyFields } from '../../src/shared/util/joinKeyFields.js';
import { lambderTestApp } from '../../src/testing.js';
import { createApiEvent as createEnvelopeEvent, createMockContext, MemoryDdb, testPublicFiles } from '../helpers.js';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const createApiEvent = (apiName: string, payload?: any, extra: Record<string, any> = {}): APIGatewayProxyEvent =>
    createEnvelopeEvent({ apiName, payload, ...extra });

const testSchema = {
    input: z.object({ value: z.string() }),
    output: z.object({ result: z.string() }),
};

/**
 * A caller's field as an app with no session salt writes it into a store key,
 * computed the way a reader of the table would: the plain SHA-256 of the kind
 * and the value joined.
 */
const unkeyedFieldDigest = (kind: string, value: string): string =>
    `${kind}:${nodeCrypto.createHash('sha256').update(joinKeyFields(kind, value), 'utf8').digest('hex')}`;

/** The same field in an app with a session salt: an HMAC under the subkey HKDF derives from the salt for this purpose alone. */
const keyedFieldDigest = (salt: string, kind: string, value: string): string => {
    const subkey = Buffer.from(nodeCrypto.hkdfSync('sha256', salt, Buffer.alloc(0), 'lambder/key-field-digest', 32));
    return `${kind}:${nodeCrypto.createHmac('sha256', subkey).update(joinKeyFields(kind, value), 'utf8').digest('hex')}`;
};

const makeLimiter = (client: MemoryDdb) =>
    new LambderDdbRateLimiter({ tableName: "test-table", client });
const makeStore = (client: MemoryDdb) =>
    new LambderDdbIdempotencyStore({ tableName: "test-table", client });

describe('API policies - registration assertions', () => {
    it('throws on duplicate API names', () => {
        // A group's actions are the keys of one object, so a name is claimed
        // twice only by registering a second group of the same name.
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', { dup: app.defineApi(testSchema, async (ctx) => ({ result: 'ok' })) }));
        expect(() => lambder.registerApiGroups(lambder.defineApiGroup('test', { dup: lambder.defineApi(testSchema as any, async (ctx) => null) })))
            .toThrow(/group "test" is registered twice/);
    });

    it('throws when options are declared with no policy configuration', () => {
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { x: app.defineApi({ ...testSchema, rateLimit: 'nope' } as any, async (ctx) => null) })))
            .toThrow(/was configured at creation/);
    });

    it('rejects an option key the type does not have, so a typo cannot disable a flag in silence', () => {
        // create() infers `const TOptions` from the literal, which switches
        // excess-property checking off for the whole object. Without the
        // surplus-key mapping these compile and are dropped: the app then runs
        // with requireApiGuards OFF, which is the one flag whose whole job is
        // to make a missing authorization declaration a compile error.
        initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            // @ts-expect-error requireApiGuard is not an option; the flag has a trailing "s"
            requireApiGuard: true,
        });
        initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            // @ts-expect-error maxResponseByte is not an option; the option is maxResponseBytes
            maxResponseByte: 100,
        });
        // The correct spellings still compile, and still narrow the instance.
        expect(() => initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            guards: { signedIn: { handler: async () => {} } },
            requireApiGuards: true,
            maxResponseBytes: 100,
        })).not.toThrow();
    });

    it('throws on unknown rate-limit policy and unknown guard names', () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { real: { perMin: 5, per: 'ip', budget: 'perApi' } } }, guards: { realGuard: { handler: async () => {} } } });
        expect(() => app.registerApiGroups(app.defineApiGroup('policy', { unknown: app.defineApi({ ...testSchema, rateLimit: 'fake' } as any, async (ctx) => null) })))
            .toThrow(/unknown rate-limit policy "fake"/);
        expect(() => app.registerApiGroups(app.defineApiGroup('guard', { unknown: app.defineApi({ ...testSchema, guards: 'fakeGuard' } as any, async (ctx) => null) })))
            .toThrow(/unknown guard "fakeGuard"/);
    });

    it('rejects an empty rateLimit option, the way it rejects an empty guards option', () => {
        // Declaring the option is declaring a limit. Registered, these three
        // forms would announce a rate limit and enforce none, the one shape
        // that quietly turns a mandatory declaration back into an optional one.
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { real: { perMin: 5, per: 'ip', budget: 'perApi' } } } });
        for(const rateLimit of [{}, [], { real: undefined }]){
            expect(() => app.registerApiGroups(app.defineApiGroup('empty', { limited: app.defineApi({ ...testSchema, rateLimit } as any, async (ctx) => null) })))
                .toThrow(/declares an empty rateLimit option/);
        }
        // The failed registrations above did not burn their names either.
        expect(() => app.registerApiGroups(app.defineApiGroup('empty', { limited: app.defineApi({ ...testSchema, rateLimit: 'real' } as any, async (ctx) => ({ result: 'ok' })) })))
            .not.toThrow();
    });

    it('rejects an override that takes away the policy last enforced window', () => {
        // A policy must declare a window; an override may not undo that. Zero
        // is a legal window value (it leaves that one unenforced), so zeroing
        // the only one would pass every check and disable the policy silently.
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { real: { perMin: 5, per: 'ip', budget: 'perApi' } } } });
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { zeroed: app.defineApi({ ...testSchema, rateLimit: { real: { perMin: 0 } } } as any, async (ctx) => null) })))
            .toThrow(/down to no enforced window/);
    });

    it('rejects a replay window a store cannot act on', () => {
        // NaN is the one that matters: it survives every comparison an
        // expiry test makes, so an in-memory record with a NaN expiry outlives
        // every sweep, while DynamoDB rejects the same number outright.
        const create = (defaultTtlSeconds: number) => initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            idempotency: { store: new LambderDdbIdempotencyStore({ tableName: 't', region: 'us-east-1' }), defaultTtlSeconds },
        });
        for(const bad of [NaN, 0, -5, 1.5, Infinity]){
            expect(() => create(bad)).toThrow(/replay window in whole seconds\) must be a positive integer/);
        }

        const app = create(60);
        expect(() => app.registerApiGroups(app.defineApiGroup('bad', { ttl: app.defineApi({ ...testSchema, idempotency: { ttlSeconds: NaN } } as any, async (ctx) => null) })))
            .toThrow(/replay window in whole seconds\) must be a positive integer/);
    });

    it('lets an API opt out of idempotency without a store configured', () => {
        // `idempotency: false` asks for nothing, so it needs nothing behind it.
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api' });
        expect(() => app.registerApiGroups(app.defineApiGroup('opted', { out: app.defineApi({ ...testSchema, idempotency: false } as any, async (ctx) => ({ result: 'ok' })) })))
            .not.toThrow();
    });

    it('keeps a completed answer when the store cannot record it, rather than 500ing the caller', async () => {
        // Settling happens AFTER the handler ran, so failing closed there
        // cannot prevent anything: it would turn a completed operation into a
        // 500 and hand the retry a released claim, which is exactly the double
        // execution idempotency exists to prevent.
        const store = new LambderMemoryIdempotencyStore();
        store.complete = async () => { throw new Error('store unavailable'); };
        let runs = 0;
        const app = initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            idempotency: { store, failOpen: false },
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('payments', {
            charge: app.defineApi({ ...testSchema, idempotency: true } as any, async (ctx) => {
                runs += 1;
                return { result: 'charged' };
            }),
        }));

        const call = () => lambder.render(createApiEvent('payments.charge', { value: 'v' }, { idempotencyKey: 'key-abcdefabcdefabcd' }), {} as any);
        const first = await call();

        expect(runs).toBe(1);
        expect(first.statusCode).toBe(200);
        expect(String(first.body)).toContain('charged');
    });

    it('replays an answer whose store write landed though complete() reported a failure, rather than charging twice', async () => {
        // Regression: after a complete() that threw, the engine releases the
        // claim, and abandon() deleted on the owner token alone, which the
        // stored record still carries. A write that landed and whose response
        // was then lost (a timeout on the SDK's last attempt) lost its record
        // too, and the client's retry placed the charge again.
        const store = new LambderMemoryIdempotencyStore();
        const storeRecord = store.complete.bind(store);
        store.complete = async (...args) => {
            await storeRecord(...args);
            throw new Error('socket timed out after the write was applied');
        };
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let runs = 0;
        const app = initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            idempotency: { store },
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('payments', {
            charge: app.defineApi({ ...testSchema, idempotency: true } as any, async (ctx) => {
                runs += 1;
                return { result: `charge-${runs}` };
            }),
        }));

        const call = () => lambder.render(createApiEvent('payments.charge', { value: 'v' }, { idempotencyKey: 'key-abcdefabcdefabcd' }), createMockContext());
        try {
            const first = await call();
            const retry = await call();

            expect(runs).toBe(1);
            expect(retry.body).toBe(first.body);
            expect(String(retry.body)).toContain('charge-1');
            expect(warned).toHaveBeenCalledOnce();
        } finally {
            warned.mockRestore();
        }
    });

    it('scopes a public API replay by callerIdentity, so a key is not a bearer token for its answer', async () => {
        // The replay is served BEFORE guards run, so on a public API whose
        // authorization is a guard, a second caller presenting a known key
        // would get the first caller's response body without the guard being
        // consulted at all.
        const store = new LambderMemoryIdempotencyStore();
        const app = initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            idempotency: {
                store,
                callerIdentity: (_ctx, request) => (request.guardInputs as any)?.device?.token ?? null,
            },
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('devices', {
            report: app.defineApi({ ...testSchema, idempotency: true } as any, async (ctx) => ({ result: `for-${(ctx.api?.guardInputs as any)?.device?.token}` })),
        }));

        const call = (token: string) => lambder.render(
            createApiEvent('devices.report', { value: 'v' }, { idempotencyKey: 'key-abcdefabcdefabcd', guardInputs: { device: { token } } }),
            createMockContext(),
        );

        const first = await call('device-one');
        expect(String(first.body)).toContain('for-device-one');

        // Same key, different caller: its own scope, so its own execution.
        const other = await call('device-two');
        expect(String(other.body)).toContain('for-device-two');

        // Same key, same caller: the stored answer.
        const replay = await call('device-one');
        expect(String(replay.body)).toContain('for-device-one');
    });

    it('rejects session-keyed policies on public APIs', () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { perUser: { perMin: 5, per: 'session', budget: 'perApi' } } } });
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { x: app.defineApi({ ...testSchema, rateLimit: 'perUser' } as any, async (ctx) => null) })))
            .toThrow(/counts per session, and none of its guards needs a session/);
    });

    it('keeps counters apart when a name or key carries the separator itself', async () => {
        // A shared budget's tracker key joins policy|<policyName>|<key> with a
        // pipe, and both of those can contain one (an endpoint name cannot,
        // being two identifiers). Varying only the LAST field proves nothing,
        // because a trailing field cannot absorb a boundary: the collision
        // needs two fields to shift across it, which is what this pair does.
        // A custom key is recorded as "custom:<value>", so unescaped, both of
        // these build the identical string "policy|x|custom:y|custom:k" and
        // share one counter, and the second API's very first call would be
        // refused by the first API's.
        const limiter = makeLimiter(new MemoryDdb());
        const keyFromPayload = lambderRateLimitKey({ handler: (ctx) => String((ctx.post as any).payload.value) });
        const app = initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            rateLimits: { limiter, policies: {
                x: { perMin: 1, budget: 'perPolicy', per: keyFromPayload },
                'x|custom:y': { perMin: 1, budget: 'perPolicy', per: keyFromPayload },
            } },
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            first: app.defineApi({ ...testSchema, rateLimit: 'x' } as any, async (_ctx) => ({ result: 'ok' })),
            second: app.defineApi({ ...testSchema, rateLimit: 'x|custom:y' } as any, async (_ctx) => ({ result: 'ok' })),
        }));

        const call = (apiName: string, value: string) => lambder.render(createApiEvent(apiName, { value }), createMockContext());

        expect((await call('test.first', 'y|custom:k')).statusCode).toBe(200);
        expect((await call('test.second', 'k')).statusCode).toBe(200);
        // Each still holds its own limit of one.
        expect((await call('test.first', 'y|custom:k')).statusCode).toBe(429);
        expect((await call('test.second', 'k')).statusCode).toBe(429);
        // And a key carrying the separator stays its own counter too.
        expect((await call('test.second', 'a|b')).statusCode).toBe(200);
        expect((await call('test.second', 'a')).statusCode).toBe(200);
    });

    it('does not mistake an inherited object property for a registered guard or policy', () => {
        // The registration check exists to catch a typo in a name. A plain
        // object answers for "toString" through its prototype, so a name like
        // that would pass the check and then crash on every request.
        const app = initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            guards: { real: { handler: async () => {} } },
            rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { real: { perMin: 5, per: 'ip' } } },
        });

        expect(() => app.registerApiGroups(app.defineApiGroup('guard', { inherited: app.defineApi({ ...testSchema, guards: 'toString' } as any, async (ctx) => null) })))
            .toThrow(/unknown guard "toString"/);
        expect(() => app.registerApiGroups(app.defineApiGroup('policy', { inherited: app.defineApi({ ...testSchema, rateLimit: 'constructor' } as any, async (ctx) => null) })))
            .toThrow(/unknown rate-limit policy "constructor"/);
    });

    it('lets a guard be named after an inherited object property', () => {
        // The other half: the duplicate check must not reject a name only
        // because Object.prototype happens to carry it.
        const app = initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            guards: { toString: { handler: async () => {} } },
        });

        expect(() => app.registerApiGroups(app.defineApiGroup('test', { a: app.defineApi({ ...testSchema, guards: 'toString' } as any, async (ctx) => null) })))
            .not.toThrow();
    });

    it('hands a guard named after an inherited property nothing when the client sent nothing', async () => {
        // guardInputs is client data, so a guard may be named for anything
        // Object.prototype carries. Read with a plain property access, a guard
        // named "toString" would receive the INHERITED FUNCTION where the
        // client sent no value at all, so a check for "no token was presented"
        // would see a truthy value and never fire. The name is the client's to
        // choose, so this is the read's problem rather than the name's.
        const seen: unknown[] = [];
        const app = initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            guards: {
                toString: {
                    guardInput: z.string().optional(),
                    handler: async (_ctx: unknown, presented: unknown) => { seen.push(presented); },
                },
            },
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            needsToken: app.defineApi({ ...testSchema, guards: 'toString' } as any, async (ctx) => null),
        }));

        // No guardInputs at all, then a map that names other guards only.
        await lambder.render(createApiEvent('test.needsToken', { value: 'v' }), createMockContext());
        await lambder.render(createApiEvent('test.needsToken', { value: 'v' }, { guardInputs: { somethingElse: 'x' } }), createMockContext());

        expect(seen).toEqual([undefined, undefined]);
        expect(seen.some((value) => typeof value === 'function')).toBe(false);
    });

    it('rejects a window limit a limiter could not act on, at creation and on an override', () => {
        const build = (policies: any) => () => initLambder().create({
            files: testPublicFiles(), apiPath: '/api',
            rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies },
        });
        expect(build({ bad: { perMin: -1, per: 'ip' } })).toThrow(/caps perMin at -1/);
        expect(build({ bad: { perMin: 1.5, per: 'ip' } })).toThrow(/caps perMin at 1.5/);
        expect(build({ ok: { perMin: 0, perHour: 5, per: 'ip' } })).not.toThrow();

        const app = build({ tight: { perMin: 5, per: 'ip' } })();
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { x: app.defineApi({ ...testSchema, rateLimit: { tight: { perMin: -3 } } } as any, async (ctx) => null) })))
            .toThrow(/caps perMin at -3/);
    });

    it('rejects the idempotency option when no idempotency store was configured', () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: { g: { handler: async () => {} } } });
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { x: app.defineApi({ ...testSchema, idempotency: true } as any, async (ctx) => null) })))
            .toThrow(/no idempotency store was configured/);
    });

    it('rejects policies with no window or a per it cannot key by', () => {
        const client = new MemoryDdb();
        expect(() => initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { bad: { per: 'ip' } as any } } }))
            .toThrow(/declares no window/);
        expect(() => initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { bad: { perMin: 1, per: 'email' } as any } } }))
            .toThrow(/has a per that is not "ip", "session", or a \{ apiInput\?, handler \} key/);
    });

    it('takes a policy without per, and refuses an API that names it, since only a handler knows its key', () => {
        const client = new MemoryDdb();
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { invitesPerRecipient: { perMonth: 3 } } } });
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { invite: app.defineApi({ ...testSchema, rateLimit: 'invitesPerRecipient' } as any, async (ctx) => null) })))
            .toThrow(/declares no per: its key is the one a handler passes to ctx.rateLimit\("invitesPerRecipient", key\)/);
    });

    it('rejects an unknown budget value', () => {
        const client = new MemoryDdb();
        expect(() => initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { bad: { perMin: 1, per: 'ip', budget: 'global' } as any } } }))
            .toThrow(/has budget "global"; use "perApi" \(default/);
    });

    it('rejects window overrides on a perPolicy policy (one shared counter has one set of limits)', () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
            limiter: makeLimiter(new MemoryDdb()),
            policies: { shared: { perMin: 5, per: 'ip', budget: 'perPolicy' } },
        } });
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { x: app.defineApi({ ...testSchema, rateLimit: { shared: { perMin: 1 } } } as any, async (ctx) => null) })))
            .toThrow(/overrides the windows of rate-limit policy "shared"/);
    });
});

describe('API policies - rate limiting', () => {
    it('refuses with a 429 envelope after the limit and stops calling the handler', async () => {
        let handlerRuns = 0;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { tight: { perMin: 2, per: 'ip', budget: 'perApi' } },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            limited: app.defineApi({ ...testSchema, rateLimit: 'tight' }, async (ctx) => {
                handlerRuns += 1;
                return { result: 'ok' };
            }),
        }));

        const call = () => lambder.render(createApiEvent('test.limited', { value: 'x' }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        const third = await call();
        expect(third.statusCode).toBe(429);
        // Retry-After is the exceeded window's reset, which the fixed window already knows.
        const retryAfter = Number(third.multiValueHeaders?.['Retry-After']?.[0]);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);
        // The default is the standard refusal shape, so refusalHandlers that
        // read .content work for rate limits like for refuse(), and its data
        // names the policy and the same wait the header gives.
        expect(JSON.parse(third.body || '{}').refusal).toEqual({
            type: 'warning', code: 'lambder/rate-limited', content: 'Too many requests. Please try again later.',
            data: { policy: 'tight', retryAfterSeconds: retryAfter },
        });
        expect(handlerRuns).toBe(2);
    });

    it('keys counters by a custom per function (e.g. per email)', async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    perEmail: {
                        perMin: 1, budget: 'perApi',
                        per: lambderRateLimitKey({
                            apiInput: z.object({ value: z.string() }),
                            handler: (_ctx, { value }) => value,
                        }),
                        refusal: { type: 'warning', content: 'Too many attempts for this address.' },
                    },
                },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            code: app.defineApi({ ...testSchema, rateLimit: 'perEmail' }, async (ctx) => ({ result: 'sent' })),
        }));

        const call = (value: string) => lambder.render(createApiEvent('test.code', { value }), createMockContext());
        expect((await call('a@x.com')).statusCode).toBe(200);
        expect((await call('b@x.com')).statusCode).toBe(200);   // different bucket
        const blocked = await call('a@x.com');
        expect(blocked.statusCode).toBe(429);
        // A policy's own message inherits the framework code and data.
        expect(JSON.parse(blocked.body || '{}').refusal).toEqual({
            type: 'warning', code: LAMBDER_REFUSAL_CODES.rateLimited, content: 'Too many attempts for this address.',
            data: { policy: 'perEmail', retryAfterSeconds: expect.any(Number) },
        });
    });

    it('writes a custom key as its digest at any length, so no email reaches the table and a store with a key limit still meters it', async () => {
        // A store refuses a key it cannot take by throwing, and a throw is
        // what failOpen swallows: unbounded, a 3,000-character payload field
        // would turn the whole policy off in silence, every window of it, with
        // the request going through unmetered. And a short one written as it
        // is puts the caller's email in the table. The digest answers both,
        // and keeps distinct callers on distinct counters.
        const trackerKeys: string[] = [];
        const counters = new LambderMemoryRateLimiter();
        const recording: LambderRateLimiter = {
            isRateLimited: async (trackerKey: string, policy: LambderRateLimitPolicy) => {
                trackerKeys.push(trackerKey);
                return await counters.isRateLimited(trackerKey, policy);
            },
        };
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: recording,
                policies: {
                    perEmail: {
                        perMin: 1, budget: 'perApi',
                        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }),
                    },
                },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            code: app.defineApi({ input: z.object({ value: z.string(), email: z.string() }), output: testSchema.output, rateLimit: 'perEmail' }, async (ctx) => ({ result: 'ok' })),
        }));

        const call = (email: string) => lambder.render(createApiEvent('test.code', { value: 'x', email }), createMockContext());
        const longA = `${'a'.repeat(3000)}@x.com`;
        const longB = `${'b'.repeat(3000)}@x.com`;

        expect((await call(longA)).statusCode).toBe(200);
        // Counted, not swallowed: the second attempt is refused.
        expect((await call(longA)).statusCode).toBe(429);
        // And the other long key has its own counter, not the first one's.
        expect((await call(longB)).statusCode).toBe(200);
        expect((await call('short@x.com')).statusCode).toBe(200);

        // The api and policy names stay readable around the digest, the two
        // long keys stay distinct, and a short key is digested as well.
        expect(trackerKeys[0]).toBe(joinKeyFields('api', 'test.code', 'perEmail', unkeyedFieldDigest('custom', longA)));
        expect(trackerKeys[0]).toBe(trackerKeys[1]);
        expect(trackerKeys[2]).not.toBe(trackerKeys[0]);
        expect(trackerKeys[3]).toBe(joinKeyFields('api', 'test.code', 'perEmail', unkeyedFieldDigest('custom', 'short@x.com')));
        expect(trackerKeys.filter((key) => key.includes('@'))).toEqual([]);
        expect(new Set(trackerKeys.map((key) => key.length)).size).toBe(1);
    });

    it('bounds a custom key by its escaped length, so one made of separators still fits the table', async () => {
        // The key is joined into the tracker key with its separators escaped,
        // which doubles each one: 1,000 of them are 2,000 bytes in the key.
        // Measured unescaped, it would stay under the bound, the partition key
        // would pass DynamoDB's limit, and the limiter's throw would have
        // failOpen let every attempt through unmetered.
        const client = new MemoryDdb();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                    limiter: makeLimiter(client),
                    policies: {
                        perEmail: {
                            perMin: 1, budget: 'perApi',
                            per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }),
                        },
                    },
                } });
            const lambder = app.registerApiGroups(app.defineApiGroup('test', {
                code: app.defineApi({ input: z.object({ value: z.string(), email: z.string() }), output: testSchema.output, rateLimit: 'perEmail' }, async (ctx) => ({ result: 'ok' })),
            }));
            const call = () => lambder.render(createApiEvent('test.code', { value: 'x', email: '|'.repeat(1000) }), createMockContext());

            expect((await call()).statusCode).toBe(200);
            expect((await call()).statusCode).toBe(429);
            expect(errors).not.toHaveBeenCalled();
            expect([...client.items.values()].map((item) => item.pk?.S)).toEqual([expect.stringMatching(/^RL#api\|test\.code\|perEmail\|custom:[0-9a-f]{64}$/)]);
        } finally {
            errors.mockRestore();
        }
    });

    it('writes the address, the session key and a custom key as digests keyed by the session salt, so a table read names no caller', async () => {
        const trackerKeys: string[] = [];
        const counters = new LambderMemoryRateLimiter();
        const recording: LambderRateLimiter = {
            isRateLimited: async (trackerKey: string, policy: LambderRateLimitPolicy) => {
                trackerKeys.push(trackerKey);
                return await counters.isRateLimited(trackerKey, policy);
            },
        };
        const app = initLambder<{ userId: string }>().create({
            apiPath: '/api',
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'shop-salt' },
            guards: { signedIn: { session: true, handler: async () => {} } },
            rateLimits: {
                limiter: recording,
                policies: {
                    perIp: { perMin: 10, per: 'ip' },
                    perUser: { perMin: 10, per: 'session' },
                    perEmail: { perMin: 10, per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }) },
                },
            },
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('account', {
            invite: app.defineApi({ input: z.object({ email: z.string() }), output: z.object({ ok: z.boolean() }), guards: 'signedIn', rateLimit: ['perIp', 'perUser', 'perEmail'] },
                async () => ({ ok: true })),
        }));
        const testApp = lambderTestApp(lambder, { rateLimits: { limiter: recording } });
        const ada = await testApp.signIn('ada@example.com', { userId: 'ada' });

        await ada.api('account.invite', { email: 'bea@example.com' });

        expect(trackerKeys).toEqual([
            joinKeyFields('api', 'account.invite', 'perIp', keyedFieldDigest('shop-salt', 'ip', ada.clientIp)),
            joinKeyFields('api', 'account.invite', 'perUser', keyedFieldDigest('shop-salt', 'session', 'ada@example.com')),
            joinKeyFields('api', 'account.invite', 'perEmail', keyedFieldDigest('shop-salt', 'custom', 'bea@example.com')),
        ]);
        expect(trackerKeys.filter((key) => key.includes('@') || key.includes(ada.clientIp))).toEqual([]);
    });

    it('a policy message keeps its own words under the framework\'s code, and may not name a code of its own', async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { worded: { perMin: 1, per: 'ip', refusal: { type: 'warning', title: 'Easy', content: 'Slow down.' } } },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            worded: app.defineApi({ ...testSchema, rateLimit: 'worded' }, async (ctx) => ({ result: 'ok' })),
        }));

        const call = () => lambder.render(createApiEvent('test.worded', { value: 'x' }), createMockContext());
        await call();
        expect(JSON.parse((await call()).body || '{}').refusal).toEqual({
            type: 'warning', title: 'Easy', content: 'Slow down.', code: 'lambder/rate-limited',
            data: { policy: 'worded', retryAfterSeconds: expect.any(Number) },
        });

        // A code there would read as one the app chose for clients to branch
        // on, when every rate limit reaches them as lambder/rate-limited.
        const coded = { perMin: 1, per: 'ip', refusal: { type: 'warning', code: 'EMAIL_CODE_RATE_LIMITED', content: 'Slow down.' } } as const;
        // @ts-expect-error a rate-limit message has no code
        expect(() => initLambder().create({ apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { coded } } }))
            .toThrow(/rate-limit policy "coded" sets a refusal code/);
        const plain = initLambder().create({ apiPath: '/api', rateLimits: { limiter: makeLimiter(new MemoryDdb()), policies: { plain: { perMin: 1, per: 'ip' } } } });
        // Nor has an API's override of it: its literal is checked at registration.
        expect(() => plain.registerApiGroups(plain.defineApiGroup('test', { overridden: plain.defineApi({ ...testSchema, rateLimit: { plain: { refusal: { type: 'warning', code: 'app/slow', content: 'Slow.' } } } }, async () => ({ result: 'ok' })) })))
            .toThrow(/API "test\.overridden" override of rate-limit policy "plain" sets a refusal code/);
    });

    it('stacked policies are checked in order and any of them can refuse', async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    loose: { perMin: 100, per: 'ip', budget: 'perApi' },
                    strict: { perMin: 1, per: 'ip', budget: 'perApi', refusal: { type: 'error', content: 'strict says no' } },
                },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            stacked: app.defineApi({ ...testSchema, rateLimit: ['loose', 'strict'] }, async (ctx) => ({ result: 'ok' })),
        }));

        const call = () => lambder.render(createApiEvent('test.stacked', { value: 'x' }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        const second = await call();
        expect(second.statusCode).toBe(429);
        // The data names the policy that refused, not the first one listed.
        expect(JSON.parse(second.body || '{}').refusal).toEqual({ type: 'error', code: 'lambder/rate-limited', content: 'strict says no', data: { policy: 'strict', retryAfterSeconds: expect.any(Number) } });
    });

    it('fails open by default when the limiter is down, says so once, and never prints the tracker key', async () => {
        // Fail-open is the engine's decision, not an implementation's, so a
        // custom limiter gets it too and no two limiters answer one outage
        // differently. It is logged because a missing IAM action is permanent,
        // and an app could run for months unmetered with nothing in its logs.
        const client = new MemoryDdb();
        client.failAll = true;
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), policies: { p: { perMin: 1, per: 'ip', budget: 'perApi' } } } });
            const lambder = app.registerApiGroups(app.defineApiGroup('test', {
                open: app.defineApi({ ...testSchema, rateLimit: 'p' }, async (ctx) => ({ result: 'through' })),
            }));

            const result = await lambder.render(createApiEvent('test.open', { value: 'x' }), createMockContext());
            expect(result.statusCode).toBe(200);
            expect(JSON.parse(result.body || '{}').payload.result).toBe('through');

            expect(errors).toHaveBeenCalledTimes(1);
            const logged = String(errors.mock.calls[0]?.[0]);
            expect(logged).toContain('policy "p"');
            expect(logged).toContain('perMin: 1');
            // The key carries whatever the policy tracks, an email in the
            // docs' own example, so it stays out of the log.
            expect(logged).not.toContain('ip:');
        } finally {
            errors.mockRestore();
        }
    });

    it('failOpen: false refuses instead, and the limiter error reaches the crash path', async () => {
        const client = new MemoryDdb();
        client.failAll = true;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: { limiter: makeLimiter(client), failOpen: false, policies: { p: { perMin: 1, per: 'ip', budget: 'perApi' } } } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            closed: app.defineApi({ ...testSchema, rateLimit: 'p' }, async (ctx) => ({ result: 'through' })),
        }));

        const result = await lambder.render(createApiEvent('test.closed', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(500);
        expect(String(result.body)).not.toContain('through');
    });

    it('refuses the key flooding a throttled partition with a Retry-After, and lets failOpen decide for its neighbours', async () => {
        // A key-range throttle falls on a whole partition. The flooding key
        // is at its limit and is refused; a caller beside it, under its own
        // limit, gets the throttle as a store failure, which fails open here
        // (the default) rather than a 429 it did nothing to earn.
        const table = new MemoryDdb();
        let throttled = false;
        const client = {
            send: async (command: any) => {
                if(throttled && command?.constructor?.name === 'UpdateItemCommand'){
                    throw Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException', ThrottlingReasons: [{ reason: 'TableWriteKeyRangeThroughputExceeded' }] });
                }
                return await table.send(command);
            },
        };
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                    limiter: new LambderDdbRateLimiter({ tableName: 'test-table', client: client as never }),
                    policies: { p: { perMin: 1, per: 'ip', budget: 'perApi' } },
                } });
            const lambder = app.registerApiGroups(app.defineApiGroup('test', {
                open: app.defineApi({ ...testSchema, rateLimit: 'p' }, async (ctx) => ({ result: 'through' })),
            }));
            const callFrom = (sourceIp: string) => lambder.render(createEnvelopeEvent({ apiName: 'test.open', payload: { value: 'x' } }, { sourceIp }), createMockContext());

            expect((await callFrom('198.51.100.1')).statusCode).toBe(200);
            throttled = true;

            const flood = await callFrom('198.51.100.1');
            expect(flood.statusCode).toBe(429);
            // Five seconds, give or take the second boundary between the
            // limiter's clock read and the engine's.
            expect(Number(flood.multiValueHeaders?.['Retry-After']?.[0])).toBeGreaterThanOrEqual(4);
            expect(Number(flood.multiValueHeaders?.['Retry-After']?.[0])).toBeLessThanOrEqual(5);

            const neighbour = await callFrom('198.51.100.2');
            expect(neighbour.statusCode).toBe(200);
            expect(errors).toHaveBeenCalledTimes(1);
        } finally {
            errors.mockRestore();
        }
    });

    it('logs a flood it cannot size once, not once per request, and still lets failOpen decide each one', async () => {
        // Writes and reads both throttled on the key's partition: whether the
        // key is the flood cannot be told, so each request fails open. The
        // limiter throws the same error for the repeats, and a log line per
        // request of a flood of thousands a second says nothing the first
        // one did not.
        const throttle = (reason: string) => Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException', ThrottlingReasons: [{ reason }] });
        const client = {
            send: async (command: any) => {
                throw throttle(command?.constructor?.name === 'UpdateItemCommand' ? 'TableWriteKeyRangeThroughputExceeded' : 'TableReadKeyRangeThroughputExceeded');
            },
        };
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                    limiter: new LambderDdbRateLimiter({ tableName: 'test-table', client: client as never }),
                    policies: { p: { perMin: 1, per: 'ip', budget: 'perApi' } },
                } });
            const lambder = app.registerApiGroups(app.defineApiGroup('test', {
                open: app.defineApi({ ...testSchema, rateLimit: 'p' }, async (ctx) => ({ result: 'through' })),
            }));

            for(let attempt = 0; attempt < 3; attempt++){
                expect((await lambder.render(createApiEvent('test.open', { value: 'x' }), createMockContext())).statusCode).toBe(200);
            }
            expect(errors).toHaveBeenCalledTimes(1);
        } finally {
            errors.mockRestore();
        }
    });

    it('measures Retry-After on the limiter\'s own clock', async () => {
        // resetAt is a second on the clock the windows were counted against.
        // Read against the wall clock instead, a limiter under a test clock
        // three years back answers Retry-After: 1 whatever the window says.
        const START = 1_700_000_000_000;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: new LambderDdbRateLimiter({ tableName: 'test-table', client: new MemoryDdb(), now: () => START }),
                policies: { p: { perMin: 1, per: 'ip', budget: 'perApi' } },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            limited: app.defineApi({ ...testSchema, rateLimit: 'p' }, async (ctx) => ({ result: 'through' })),
        }));

        expect((await lambder.render(createApiEvent('test.limited', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        const refused = await lambder.render(createApiEvent('test.limited', { value: 'x' }), createMockContext());
        expect(refused.statusCode).toBe(429);
        const minuteEnd = (Math.floor(START / 1000 / 60) + 1) * 60;
        expect(refused.multiValueHeaders?.['Retry-After']).toEqual([String(minuteEnd - START / 1000)]);
    });

    it('budget "perApi" (the default) gives each API its own counter', async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { one: { perMin: 1, per: 'ip' } },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            first: app.defineApi({ ...testSchema, rateLimit: 'one' }, async (ctx) => ({ result: 'a' })),
            second: app.defineApi({ ...testSchema, rateLimit: 'one' }, async (ctx) => ({ result: 'b' })),
        }));

        expect((await lambder.render(createApiEvent('test.first', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        // Separate budget: the second API is untouched by the first one's counter.
        expect((await lambder.render(createApiEvent('test.second', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        expect((await lambder.render(createApiEvent('test.first', { value: 'x' }), createMockContext())).statusCode).toBe(429);
    });

    it('budget "perPolicy" shares one counter across every API referencing the policy', async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { shared: { perMin: 1, per: 'ip', budget: 'perPolicy' } },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            first: app.defineApi({ ...testSchema, rateLimit: 'shared' }, async (ctx) => ({ result: 'a' })),
            second: app.defineApi({ ...testSchema, rateLimit: 'shared' }, async (ctx) => ({ result: 'b' })),
        }));

        expect((await lambder.render(createApiEvent('test.first', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        // One combined budget: the first API's call consumed it for both.
        expect((await lambder.render(createApiEvent('test.second', { value: 'x' }), createMockContext())).statusCode).toBe(429);
    });

    it('the map form tunes a perApi policy per API: overrides merge over the policy windows and never touch other APIs', async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { lookup: { perMin: 1, perHour: 2, per: 'ip' } },   // budget defaults to perApi, so it is tunable
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            tuned: app.defineApi({ ...testSchema, rateLimit: { lookup: { perMin: 5, refusal: { type: 'warning', content: 'tuned says no' } } } }, async (ctx) => ({ result: 'a' })),
            plain: app.defineApi({ ...testSchema, rateLimit: 'lookup' }, async (ctx) => ({ result: 'b' })),
        }));

        const call = (api: string) => lambder.render(createApiEvent(api, { value: 'x' }), createMockContext());
        expect((await call('test.tuned')).statusCode).toBe(200);
        expect((await call('test.tuned')).statusCode).toBe(200);
        // perMin raised to 5, but the policy's perHour: 2 still applies (merge, not replace).
        const third = await call('test.tuned');
        expect(third.statusCode).toBe(429);
        expect(JSON.parse(third.body || '{}').refusal).toEqual({ type: 'warning', code: 'lambder/rate-limited', content: 'tuned says no', data: { policy: 'lookup', retryAfterSeconds: expect.any(Number) } });
        // The plain API keeps the declared perMin: 1 on its own counter.
        expect((await call('test.plain')).statusCode).toBe(200);
        expect((await call('test.plain')).statusCode).toBe(429);
    });

    it('the map form may override refusal on a perPolicy policy (text is per API, the counter is not)', async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { shared: { perMin: 1, per: 'ip', budget: 'perPolicy' } },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            first: app.defineApi({ ...testSchema, rateLimit: { shared: { refusal: { type: 'error', content: 'first is closed' } } } }, async (ctx) => ({ result: 'a' })),
            second: app.defineApi({ ...testSchema, rateLimit: { shared: true } }, async (ctx) => ({ result: 'b' })),
        }));

        expect((await lambder.render(createApiEvent('test.second', { value: 'x' }), createMockContext())).statusCode).toBe(200);
        const blocked = await lambder.render(createApiEvent('test.first', { value: 'x' }), createMockContext());
        expect(blocked.statusCode).toBe(429);
        expect(JSON.parse(blocked.body || '{}').refusal).toEqual({ type: 'error', code: 'lambder/rate-limited', content: 'first is closed', data: { policy: 'shared', retryAfterSeconds: expect.any(Number) } });
    });

    it('stacked policies charge every counter checked before the refusing one (attempts count)', async () => {
        const client = new MemoryDdb();
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(client),
                policies: {
                    ipWide: { perMin: 100, per: 'ip', budget: 'perApi' },
                    tight: { perMin: 1, per: 'ip', budget: 'perApi' },
                },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            stacked: app.defineApi({ ...testSchema, rateLimit: ['ipWide', 'tight'] }, async (ctx) => ({ result: 'ok' })),
        }));

        const call = () => lambder.render(createApiEvent('test.stacked', { value: 'x' }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(429);
        const ipWideCount = [...client.items.entries()].find(([k]) => k.includes('|ipWide|'))?.[1].count?.N;
        expect(ipWideCount).toBe('2');
    });
});

describe('API policies - requireApiGuards', () => {
    /** An app's authorization vocabulary, plus the named opt-outs. */
    const guards = {
        staffPermission: lambderGuard({
            session: true,
            handler: (_ctx, _payload, permission: string) => ({ permission }),
        }),
        // The named opt-out of a session API: the session itself is the whole authorization.
        signedIn: lambderGuard({ session: true, handler: () => {} }),
        terminalToken: lambderGuard({
            apiInput: z.object({ value: z.string() }),
            handler: (_ctx, { value }) => ({ terminalId: value }),
        }),
        // Anyone may call, and the param records why.
        open: lambderGuard({ handler: (_ctx, _payload, _reason: string) => {} }),
        // The endpoint establishes identity; the handler proves what it needs.
        credentialFlow: lambderGuard({ handler: () => {} }),
    };
    const strict = () => initLambder().create({ files: testPublicFiles(), apiPath: '/api', session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' }, guards, requireApiGuards: true });

    it('refuses an API that declares no guards, at registration', () => {
        const app = strict();
        expect(() => app.registerApiGroups(app.defineApiGroup('public', { forgot: app.defineApi({ ...testSchema } as any, async (ctx) => null) })))
            .toThrow(/API "public\.forgot" declares no guards/);
    });

    it('accepts a session API that declares a guard, or the named opt-out', () => {
        const app = strict();
        expect(() => app.registerApiGroups(app.defineApiGroup('secure', {
            admin: app.defineApi({ ...testSchema, guards: { staffPermission: 'ORDERS.REFUND' } }, async (ctx) => ({ result: 'ok' })),
            me: app.defineApi({ ...testSchema, guards: 'signedIn' }, async (ctx) => ({ result: 'ok' })),
        })))
            .not.toThrow();
    });

    it('accepts a public API that declares a guard, or either named opt-out', () => {
        const app = strict();
        expect(() => app.registerApiGroups(app.defineApiGroup('public', {
            terminal: app.defineApi({ ...testSchema, guards: 'terminalToken' }, async (ctx) => ({ result: 'ok' })),
            translations: app.defineApi({ ...testSchema, guards: { open: 'Static strings already in the bundle.' } }, async (ctx) => ({ result: 'ok' })),
            login: app.defineApi({ ...testSchema, guards: 'credentialFlow' }, async (ctx) => ({ result: 'ok' })),
        })))
            .not.toThrow();
    });

    it('is off by default: an API without guards still registers', () => {
        const relaxed = initLambder().create({ files: testPublicFiles(), apiPath: '/api', session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' }, guards });
        expect(() => relaxed.registerApiGroups(relaxed.defineApiGroup('public', { free: relaxed.defineApi({ ...testSchema }, async (ctx) => ({ result: 'ok' })) }))).not.toThrow();
    });

    it('needs a guards map to declare from', () => {
        expect(() => initLambder().create({ files: testPublicFiles(), apiPath: '/api', requireApiGuards: true }))
            .toThrow(/needs a guards map/);
    });

    it('makes a missing guards declaration a compile error', () => {
        const app = strict();
        const secure = app.defineApiGroup('secure', {
            // @ts-expect-error guards is required on this instance
            typed: app.defineApi({ ...testSchema }, async (ctx) => ({ result: 'ok' })),
        });
        expect(() => app.registerApiGroups(secure)).toThrow(/declares no guards/);
        // The declaration keeps its typing: the guard's output lands on ctx.guardData.
        app.registerApiGroups(app.defineApiGroup('typed', {
            session: app.defineApi({ ...testSchema, guards: { staffPermission: 'ORDERS.VIEW' } }, async (ctx) => {
                const permission: string = ctx.guardData.staffPermission.permission;
                return { result: permission };
            }),
            public: app.defineApi({ ...testSchema, guards: 'terminalToken' }, async (ctx) => {
                const terminalId: string = ctx.guardData.terminalToken.terminalId;
                return { result: terminalId };
            }),
        }));
    });
});

describe('API policies - an empty guards option declares nothing', () => {
    // The one shape that turns a mandatory authorization declaration back into
    // an optional one: the option is present, so the required-field check
    // passes, and it normalizes to zero entries, so no guard runs.
    const guards = {
        staffPermission: lambderGuard({ session: true, handler: (_ctx, _p, permission: string) => ({ permission }) }),
        signedIn: lambderGuard({ session: true, handler: () => {} }),
        open: lambderGuard({ handler: (_ctx, _payload, _reason: string) => {} }),
    };
    const strict = () => initLambder().create({
        files: testPublicFiles(), apiPath: '/api', guards,
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        requireApiGuards: true,
    });

    it('refuses an empty guards map at registration', () => {
        const app = strict();
        expect(() => app.registerApiGroups(app.defineApiGroup('secure', { empty: app.defineApi({ ...testSchema, guards: {} } as any, async (ctx) => null) })))
            .toThrow(/declares an empty guards option/);
    });

    it('refuses an empty guards list at registration', () => {
        const app = strict();
        expect(() => app.registerApiGroups(app.defineApiGroup('public', { empty: app.defineApi({ ...testSchema, guards: [] } as any, async (ctx) => null) })))
            .toThrow(/declares an empty guards option/);
    });

    it('refuses an empty option even where guards are not required', () => {
        // Not just a hole in requireApiGuards: an empty declaration reads as
        // an authorization decision and is not one, whoever writes it.
        const relaxed = initLambder().create({ files: testPublicFiles(), apiPath: '/api', session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' }, guards });
        expect(() => relaxed.registerApiGroups(relaxed.defineApiGroup('public', { emptyToo: relaxed.defineApi({ ...testSchema, guards: {} } as any, async (ctx) => null) })))
            .toThrow(/declares an empty guards option/);
    });

    it('rejects the empty forms at the type level', () => {
        const app = strict();
        // @ts-expect-error an empty guards map declares no guard
        const emptyMap = app.defineApi({ ...testSchema, guards: {} }, async (ctx) => ({ result: 'ok' }));
        expect(() => app.registerApiGroups(app.defineApiGroup('emptyMap', { t1: emptyMap }))).toThrow();
        // @ts-expect-error an empty guards list declares no guard
        const emptyList = app.defineApi({ ...testSchema, guards: [] }, async (ctx) => ({ result: 'ok' }));
        expect(() => app.registerApiGroups(app.defineApiGroup('emptyList', { t2: emptyList }))).toThrow();
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
        const app = strict();
        // @ts-expect-error a named guard with an undefined param is not a declaration
        const undefinedParam = app.defineApi({ ...testSchema, guards: { staffPermission: undefined } }, async (ctx) => ({ result: 'ok' }));
        expect(() => app.registerApiGroups(app.defineApiGroup('secure', { t3: undefinedParam })))
            .not.toThrow();
    });

    it('rejects a guard that answers instead of authorizing, at build and at runtime', async () => {
        // A guard that hands back a response denies nothing: the value would
        // become ctx.guardData[name] and the call would carry on. A guard gets
        // no resolver but can still build a response itself, so both halves
        // are pinned here.
        // @ts-expect-error a guard authorizes, it does not answer
        const answering = lambderGuard({ handler: () => new LambderResponse({ statusCode: 403, body: 'denied' }) });

        const app = initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            // The cast is the plain-JS route past the type above; the engine
            // has to catch it on its own.
            guards: { answering: answering as any },
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('guarded', {
            answering: app.defineApi({ ...testSchema, guards: 'answering' } as any, async (ctx) => ({ result: 'reached' })),
        }));

        const response = await lambder.render(createApiEvent('guarded.answering', { value: 'v' }), {} as any);
        expect(response.statusCode).toBe(500);
        expect(String(response.body)).not.toContain('reached');
    });

    it('still accepts every non-empty form', () => {
        const app = strict();
        expect(() => app.registerApiGroups(
            app.defineApiGroup('secure', {
                one: app.defineApi({ ...testSchema, guards: 'signedIn' }, async (ctx) => ({ result: 'ok' })),
                list: app.defineApi({ ...testSchema, guards: ['signedIn'] }, async (ctx) => ({ result: 'ok' })),
                map: app.defineApi({ ...testSchema, guards: { staffPermission: 'ORDERS.VIEW' } }, async (ctx) => ({ result: 'ok' })),
                both: app.defineApi({ ...testSchema, guards: { signedIn: true, staffPermission: 'ORDERS.VIEW' } }, async (ctx) => ({ result: 'ok' })),
            }),
            app.defineApiGroup('public', {
                open: app.defineApi({ ...testSchema, guards: { open: 'Nothing here is anybody\'s.' } }, async (ctx) => ({ result: 'ok' })),
            }),
        ))
            .not.toThrow();
    });
});

describe('API policies - guards', () => {
    it('a refusing guard blocks before validation and before the handler', async () => {
        let handlerRan = false;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: {
                deny: {
                    handler: async () => {
                        throw new LambderApiRefusal('Guard says no', { refusal: { type: 'error', content: 'Blocked.' } });
                    },
                },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            guarded: app.defineApi({ ...testSchema, guards: 'deny' }, async (ctx) => {
                handlerRan = true;
                return { result: 'never' };
            }),
        }));

        // Invalid payload on purpose: the guard must win over the 422.
        const result = await lambder.render(createApiEvent('test.guarded', { wrong: true }), createMockContext());
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body || '{}').refusal).toEqual({ type: 'error', content: 'Blocked.' });
        expect(handlerRan).toBe(false);
    });

    it('apiInput guards validate their slice of the API payload and answer 422 when it is missing', async () => {
        let sawToken: string | null = null;
        const gatedSchema = {
            input: z.object({ value: z.string(), token: z.string().min(3) }),
            output: z.object({ result: z.string() }),
        };
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: {
                token: lambderGuard({
                    apiInput: z.object({ token: z.string().min(3) }),
                    handler: async (_ctx, { token }) => { sawToken = token; },
                }),
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            gated: app.defineApi({ ...gatedSchema, guards: 'token' }, async (ctx) => ({ result: ctx.apiPayload.value })),
        }));

        // Missing token: the 422 validation shape, before the guard or handler runs.
        const missing = await lambder.render(createApiEvent('test.gated', { value: 'x' }), createMockContext());
        expect(missing.statusCode).toBe(422);
        expect(JSON.parse(missing.body || '{}').zodError).toBeDefined();
        expect(sawToken).toBe(null);

        // Present: guard gets its typed slice AND the field flows on into the
        // API's own validated payload (it stays part of the API input shape).
        const ok = await lambder.render(createApiEvent('test.gated', { value: 'x', token: 'abc' }), createMockContext());
        expect(ok.statusCode).toBe(200);
        expect(JSON.parse(ok.body || '{}').payload.result).toBe('x');
        expect(sawToken).toBe('abc');
    });

    it('guardInput guards read their value from the separate guardInputs envelope', async () => {
        let sawToken: string | null = null;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: {
                captcha: lambderGuard({
                    guardInput: z.object({ token: z.string().min(3) }),
                    handler: async (_ctx, { token }) => { sawToken = token; },
                }),
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            gated: app.defineApi({ ...testSchema, guards: 'captcha' }, async (ctx) => ({ result: ctx.apiPayload.value })),
        }));

        // Missing guardInputs entry: 422 before the handler runs, and the API
        // payload itself is untouched by the requirement.
        const missing = await lambder.render(createApiEvent('test.gated', { value: 'x' }), createMockContext());
        expect(missing.statusCode).toBe(422);
        expect(sawToken).toBe(null);

        const ok = await lambder.render(
            createApiEvent('test.gated', { value: 'x' }, { guardInputs: { captcha: { token: 'abc' } } }),
            createMockContext(),
        );
        expect(ok.statusCode).toBe(200);
        expect(JSON.parse(ok.body || '{}').payload.result).toBe('x');
        expect(sawToken).toBe('abc');
    });

    it('validates a custom rate-limit key slice and answers 422 when it is missing', async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: {
                    perEmail: {
                        perMin: 5, budget: 'perApi',
                        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }),
                    },
                },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            // The key's fields are part of the API's own schema, which is
            // what makes the policy referable here at all. The slice is still
            // validated first, so a missing email is the key's 422, not the
            // schema's.
            keyed: app.defineApi({ input: z.object({ value: z.string(), email: z.string() }), output: testSchema.output, rateLimit: 'perEmail' }, async (ctx) => ({ result: 'ok' })),
        }));

        const missing = await lambder.render(createApiEvent('test.keyed', { value: 'x' }), createMockContext());
        expect(missing.statusCode).toBe(422);
        const ok = await lambder.render(createApiEvent('test.keyed', { value: 'x', email: 'a@x.com' }), createMockContext());
        expect(ok.statusCode).toBe(200);
    });

    it('preflight slices (rate-limit keys, guard inputs) answer through setApiInputValidationErrorHandler like the API schema', async () => {
        const seen: string[] = [];
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api',
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
                return res.apiRefusal({ refusal: { type: 'error', content: 'bad input' } }, { statusCode: 400 });
            });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            keyed: app.defineApi({ input: z.object({ value: z.string(), email: z.string() }), output: testSchema.output, rateLimit: 'perEmail' }, async (ctx) => ({ result: 'ok' })),
            guarded: app.defineApi({ ...testSchema, guards: 'captcha' }, async (ctx) => ({ result: 'ok' })),
            plain: app.defineApi(testSchema, async (ctx) => ({ result: 'ok' })),
        }));

        for(const event of [
            createApiEvent('test.keyed', { value: 'x' }),                        // rate-limit key slice: email missing
            createApiEvent('test.guarded', { value: 'x' }, { guardInputs: { captcha: {} } }),  // guardInput slice: token missing
            createApiEvent('test.plain', {}),                                     // the API's own schema: value missing
        ]){
            const result = await lambder.render(event, createMockContext());
            expect(result.statusCode).toBe(400);
            expect(JSON.parse(result.body || '{}').refusal).toEqual({ type: 'error', content: 'bad input' });
        }
        expect(seen).toEqual(['email', 'token', 'value']);
    });

    it('guards run in declared order and passing guards let the handler run', async () => {
        const order: string[] = [];
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: {
                first: { handler: async () => { order.push('first'); } },
                second: { handler: async () => { order.push('second'); } },
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            ordered: app.defineApi({ ...testSchema, guards: ['first', 'second'] }, async (ctx) => ({ result: 'ran' })),
        }));

        const result = await lambder.render(createApiEvent('test.ordered', { value: 'x' }), createMockContext());
        expect(order).toEqual(['first', 'second']);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ran');
    });

    it("a guard's return value lands typed on ctx.guardData under its name", async () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: {
                terminalAuth: lambderGuard({
                    apiInput: z.object({ token: z.string() }),
                    handler: async (_ctx, { token }) => ({ terminalId: `terminal-${token}` }),
                }),
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            withData: app.defineApi({
                input: z.object({ value: z.string(), token: z.string() }),
                output: z.object({ result: z.string() }),
                guards: 'terminalAuth',
            }, async (ctx) => ({ result: ctx.guardData.terminalAuth.terminalId })),
        }));

        const result = await lambder.render(createApiEvent('test.withData', { value: 'x', token: 'abc' }), createMockContext());
        expect(JSON.parse(result.body || '{}').payload.result).toBe('terminal-abc');
    });

    it('the object form passes params, runs in insertion order, and keeps void guards out of guardData', async () => {
        const order: string[] = [];
        let seenGuardData: Record<string, unknown> = {};
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: {
                perm: lambderGuard({
                    handler: (_ctx, _payload, permission: string) => {
                        order.push(`perm:${permission}`);
                        return { granted: permission };
                    },
                }),
                audit: lambderGuard({
                    handler: () => { order.push('audit'); },
                }),
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            paramed: app.defineApi({
                ...testSchema,
                guards: { perm: 'ADMIN.MANAGE', audit: true },
            }, async (ctx) => {
                seenGuardData = { ...ctx.guardData };
                return { result: ctx.guardData.perm.granted };
            }),
        }));

        const result = await lambder.render(createApiEvent('test.paramed', { value: 'x' }), createMockContext());
        expect(order).toEqual(['perm:ADMIN.MANAGE', 'audit']);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ADMIN.MANAGE');
        // The check-only guard returned nothing, so it never appears.
        expect(Object.keys(seenGuardData)).toEqual(['perm']);
    });

    it('a refusal from a parameterized guard blocks the handler', async () => {
        let handlerRan = false;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: {
                perm: lambderGuard({
                    handler: (_ctx, _payload, permission: string) => {
                        throw new LambderApiRefusal(`Denied: ${permission}`, { notAuthorized: true });
                    },
                }),
            } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            denied: app.defineApi({ ...testSchema, guards: { perm: 'ADMIN.NOPE' } }, async (ctx) => {
                handlerRan = true;
                return { result: 'never' };
            }),
        }));

        const result = await lambder.render(createApiEvent('test.denied', { value: 'x' }), createMockContext());
        expect(JSON.parse(result.body || '{}').notAuthorized).toBe(true);
        expect(handlerRan).toBe(false);
    });

    it('session guards are rejected at registration on an instance created without sessions', () => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', guards: {
                staffPermission: lambderGuard({
                    session: true,
                    handler: (ctx) => ({ storeId: ctx.session.sessionKey }),
                }),
            } });
        expect(() => app.registerApiGroups(app.defineApiGroup('test', { pub: app.defineApi({ ...testSchema, guards: 'staffPermission' } as any, async (ctx) => null) })))
            .toThrow(/a guard of API "test\.pub" needs a session, and the instance was created without the session option/);
    });
});

describe('API policies - idempotency', () => {
    // Keys must be at least 16 chars (they scope the replay record for
    // logged-out clients, so they are required to be long and random).
    const KEY_1 = 'k-1-abcdefabcdefabcdef';
    const KEY_2 = 'k-2-abcdefabcdefabcdef';
    const KEY_3 = 'k-3-abcdefabcdefabcdef';
    const KEY_BUSY = 'k-busy-abcdefabcdefabcdef';
    const KEY_OLD = 'k-old-abcdefabcdefabcdef';
    /** The partition key of a public API's record scoped by the posted key alone, in an app with no session salt. */
    const keyOnlyPartition = (apiName: string, key: string): string => `IDEM#${joinKeyFields('k', apiName, unkeyedFieldDigest('key', key))}`;

    const build = (client: MemoryDdb, onRun?: () => void) => {
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', idempotency: { store: makeStore(client) } });
        return app.registerApiGroups(app.defineApiGroup('test', {
            op: app.defineApi({ ...testSchema, idempotency: true }, async (ctx) => {
                onRun?.();
                return { result: `ran:${ctx.apiPayload.value}` };
            }),
        }));
    };

    it('executes normally when no idempotencyKey is sent', async () => {
        let runs = 0;
        const lambder = build(new MemoryDdb(), () => { runs += 1; });
        await lambder.render(createApiEvent('test.op', { value: 'a' }), createMockContext());
        await lambder.render(createApiEvent('test.op', { value: 'a' }), createMockContext());
        expect(runs).toBe(2);
    });

    it('replays the stored response for a repeated key without re-executing', async () => {
        let runs = 0;
        const lambder = build(new MemoryDdb(), () => { runs += 1; });
        const call = () => lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());

        const first = await call();
        const second = await call();
        expect(runs).toBe(1);
        expect(second.statusCode).toBe(first.statusCode);
        expect(second.body).toBe(first.body);
        expect(JSON.parse(second.body || '{}').payload.result).toBe('ran:a');
    });

    it('a replay answers before the session-keyed limits, so a retry does not burn that quota', async () => {
        let runs = 0;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                // A custom key: checked after the session read, which is where
                // the replay fast path answers from.
                policies: { tight: { perMin: 1, budget: 'perApi', per: lambderRateLimitKey({ handler: () => 'one-bucket' }) } },
            }, idempotency: { store: makeStore(new MemoryDdb()) } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            op: app.defineApi({ ...testSchema, rateLimit: 'tight', idempotency: true }, async (ctx) => {
                runs += 1;
                return { result: 'ok' };
            }),
        }));

        const call = (key: string) => lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: key }), createMockContext());
        expect((await call(KEY_1)).statusCode).toBe(200);
        // Same key: replayed 200 even though the perMin: 1 budget is spent.
        const retry = await call(KEY_1);
        expect(retry.statusCode).toBe(200);
        expect(JSON.parse(retry.body || '{}').payload.result).toBe('ok');
        expect(runs).toBe(1);
        // A NEW operation is properly rate limited.
        expect((await call(KEY_2)).statusCode).toBe(429);
    });

    it('an ip-keyed limit is charged even to a replay: it protects the stores, not the handler', async () => {
        // `per: "ip"` runs before the session read and before the replay
        // lookup, because those are the reads it exists to bound. A retry
        // therefore counts against the ip budget while still not
        // re-executing anything.
        let runs = 0;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', rateLimits: {
                limiter: makeLimiter(new MemoryDdb()),
                policies: { perIp: { perMin: 1, per: 'ip', budget: 'perApi' } },
            }, idempotency: { store: makeStore(new MemoryDdb()) } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            op: app.defineApi({ ...testSchema, rateLimit: 'perIp', idempotency: true }, async (ctx) => {
                runs += 1;
                return { result: 'ok' };
            }),
        }));

        const call = () => lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        const retry = await call();
        expect(retry.statusCode).toBe(429);
        expect(runs).toBe(1);
    });

    it('scopes a session API replay per user, so one key from two users does not cross', async () => {
        // The line that makes "even a leaked key cannot cross users" true, and
        // the only test that fails if a session API's scope falls back to the
        // public, key-only form. The scope is the sessionKey, so every session
        // of one user shares it.
        const ran: string[] = [];
        const app = initLambder<{ role: string }>().create({
            files: testPublicFiles(), apiPath: '/api',
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
            idempotency: { store: makeStore(new MemoryDdb()) },
            guards: { signedIn: lambderGuard({ session: true, handler: () => {} }) },
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('secure', {
            op: app.defineApi({ ...testSchema, guards: 'signedIn', idempotency: true }, async (ctx) => {
                ran.push(ctx.session.sessionKey);
                return { result: `ran:${ctx.session.sessionKey}` };
            }),
        }));

        const manager = lambder.getSessionManager();
        const a = await manager.createSession('A1', { role: 'user' });
        const b = await manager.createSession('B1', { role: 'user' });
        const call = (session: { sessionToken: string, csrfToken: string }) => lambder.render(createEnvelopeEvent(
            { apiName: 'secure.op', payload: { value: 'x' }, token: session.csrfToken, idempotencyKey: KEY_1 },
            { headers: { Host: 'localhost', Cookie: `LMDRSESSIONTKID=${session.sessionToken}; LMDRSESSIONCSTK=${session.csrfToken}` } },
        ), createMockContext());

        expect(JSON.parse((await call(a)).body || '{}').payload.result).toBe('ran:A1');
        // B posts the SAME key: its own scope, its own run, and none of A's answer.
        expect(JSON.parse((await call(b)).body || '{}').payload.result).toBe('ran:B1');
        // A retries: A's own answer, replayed, with no third run.
        expect(JSON.parse((await call(a)).body || '{}').payload.result).toBe('ran:A1');
        // A retries from another session (a second tab, a new sign-in): the
        // same user, so the same scope and the same answer.
        const aElsewhere = await manager.createSession('A1', { role: 'user' });
        expect(JSON.parse((await call(aElsewhere)).body || '{}').payload.result).toBe('ran:A1');
        expect(ran).toEqual(['A1', 'B1']);
    });

    it('stores response headers, including ones set via ctx.setResponseHeader, and replays them', async () => {
        let runs = 0;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            headed: app.defineApi({ ...testSchema, idempotency: true }, async (ctx) => {
                runs += 1;
                ctx.setResponseHeader('X-Custom', 'stored-value');
                return { result: 'ok' };
            }),
        }));

        const call = () => lambder.render(createApiEvent('test.headed', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        const first = await call();
        const second = await call();
        expect(runs).toBe(1);
        expect(first.multiValueHeaders?.['X-Custom']).toEqual(['stored-value']);
        expect(second.multiValueHeaders?.['X-Custom']).toEqual(['stored-value']);
        expect(second.multiValueHeaders?.['Content-Type']).toEqual(first.multiValueHeaders?.['Content-Type']);
    });

    it('never stores a response that sets cookies: the retry re-executes', async () => {
        let runs = 0;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            cookied: app.defineApi({ ...testSchema, idempotency: true }, async (ctx) => {
                runs += 1;
                ctx.addResponseHeader('Set-Cookie', `run=${runs}`);
                return { result: 'ok' };
            }),
        }));

        const call = () => lambder.render(createApiEvent('test.cookied', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        // Not a 409 either: the claim was released, not left dangling.
        const second = await call();
        expect(second.statusCode).toBe(200);
        expect(runs).toBe(2);
        expect(second.multiValueHeaders?.['Set-Cookie']).toEqual(['run=2']);
    });

    it('a cookie written before the handler does not disable idempotency, and is not stored with the answer', async () => {
        // The real instance of this is the session read evicting a stale
        // cookie: it writes a Set-Cookie into the call before the handler
        // runs. Charging that to the handler's answer would make the answer
        // uncacheable and silently turn an idempotent operation into one that
        // re-executes on every retry.
        let runs = 0;
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } });
        const lambder = app.registerApiGroups(app.defineApiGroup('payments', {
            charge: app.defineApi({ ...testSchema, idempotency: true }, async (ctx) => {
                runs += 1;
                return { result: 'charged' };
            }),
        }))
            .addHook('beforeRender', (ctx, res) => { ctx.addResponseHeader('Set-Cookie', 'stale=; Max-Age=0'); return ctx; });

        const call = () => lambder.render(createApiEvent('payments.charge', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        const first = await call();
        const second = await call();

        // The retry replayed: the operation ran once.
        expect(runs).toBe(1);
        expect(JSON.parse(second.body || '{}').payload.result).toBe('charged');
        // Both calls still send their own eviction cookie to the client.
        expect(first.multiValueHeaders?.['Set-Cookie']).toEqual(['stale=; Max-Age=0']);
        // Exactly one: the replay carries this call's cookie, not also a copy
        // stored from the first call's.
        expect(second.multiValueHeaders?.['Set-Cookie']).toEqual(['stale=; Max-Age=0']);
    });

    it('compression lets large compressible bodies replay (450KB raw is far over a raw cap)', async () => {
        let runs = 0;
        // 150k euro signs: ~450KB UTF-8, but Brotli shrinks it to almost nothing.
        const bigValue = '€'.repeat(150_000);
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            big: app.defineApi({ ...testSchema, idempotency: true }, async (ctx) => {
                runs += 1;
                return { result: bigValue };
            }),
        }));

        const call = () => lambder.render(createApiEvent('test.big', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        const replay = await call();
        expect(replay.statusCode).toBe(200);
        expect(runs).toBe(1);
    });

    it('a body too large even compressed is not stored: the retry re-executes, with no dangling 409', async () => {
        let runs = 0;
        // Random base64 barely compresses: ~533KB stays well over the 350KB item budget.
        const incompressible = nodeCrypto.randomBytes(400_000).toString('base64');
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', idempotency: { store: makeStore(new MemoryDdb()) } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            huge: app.defineApi({ ...testSchema, idempotency: true }, async (ctx) => {
                runs += 1;
                return { result: incompressible };
            }),
        }));

        const call = () => lambder.render(createApiEvent('test.huge', { value: 'a' }, { idempotencyKey: KEY_1 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        expect(runs).toBe(2);
    });

    it('a slow original that lost its claim cannot clobber the new owner', async () => {
        const client = new MemoryDdb();
        const store = makeStore(client);
        const original = await store.begin('scope-x', { pendingTtlSeconds: 300, fingerprint: 'request-1' });
        expect(original.state).toBe('new');
        if(original.state !== 'new') return;

        // The original stalls past its pending TTL; a retry claims the scope.
        const k = 'IDEM#scope-x|idem';
        client.items.get(k)!.expiresAt = { N: String(Math.floor(Date.now() / 1000) - 10) };
        const retry = await store.begin('scope-x', { pendingTtlSeconds: 300, fingerprint: 'request-1' });
        expect(retry.state).toBe('new');
        if(retry.state !== 'new') return;

        // The stalled original settles late: both paths must be silent no-ops.
        const staleBody = { statusCode: 200, headers: {}, body: 'stale', fingerprint: 'request-1', ttlSeconds: 60 };
        expect(await store.complete('scope-x', original.ownerToken, staleBody)).toBe('lost');
        await store.abandon('scope-x', original.ownerToken);
        expect(client.items.get(k)?.state?.S).toBe('pending');

        // The retry still owns the scope and settles normally.
        expect(await store.complete('scope-x', retry.ownerToken, { ...staleBody, body: 'fresh' })).toBe('stored');
        expect(client.items.get(k)?.body?.S).toBe('fresh');
    });

    it('compression: false stores every body plain, { minBytes } moves the threshold, and either shape reads back', async () => {
        const big = JSON.stringify({ payload: { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${i}` })) } });
        const settle = async (store: LambderDdbIdempotencyStore, scope: string, body: string) => {
            const claim = await store.begin(scope, { pendingTtlSeconds: 300, fingerprint: 'request-1' });
            if(claim.state !== 'new') throw new Error('expected fresh claim');
            expect(await store.complete(scope, claim.ownerToken, { statusCode: 200, headers: {}, body, fingerprint: 'request-1', ttlSeconds: 60 })).toBe('stored');
        };

        const offClient = new MemoryDdb();
        await settle(new LambderDdbIdempotencyStore({ tableName: 'test-table', client: offClient, compression: false }), 'scope-off', big);
        expect(offClient.items.get('IDEM#scope-off|idem')?.body?.S).toBe(big);
        expect(offClient.items.get('IDEM#scope-off|idem')?.bodyBr).toBe(undefined);
        // Switched back on: the plain record still reads.
        expect((await makeStore(offClient).peek('scope-off'))?.body).toBe(big);

        const alwaysClient = new MemoryDdb();
        await settle(new LambderDdbIdempotencyStore({ tableName: 'test-table', client: alwaysClient, compression: { minBytes: 0 } }), 'scope-always', 'tiny');
        expect(alwaysClient.items.get('IDEM#scope-always|idem')?.bodyBr?.B).toBeDefined();
        // Switched off: the compressed record still reads.
        const offReader = new LambderDdbIdempotencyStore({ tableName: 'test-table', client: alwaysClient, compression: false });
        expect((await offReader.peek('scope-always'))?.body).toBe('tiny');

        expect(() => new LambderDdbIdempotencyStore({ tableName: 'test-table', client: offClient, compression: { quality: 12 } })).toThrow();
    });

    it('stores bodies of 1KB+ Brotli-compressed and replays them verbatim; small bodies stay plain', async () => {
        const client = new MemoryDdb();
        const store = makeStore(client);
        const k = 'IDEM#scope-br|idem';

        const big = JSON.stringify({ payload: { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${i}` })) } });
        expect(Buffer.byteLength(big)).toBeGreaterThan(1024);
        const claim = await store.begin('scope-br', { pendingTtlSeconds: 300, fingerprint: 'request-1' });
        if(claim.state !== 'new') throw new Error('expected fresh claim');
        expect(await store.complete('scope-br', claim.ownerToken, { statusCode: 200, headers: {}, body: big, fingerprint: 'request-1', ttlSeconds: 60 })).toBe('stored');

        const item = client.items.get(k)!;
        expect(item.body).toBe(undefined);
        expect(item.bodyBr?.B).toBeDefined();
        expect((item.bodyBr!.B as Uint8Array).byteLength).toBeLessThan(Buffer.byteLength(big));
        expect(Number(item.bodyBytes?.N)).toBe(Buffer.byteLength(big));
        expect((await store.peek('scope-br'))?.body).toBe(big);

        // Below the threshold: plain string attribute, no compression.
        const claim2 = await store.begin('scope-plain', { pendingTtlSeconds: 300, fingerprint: 'request-1' });
        if(claim2.state !== 'new') throw new Error('expected fresh claim');
        await store.complete('scope-plain', claim2.ownerToken, { statusCode: 200, headers: {}, body: 'tiny', fingerprint: 'request-1', ttlSeconds: 60 });
        expect(client.items.get('IDEM#scope-plain|idem')?.body?.S).toBe('tiny');
        expect((await store.peek('scope-plain'))?.body).toBe('tiny');
    });

    it('refuses a duplicate while the original is still pending', async () => {
        const client = new MemoryDdb();
        const lambder = build(client);
        const now = Math.floor(Date.now() / 1000);
        // Pre-seed an unexpired pending claim for this scope (public scope:
        // key-only), taken by this same request: its payload's fingerprint.
        client.items.set(`${keyOnlyPartition('test.op', KEY_BUSY)}|idem`, {
            pk: { S: keyOnlyPartition('test.op', KEY_BUSY) }, sk: { S: 'idem' },
            state: { S: 'pending' }, expiresAt: { N: String(now + 100) },
            fingerprint: { S: nodeCrypto.createHash('sha256').update(canonicalJson({ payload: { value: 'a' }, guardInputs: {} })).digest('hex') },
        });

        const result = await lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: KEY_BUSY }), createMockContext());
        expect(result.statusCode).toBe(409);
        expect(JSON.parse(result.body || '{}').refusal).toEqual({ type: 'warning', code: 'lambder/duplicate-in-flight', content: 'This request is already being processed.' });
    });

    it('refuses a key whose record keeps no fingerprint as reused, rather than replaying it or running over it', async () => {
        // An item another writer left in the table (a custom store, a script)
        // cannot be tied to this request, pending or settled. The key-reused
        // 409 is the answer a key scope moves past; replaying would hand an
        // unknown answer to whoever holds the key, and running would ignore
        // an original that may be in flight.
        let runs = 0;
        const client = new MemoryDdb();
        const lambder = build(client, () => { runs += 1; });
        const now = Math.floor(Date.now() / 1000);
        const plantWithoutFingerprint = (key: string, attributes: Record<string, { S: string } | { N: string }>) => client.items.set(`${keyOnlyPartition('test.op', key)}|idem`, {
            pk: { S: keyOnlyPartition('test.op', key) }, sk: { S: 'idem' }, expiresAt: { N: String(now + 100) }, ...attributes,
        });
        plantWithoutFingerprint(KEY_1, { state: { S: 'done' }, statusCode: { N: '200' }, body: { S: '{"foreign":true}' } });
        plantWithoutFingerprint(KEY_BUSY, { state: { S: 'pending' }, ownerToken: { S: 'someone-else' } });

        for(const key of [KEY_1, KEY_BUSY]){
            const result = await lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: key }), createMockContext());
            expect(result.statusCode).toBe(409);
            expect(JSON.parse(result.body || '{}').refusal).toMatchObject({ code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused });
        }
        expect(runs).toBe(0);
    });

    it('releases the claim when the handler crashes, so a retry re-executes', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        const app = initLambder().create({ files: testPublicFiles(), apiPath: '/api', idempotency: { store: makeStore(client) } });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            crashy: app.defineApi({ ...testSchema, idempotency: true }, async (ctx) => {
                runs += 1;
                if(runs === 1) throw new Error('boom');
                return { result: 'recovered' };
            }),
        }));

        const call = () => lambder.render(createApiEvent('test.crashy', { value: 'a' }, { idempotencyKey: KEY_2 }), createMockContext());
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
        client.items.set(`${keyOnlyPartition('test.op', KEY_OLD)}|idem`, {
            pk: { S: keyOnlyPartition('test.op', KEY_OLD) }, sk: { S: 'idem' },
            state: { S: 'done' }, statusCode: { N: '200' }, body: { S: '{"stale":true}' },
            expiresAt: { N: String(now - 10) },
        });

        const result = await lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: KEY_OLD }), createMockContext());
        expect(runs).toBe(1);
        expect(JSON.parse(result.body || '{}').payload.result).toBe('ran:a');
    });

    it('refuses malformed keys with a 400 envelope: too long, and too short to be unguessable', async () => {
        const lambder = build(new MemoryDdb());
        const tooLong = await lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: 'x'.repeat(201) }), createMockContext());
        expect(tooLong.statusCode).toBe(400);
        const tooShort = await lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: 'short-key' }), createMockContext());
        expect(tooShort.statusCode).toBe(400);
    });

    it('fails open by default when DynamoDB is down: the handler still runs, without dedupe', async () => {
        let runs = 0;
        const client = new MemoryDdb();
        client.failAll = true;
        const lambder = build(client, () => { runs += 1; });
        const call = () => lambder.render(createApiEvent('test.op', { value: 'a' }, { idempotencyKey: KEY_3 }), createMockContext());
        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(200);
        expect(runs).toBe(2);
    });
});

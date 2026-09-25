/**
 * An idempotency key belongs to one request: the payload it was first sent
 * with. A retry of that request replays its answer, whatever single-use token
 * rides beside it; the same key with another payload is refused, rather than
 * handed the first request's answer. And a key scope passed as the call's key
 * moves on by itself once an answer settles the operation, and only then.
 *
 * The two scenarios the rule exists for:
 * - a stale refusal: qty 10 is refused ("only 5 in stock"), the person fixes
 *   it to qty 2 and resubmits, and would be handed the stored refusal for a
 *   day;
 * - a lost edit: qty 3 times out after it was processed, the person edits to
 *   qty 4 and resubmits under the same key, and would be handed qty 3's
 *   success while only qty 3 was ever placed.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import LambderCaller from '../src/client/LambderCaller.js';
import { LAMBDER_REFUSAL_CODES } from '../src/shared/wire/LambderApiRefusal.js';
import { beginIdempotentAttempt, createIdempotencyKeyScope, IDEMPOTENT_ATTEMPT_NOT_SENT, type LambderIdempotentAttemptOutcome } from '../src/shared/wire/LambderIdempotencyKeyScope.js';
import LambderInvokeCaller from '../src/invoke/LambderInvokeCaller.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import { refuse } from '../src/shared/wire/LambderApiRefusal.js';
import { lambderTestApp, assertApiFailure, assertApiSuccess } from '../src/testing.js';
import { LambderApiOutputValidationError } from '../src/api/LambderApiOutputValidationError.js';

const createShop = () => {
    const placed: number[] = [];
    const app = lambderTestApp(initLambder().create({
        apiPath: '/api',
        idempotency: { store: new LambderMemoryIdempotencyStore() },
        guards: { coupon: { guardInput: z.object({ code: z.string() }), handler: async () => {} } },
    }).addApi('order.place', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
        async (ctx, res) => {
            if(ctx.apiPayload.qty > 5) return res.api(null, { errorMessage: 'Only 5 in stock.' });
            placed.push(ctx.apiPayload.qty);
            return res.api({ placed: ctx.apiPayload.qty });
        })
        .addApi('order.withCoupon', { input: z.object({ qty: z.number(), note: z.string() }), output: z.object({ placed: z.number() }), idempotency: true, guards: 'coupon' },
            async (ctx, res) => res.api({ placed: ctx.apiPayload.qty })));
    return { app, placed };
};

const KEY = 'order-key-0123456789abcdef';

describe('A key belongs to the request it was first used for', () => {
    it('replays the same request, and refuses a different payload under the key instead of replaying', async () => {
        const { app, placed } = createShop();
        const visitor = app.visitor();

        expect(await visitor.api('order.place', { qty: 3 }, { idempotencyKey: KEY })).toEqual({ placed: 3 });
        // The retry of qty 3: replayed, not placed again.
        expect(await visitor.api('order.place', { qty: 3 }, { idempotencyKey: KEY })).toEqual({ placed: 3 });
        // The edit to qty 4 under the same key: refused, not told qty 3 went through.
        const edited = await visitor.apiOutcome('order.place', { qty: 4 }, { idempotencyKey: KEY });
        assertApiFailure(edited, 'errorMessage', { code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused, status: 409 });
        expect(placed).toEqual([3]);
    });

    it('does not hand a corrected request the refusal stored for the first', async () => {
        const { app, placed } = createShop();
        const visitor = app.visitor();

        assertApiFailure(await visitor.apiOutcome('order.place', { qty: 10 }, { idempotencyKey: KEY }), 'errorMessage');
        const corrected = await visitor.apiOutcome('order.place', { qty: 2 }, { idempotencyKey: KEY });
        assertApiFailure(corrected, 'errorMessage', { code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused });
        expect(placed).toEqual([]);
    });

    it('reads the payload alone, whatever the guard inputs beside it and the order its keys were written in', async () => {
        const { app } = createShop();
        const visitor = app.visitor();

        assertApiSuccess(await visitor.apiOutcome('order.withCoupon', { qty: 1, note: 'n' }, { idempotencyKey: KEY, guardInputs: { coupon: { code: 'A' } } }));
        assertApiSuccess(await visitor.apiOutcome('order.withCoupon', { note: 'n', qty: 1 }, { idempotencyKey: KEY, guardInputs: { coupon: { code: 'B' } } }));
        assertApiFailure(await visitor.apiOutcome('order.withCoupon', { qty: 2, note: 'n' }, { idempotencyKey: KEY, guardInputs: { coupon: { code: 'A' } } }),
            'errorMessage', { code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused });
    });

    it('tells apart payloads that differ only under a "__proto__" key', async () => {
        const { app, placed } = createShop();
        const visitor = app.visitor();
        // JSON.parse makes "__proto__" an own key, as the server's parse of
        // the posted body does. The fingerprint dropped it, so both payloads
        // read as { qty: 1 } and the second was handed the first's answer.
        const first = JSON.parse('{"qty":1,"__proto__":{"note":"a"}}') as { qty: number };
        const second = JSON.parse('{"qty":1,"__proto__":{"note":"b"}}') as { qty: number };

        assertApiSuccess(await visitor.apiOutcome('order.place', first, { idempotencyKey: KEY }));
        assertApiFailure(await visitor.apiOutcome('order.place', second, { idempotencyKey: KEY }),
            'errorMessage', { code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused });
        expect(placed).toEqual([1]);
    });
});

describe('A key scope as the call\'s key', () => {
    it('keeps its key until an answer settles the operation, then moves on, so a corrected request goes through', async () => {
        const { app, placed } = createShop();
        const visitor = app.visitor();
        const scope = createIdempotencyKeyScope();
        const first = scope.current;

        assertApiFailure(await visitor.apiOutcome('order.place', { qty: 10 }, { idempotencyKey: scope }), 'errorMessage');
        expect(scope.current).not.toBe(first);

        const second = scope.current;
        expect(await visitor.api('order.place', { qty: 2 }, { idempotencyKey: scope })).toEqual({ placed: 2 });
        expect(scope.current).not.toBe(second);
        expect(placed).toEqual([2]);
    });

    /** Whether one attempt ending with `outcome` moves a fresh scope on, after `before` attempts ended as given. */
    const rotatesAfter = (outcome: LambderIdempotentAttemptOutcome, ...before: typeof outcome[]) => {
        const scope = createIdempotencyKeyScope();
        for(const earlier of before) beginIdempotentAttempt(scope).settle(earlier);
        const key = scope.current;
        beginIdempotentAttempt(scope).settle(outcome);
        return scope.current !== key;
    };
    const timedOut = { ok: false, reason: 'timeout' };

    it('settles on a success or a refusal of the request, and not on a failure that says nothing', () => {
        expect(rotatesAfter({ ok: true })).toBe(true);
        expect(rotatesAfter({ ok: false, reason: 'errorMessage', errorMessage: { code: 'app/out-of-stock' } })).toBe(true);
        expect(rotatesAfter({ ok: false, reason: 'validation' })).toBe(true);
        expect(rotatesAfter({ ok: false, reason: 'notAuthorized' })).toBe(true);
        expect(rotatesAfter({ ok: false, reason: 'errorMessage', errorMessage: { code: LAMBDER_REFUSAL_CODES.duplicateInFlight } })).toBe(false);
        expect(rotatesAfter({ ok: false, reason: 'errorMessage', status: 429, errorMessage: { code: LAMBDER_REFUSAL_CODES.rateLimited } })).toBe(false);
        expect(rotatesAfter({ ok: false, reason: 'errorMessage', status: 429, errorMessage: { code: 'app/slow-down' } })).toBe(false);
        expect(rotatesAfter({ ok: false, reason: 'server', status: 500 })).toBe(false);
        expect(rotatesAfter(timedOut)).toBe(false);
        expect(rotatesAfter({ ok: false, reason: 'sessionExpired' })).toBe(false);
        expect(rotatesAfter({ ok: false, reason: 'versionExpired' })).toBe(false);
    });

    it('keeps a key an unanswered attempt may have used through a refusal, and lets it go on a success or a key reused', () => {
        const refused = { ok: false, reason: 'notAuthorized' };
        expect(rotatesAfter(refused, timedOut)).toBe(false);
        expect(rotatesAfter(refused, { ok: false, reason: 'errorMessage', errorMessage: { code: LAMBDER_REFUSAL_CODES.duplicateInFlight } })).toBe(false);
        expect(rotatesAfter(refused, { ok: false, reason: 'errorMessage', status: 429 })).toBe(true);
        expect(rotatesAfter({ ok: true }, timedOut)).toBe(true);
        expect(rotatesAfter({ ok: false, reason: 'errorMessage', errorMessage: { code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused } }, timedOut)).toBe(true);
    });

    it('keeps the key through a refusal while another attempt under it is still in flight', () => {
        const scope = createIdempotencyKeyScope();
        const key = scope.current;
        const first = beginIdempotentAttempt(scope);
        // A double-tap resent a spent token and was refused before the claim.
        beginIdempotentAttempt(scope).settle({ ok: false, reason: 'notAuthorized' });
        expect(scope.current).toBe(key);
        first.settle(timedOut);
        beginIdempotentAttempt(scope).settle({ ok: false, reason: 'notAuthorized' });
        expect(scope.current).toBe(key);
    });

    it('counts an attempt that sent nothing as untried, and each attempt once', () => {
        expect(rotatesAfter({ ok: false, reason: 'notAuthorized' }, IDEMPOTENT_ATTEMPT_NOT_SENT)).toBe(true);
        const scope = createIdempotencyKeyScope();
        const attempt = beginIdempotentAttempt(scope);
        attempt.settle(IDEMPOTENT_ATTEMPT_NOT_SENT);
        attempt.settle(timedOut);
        const key = scope.current;
        beginIdempotentAttempt(scope).settle({ ok: false, reason: 'validation' });
        expect(scope.current).not.toBe(key);
    });

    it('is told of an unanswered attempt even when the caller\'s error handler throws', async () => {
        let calls = 0;
        const caller = new LambderCaller({
            apiPath: '/api', isCorsEnabled: false,
            errorHandler: () => { throw new Error('the app\'s handler broke'); },
            transport: async () => {
                calls += 1;
                if(calls === 1) throw new Error('offline');
                return { status: 200, header: () => null, json: async () => ({ apiVersion: null, errorMessage: 'Verification failed.' }), text: async () => '' };
            },
        });
        const scope = createIdempotencyKeyScope();
        const key = scope.current;
        expect((await caller.apiOutcome('order.place', {}, { idempotencyKey: scope })).ok).toBe(false);
        // The retry is refused before the claim: the first may have run, so the key stays.
        expect((await caller.apiOutcome('order.place', {}, { idempotencyKey: scope })).ok).toBe(false);
        expect(scope.current).toBe(key);
    });

    it('reads anything but a scope as a plain key, null from an untyped caller included', () => {
        expect(beginIdempotentAttempt(null as never).key).toBeNull();
        expect(beginIdempotentAttempt('plain-key-0123456789').key).toBe('plain-key-0123456789');
    });

    it('ignores an answer to a key it has already moved past', () => {
        const scope = createIdempotencyKeyScope();
        const slow = beginIdempotentAttempt(scope);
        beginIdempotentAttempt(scope).settle({ ok: true });
        const current = scope.current;
        slow.settle({ ok: true });
        expect(scope.current).toBe(current);
    });
});

describe('A store with no room for a claim', () => {
    it('answers the in-flight 409, so a key scope keeps its key for the retry', async () => {
        // The store refuses the claim as "pending" without anybody else's
        // record behind it. Read as another request's key, the refusal would
        // be the key-reused 409, and the scope would move on as though the
        // operation were settled.
        const store = new LambderMemoryIdempotencyStore({ maxEntries: 1 });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        let releaseOrder!: () => void;
        const orderGate = new Promise<void>((resolve) => { releaseOrder = resolve; });
        const app = lambderTestApp(initLambder().create({ apiPath: '/api', idempotency: { store } })
            .addApi('order.place', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
                async (ctx, res) => { await orderGate; return res.api({ placed: ctx.apiPayload.qty }); }), { idempotency: { store } });
        try {
            // The one record the store has room for: an order still running.
            const running = app.visitor().apiOutcome('order.place', { qty: 1 }, { idempotencyKey: createIdempotencyKeyScope() });
            await vi.waitFor(() => expect(store.size).toBe(1));

            const scope = createIdempotencyKeyScope();
            const key = scope.current;
            const refused = await app.visitor().apiOutcome('order.place', { qty: 2 }, { idempotencyKey: scope });
            assertApiFailure(refused, 'errorMessage', { code: LAMBDER_REFUSAL_CODES.duplicateInFlight, status: 409 });
            expect(scope.current).toBe(key);

            releaseOrder();
            assertApiSuccess(await running);
        } finally {
            logged.mockRestore();
        }
    });
});

describe('A retry after a timeout runs the operation once', () => {
    /** A shop behind a single-use captcha, a per-IP limit and a handler slow enough to time out on. */
    const createGuardedShop = () => {
        const spent = new Set<string>();
        const placed: number[] = [];
        const lambder = initLambder().create({
            apiPath: '/api',
            idempotency: { store: new LambderMemoryIdempotencyStore() },
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: { onePerIp: { per: 'ip', perMin: 1 } },
            },
            guards: {
                captcha: lambderGuard({
                    runAt: 'afterInputValidation',
                    guardInput: z.object({ captchaToken: z.string() }),
                    handler: async (_ctx, { captchaToken }) => {
                        if(spent.has(captchaToken)) refuse('Verification failed, please retry.');
                        spent.add(captchaToken);
                    },
                }),
            },
        }).addApi('order.place', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true, guards: 'captcha' },
            async (ctx, res) => {
                await new Promise((resolve) => setTimeout(resolve, 60));
                placed.push(ctx.apiPayload.qty);
                return res.api({ placed: placed.length });
            })
            .addApi('order.limited', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true, rateLimit: 'onePerIp' },
                async (ctx, res) => {
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    placed.push(ctx.apiPayload.qty);
                    return res.api({ placed: placed.length });
                });
        const caller = new LambderInvokeCaller<typeof lambder.ApiContract>({ functionName: 'shop', transport: LambderInvokeCaller.localTransport(lambder.getHandler()) });
        return { caller, placed };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

    it('replays the original to a retry carrying a fresh single-use token', async () => {
        const { caller, placed } = createGuardedShop();
        const scope = createIdempotencyKeyScope();
        const first = await caller.apiOutcome('order.place', { qty: 1 }, { idempotencyKey: scope, guardInputs: { captcha: { captchaToken: 'c1' } }, timeoutMs: 20 });
        expect(first.ok ? 'ok' : first.reason).toBe('timeout');
        await settle();
        const retry = await caller.apiOutcome('order.place', { qty: 1 }, { idempotencyKey: scope, guardInputs: { captcha: { captchaToken: 'c2' } } });
        expect(retry.ok && retry.payload).toEqual({ placed: 1 });
        expect(placed).toEqual([1]);
    });

    it('keeps the key through a retry the guard refuses, so the next attempt replays', async () => {
        const { caller, placed } = createGuardedShop();
        const scope = createIdempotencyKeyScope();
        await caller.apiOutcome('order.place', { qty: 1 }, { idempotencyKey: scope, guardInputs: { captcha: { captchaToken: 'c1' } }, timeoutMs: 20 });
        // While the original still runs, the page resends the spent token:
        // refused by the guard, before the replay record is claimed.
        const reused = await caller.apiOutcome('order.place', { qty: 1 }, { idempotencyKey: scope, guardInputs: { captcha: { captchaToken: 'c1' } } });
        expect(reused.ok ? 'ok' : reused.reason).toBe('errorMessage');
        await settle();
        const retry = await caller.apiOutcome('order.place', { qty: 1 }, { idempotencyKey: scope, guardInputs: { captcha: { captchaToken: 'c3' } } });
        expect(retry.ok && retry.payload).toEqual({ placed: 1 });
        expect(placed).toEqual([1]);
    });

    it('keeps the key through a double-tap the guard refuses while the first tap still runs', async () => {
        const { caller, placed } = createGuardedShop();
        const scope = createIdempotencyKeyScope();
        const firstTap = caller.apiOutcome('order.place', { qty: 1 }, { idempotencyKey: scope, guardInputs: { captcha: { captchaToken: 'c1' } }, timeoutMs: 30 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const secondTap = await caller.apiOutcome('order.place', { qty: 1 }, { idempotencyKey: scope, guardInputs: { captcha: { captchaToken: 'c1' } } });
        expect(secondTap.ok ? 'ok' : secondTap.reason).toBe('errorMessage');
        expect((await firstTap).ok).toBe(false);
        await settle();
        const retry = await caller.apiOutcome('order.place', { qty: 1 }, { idempotencyKey: scope, guardInputs: { captcha: { captchaToken: 'c2' } } });
        expect(retry.ok && retry.payload).toEqual({ placed: 1 });
        expect(placed).toEqual([1]);
    });

    it('keeps the key through a rate-limit refusal', async () => {
        const { caller, placed } = createGuardedShop();
        const scope = createIdempotencyKeyScope();
        const key = scope.current;
        await caller.apiOutcome('order.limited', { qty: 1 }, { idempotencyKey: scope, timeoutMs: 20 });
        await settle();
        const limited = await caller.apiOutcome('order.limited', { qty: 1 }, { idempotencyKey: scope });
        expect(limited.ok ? 'ok' : limited.status).toBe(429);
        expect(scope.current).toBe(key);
        expect(placed).toEqual([1]);
    });
});

describe('A call that could not be built', () => {
    it('leaves the invoke caller\'s key untried, as the browser caller does, so the next refusal moves it', async () => {
        const lambder = initLambder().create({ apiPath: '/api', idempotency: { store: new LambderMemoryIdempotencyStore() } })
            .addApi('order.place', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true },
                async (ctx, res) => res.api({ placed: ctx.apiPayload.qty }));
        const caller = new LambderInvokeCaller<typeof lambder.ApiContract>({ functionName: 'shop', transport: LambderInvokeCaller.localTransport(lambder.getHandler()) });
        const scope = createIdempotencyKeyScope();
        const key = scope.current;

        // A BigInt cannot be serialized, so nothing is sent.
        const unbuilt = await caller.apiOutcome('order.place', { qty: 1n } as never, { idempotencyKey: scope });
        expect(unbuilt.ok ? 'ok' : unbuilt.reason).toBe('unknown');
        expect(scope.current).toBe(key);
        // A refusal of the request then settles the operation, since no
        // earlier attempt under the key may have run it.
        await caller.apiOutcome('order.place', { qty: 'one' } as never, { idempotencyKey: scope });
        expect(scope.current).not.toBe(key);
    });
});

describe('An answer that breaks its output schema', () => {
    it('is recorded as the key\'s answer, so a retry is told the crash instead of running the operation again', async () => {
        const charged: number[] = [];
        const crashes: unknown[] = [];
        const lambder = initLambder().create({
            apiPath: '/api',
            idempotency: { store: new LambderMemoryIdempotencyStore() },
            crashes: { report: (error) => { crashes.push(error); } },
        }).addApi('card.charge', { input: z.object({ cents: z.number() }), output: z.object({ receipt: z.string() }), idempotency: true },
            async (ctx, res) => {
                charged.push(ctx.apiPayload.cents);
                // A row whose column came back a number: the charge has
                // happened, and the answer breaks the schema after it.
                return res.api({ receipt: 42 } as unknown as { receipt: string });
            });
        const caller = new LambderInvokeCaller<typeof lambder.ApiContract>({ functionName: 'shop', transport: LambderInvokeCaller.localTransport(lambder.getHandler()) });

        for(let attempt = 0; attempt < 3; attempt++){
            const outcome = await caller.apiOutcome('card.charge', { cents: 500 }, { idempotencyKey: KEY });
            expect(outcome.ok ? 'ok' : outcome.reason).toBe('server');
        }
        expect(charged).toEqual([500]);
        expect(crashes).toHaveLength(1);
        expect(crashes[0]).toBeInstanceOf(LambderApiOutputValidationError);
        expect(crashes[0]).toMatchObject({ apiName: 'card.charge', zodError: { issues: [{ path: ['receipt'] }] } });
    });

    /**
     * A charge whose output schema throws while its answer is parsed, asked
     * three times under one key: what the handler did, and what the crash
     * reporter was handed.
     */
    const chargeThrice = async (output: z.ZodType<{ receipt: string }, { receipt: string }>) => {
        const charged: number[] = [];
        const crashes: unknown[] = [];
        const lambder = initLambder().create({
            apiPath: '/api',
            idempotency: { store: new LambderMemoryIdempotencyStore() },
            crashes: { report: (error) => { crashes.push(error); } },
        }).addApi('card.charge', { input: z.object({ cents: z.number() }), output, idempotency: true },
            async (ctx, res) => {
                charged.push(ctx.apiPayload.cents);
                return res.api({ receipt: 'r-1' });
            });
        const caller = new LambderInvokeCaller<typeof lambder.ApiContract>({ functionName: 'shop', transport: LambderInvokeCaller.localTransport(lambder.getHandler()) });
        for(let attempt = 0; attempt < 3; attempt++){
            const outcome = await caller.apiOutcome('card.charge', { cents: 500 }, { idempotencyKey: KEY });
            expect(outcome.ok ? 'ok' : outcome.reason).toBe('server');
        }
        return { charged, crashes };
    };

    it('records an output schema that is async the same way, since a synchronous parse throws on it after the handler ran', async () => {
        const { charged, crashes } = await chargeThrice(z.object({ receipt: z.string().refine(async (receipt) => receipt.length > 0) }));

        // Run once; the retries replayed the recorded crash.
        expect(charged).toEqual([500]);
        expect(crashes).toHaveLength(1);
        expect(crashes[0]).toBeInstanceOf(LambderApiOutputValidationError);
        const crash = crashes[0] as LambderApiOutputValidationError;
        expect(crash.cause).toBeInstanceOf(z.core.$ZodAsyncError);
        expect(crash.zodError).toBeNull();
        expect(crash.message).toMatch(/API "card\.charge" has an async refinement or transform in its output schema, and an output schema cannot be async/);
    });

    it('records an output transform that throws the same way, with what it threw as the cause', async () => {
        const ledgerDown = new Error('the ledger could not be reached');
        const { charged, crashes } = await chargeThrice(z.object({ receipt: z.string().transform((): string => { throw ledgerDown; }) }));

        expect(charged).toEqual([500]);
        expect(crashes).toHaveLength(1);
        expect(crashes[0]).toBeInstanceOf(LambderApiOutputValidationError);
        const crash = crashes[0] as LambderApiOutputValidationError;
        expect(crash.cause).toBe(ledgerDown);
        expect(crash.zodError).toBeNull();
        // The app's own message stays in the cause, out of the crash's.
        expect(crash.message).not.toContain('ledger');
    });
});

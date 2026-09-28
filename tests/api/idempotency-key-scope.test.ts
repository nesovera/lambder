/**
 * A key scope and a double-tap: the second tap of an operation still running
 * is answered duplicate-in-flight, and the first tap's own answer is what
 * settles the key. When that answer is a refusal, the corrected request after
 * it goes under a new key rather than being refused as a reused one.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { LAMBDER_REFUSAL_CODES, refuse } from '../../src/shared/wire/LambderApiRefusal.js';
import { beginIdempotentAttempt, createIdempotencyKeyScope } from '../../src/shared/wire/LambderIdempotencyKeyScope.js';
import { lambderTestApp, assertApiFailure } from '../../src/testing.js';

const duplicateInFlight = { ok: false, reason: 'refusal', status: 409, refusal: { code: LAMBDER_REFUSAL_CODES.duplicateInFlight } };
const outOfStock = { ok: false, reason: 'refusal', refusal: { code: 'app/out-of-stock' } };

describe('A key scope under a double-tap', () => {
    it('moves on after the first tap\'s refusal, so the corrected order is placed rather than refused as a reused key', async () => {
        const placed: number[] = [];
        /** Holds the first tap inside its handler until the second tap has its answer. */
        let releaseFirstTap = () => {};
        const firstTapHeld = new Promise<void>((resolve) => { releaseFirstTap = resolve; });
        /** Resolves once the first tap holds the claim, so the second tap is the duplicate whichever call's fingerprint digest finishes first. */
        let firstTapEntered = () => {};
        const firstTapInHandler = new Promise<void>((resolve) => { firstTapEntered = resolve; });
        let handlerRuns = 0;
        const app = lambderTestApp(initLambder().declareRefusals({ 'app/out-of-stock': {} }).create({
            apiPath: '/api',
            idempotency: { store: new LambderMemoryIdempotencyStore() },
        }).addApi('order.place', { input: z.object({ qty: z.number() }), output: z.object({ placed: z.number() }), idempotency: true, refusals: 'app/out-of-stock' },
            async (ctx) => {
                handlerRuns += 1;
                if(handlerRuns === 1){
                    firstTapEntered();
                    await firstTapHeld;
                }
                if(ctx.apiPayload.qty > 5) refuse('Only 5 in stock.', { code: 'app/out-of-stock' });
                placed.push(ctx.apiPayload.qty);
                return { placed: ctx.apiPayload.qty };
            }));
        const visitor = app.visitor();
        const scope = createIdempotencyKeyScope();
        const firstKey = scope.current;

        const firstTap = visitor.apiOutcome('order.place', { qty: 10 }, { idempotencyKey: scope });
        await firstTapInHandler;
        const secondTap = await visitor.apiOutcome('order.place', { qty: 10 }, { idempotencyKey: scope });
        assertApiFailure(secondTap, 'refusal', { code: LAMBDER_REFUSAL_CODES.duplicateInFlight, status: 409 });
        releaseFirstTap();
        assertApiFailure(await firstTap, 'refusal');
        expect(scope.current).not.toBe(firstKey);

        expect(await visitor.api('order.place', { qty: 2 }, { idempotencyKey: scope })).toEqual({ placed: 2 });
        expect(placed).toEqual([2]);
    });

    it('lets the waiting attempt settle the key, whichever way it ends', () => {
        const refusedAfterDuplicate = createIdempotencyKeyScope();
        const refusedKey = refusedAfterDuplicate.current;
        const original = beginIdempotentAttempt(refusedAfterDuplicate);
        beginIdempotentAttempt(refusedAfterDuplicate).settle(duplicateInFlight);
        expect(refusedAfterDuplicate.current).toBe(refusedKey);
        original.settle(outOfStock);
        expect(refusedAfterDuplicate.current).not.toBe(refusedKey);

        // The original never answered: it may have run, so a refusal after it keeps the key.
        const unansweredAfterDuplicate = createIdempotencyKeyScope();
        const unansweredKey = unansweredAfterDuplicate.current;
        const lost = beginIdempotentAttempt(unansweredAfterDuplicate);
        beginIdempotentAttempt(unansweredAfterDuplicate).settle(duplicateInFlight);
        lost.settle({ ok: false, reason: 'timeout' });
        beginIdempotentAttempt(unansweredAfterDuplicate).settle(outOfStock);
        expect(unansweredAfterDuplicate.current).toBe(unansweredKey);
    });

    it('marks the key when no attempt of its own is waiting, so a refusal after the duplicate keeps it', () => {
        // The original is one the scope cannot see (an attempt it already
        // counted as ended), and may have run the operation.
        const scope = createIdempotencyKeyScope();
        const key = scope.current;
        beginIdempotentAttempt(scope).settle(duplicateInFlight);
        beginIdempotentAttempt(scope).settle(outOfStock);
        expect(scope.current).toBe(key);
    });
});

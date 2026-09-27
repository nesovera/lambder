/**
 * LambderBackoffTimer: the ladder's bounds, one wait at a time, and the
 * promise form the upload runner waits on.
 *
 * With Math.random pinned at one half, every jittered wait is the base plus
 * half the ceiling, so the ladder is exact: base 100, cap 350 gives 150, 200,
 * 275, 275.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LambderBackoffTimer } from '../../src/shared/util/LambderBackoffTimer.js';

describe('LambderBackoffTimer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /** Asserts `run` fires after exactly `waitMs` from now, not a millisecond sooner. */
    const expectFiresAfter = (run: ReturnType<typeof vi.fn>, waitMs: number) => {
        const before = run.mock.calls.length;
        vi.advanceTimersByTime(waitMs - 1);
        expect(run).toHaveBeenCalledTimes(before);
        vi.advanceTimersByTime(1);
        expect(run).toHaveBeenCalledTimes(before + 1);
    };

    const expectRetryWait = (timer: LambderBackoffTimer, waitMs: number) => {
        const run = vi.fn();
        timer.retry(run);
        expectFiresAfter(run, waitMs);
    };

    it('waits the base plus a random share of a ceiling that doubles per attempt, the whole never past maxMs', () => {
        // The share's ceiling is 100, 200, then capped at 350 less the base.
        const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
        expectRetryWait(timer, 150);
        expectRetryWait(timer, 200);
        expectRetryWait(timer, 225);
        expectRetryWait(timer, 225);
    });

    it('waits exactly maxMs at the top of the ladder without jitter, and twice the base first', () => {
        const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350, jitter: 'none' });
        expectRetryWait(timer, 200);
        expectRetryWait(timer, 300);
        expectRetryWait(timer, 350);
        expectRetryWait(timer, 350);
    });

    it('starts from the shortest wait again after a reset', () => {
        const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
        expectRetryWait(timer, 150);
        expectRetryWait(timer, 200);
        timer.reset();
        expectRetryWait(timer, 150);
    });

    it('grows by the factor it is given, and waits the whole ceiling without jitter', () => {
        const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 10_000, factor: 3, jitter: 'none' });
        expectRetryWait(timer, 200);
        expectRetryWait(timer, 400);
        expectRetryWait(timer, 1_000);
    });

    it('has defaults: a second, doubling, up to a minute, fully jittered', () => {
        const timer = new LambderBackoffTimer();
        expectRetryWait(timer, 1_500);
        expectRetryWait(timer, 2_000);
    });

    it('refuses a negative time, a longest wait below the shortest and a factor below one, naming the option', () => {
        expect(() => new LambderBackoffTimer({ baseMs: -1 })).toThrow(/baseMs must be a number of 0 or more/);
        expect(() => new LambderBackoffTimer({ maxMs: Number.NaN })).toThrow(/maxMs/);
        expect(() => new LambderBackoffTimer({ baseMs: 100, maxMs: 50 })).toThrow(/maxMs must be a number of 100 or more/);
        expect(() => new LambderBackoffTimer({ factor: 0.5 })).toThrow(/factor must be a number of 1 or more/);
        // A longest wait of the base is a ladder of one rung: every wait is the base.
        const flat = new LambderBackoffTimer({ baseMs: 100, maxMs: 100 });
        expectRetryWait(flat, 100);
        expectRetryWait(flat, 100);
        // A base past the default longest wait moves the default with it.
        expectRetryWait(new LambderBackoffTimer({ baseMs: 90_000 }), 90_000);
    });

    it('waits a fixed time with after, off the ladder', () => {
        const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
        const run = vi.fn();
        timer.after(1_000, run);
        expectFiresAfter(run, 1_000);
        // Nothing failed, so the next retry is still the first rung.
        expectRetryWait(timer, 150);
    });

    it('holds one wait at a time, whichever kind, replacing the one pending', () => {
        const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
        const first = vi.fn();
        const second = vi.fn();
        const third = vi.fn();
        timer.retry(first);
        timer.after(50, second);
        timer.retry(third);
        vi.advanceTimersByTime(10_000);
        expect(first).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
        expect(third).toHaveBeenCalledTimes(1);
    });

    it('drops the pending wait on cancel, and still counts the failure', () => {
        const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
        const dropped = vi.fn();
        timer.retry(dropped);
        expect(timer.pending).toBe(true);
        timer.cancel();
        expect(timer.pending).toBe(false);
        vi.advanceTimersByTime(10_000);
        expect(dropped).not.toHaveBeenCalled();
        expectRetryWait(timer, 200);
    });

    it('is no longer pending by the time the wait runs, so what it runs may schedule again', () => {
        const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
        let pendingInside: boolean | null = null;
        timer.retry(() => { pendingInside = timer.pending; });
        vi.advanceTimersByTime(150);
        expect(pendingInside).toBe(false);
    });

    describe('wait', () => {
        it('resolves after the next rung, climbing the same ladder as retry', async () => {
            const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
            let settled = false;
            const pending = timer.wait().then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(149);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await pending;
            expect(settled).toBe(true);
            expect(timer.pending).toBe(false);
            expectRetryWait(timer, 200);
        });

        it('rejects with the signal\'s reason when the signal aborts, and at once when it already has', async () => {
            const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
            const controller = new AbortController();
            const pending = timer.wait(controller.signal);
            controller.abort(new Error('the person left the page'));
            await expect(pending).rejects.toThrow('the person left the page');
            expect(timer.pending).toBe(false);

            await expect(timer.wait(controller.signal)).rejects.toThrow('the person left the page');
            // An abort a runtime carries no reason for still rejects with an Error.
            const bare = new AbortController();
            const waiting = timer.wait(bare.signal);
            Object.defineProperty(bare.signal, 'reason', { value: undefined });
            bare.abort();
            await expect(waiting).rejects.toThrow(/was aborted/);
        });

        it('rejects rather than hangs when cancel() or a later wait drops it', async () => {
            const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
            const cancelled = timer.wait();
            timer.cancel();
            await expect(cancelled).rejects.toThrow(/dropped by cancel\(\) or by a later wait/);

            const replaced = timer.wait();
            const run = vi.fn();
            timer.retry(run);
            await expect(replaced).rejects.toThrow(/dropped/);
            vi.advanceTimersByTime(1_000);
            expect(run).toHaveBeenCalledTimes(1);
        });

        it('lets go of the signal once it has resolved', async () => {
            const timer = new LambderBackoffTimer({ baseMs: 100, maxMs: 350 });
            const controller = new AbortController();
            const pending = timer.wait(controller.signal);
            await vi.advanceTimersByTimeAsync(150);
            await pending;
            // An abort after the wait ran touches nothing the timer holds.
            controller.abort();
            expect(timer.pending).toBe(false);
        });
    });
});

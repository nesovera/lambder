/**
 * One call's abort wiring: who gave the call up (its own timeout, or the
 * site's signal) and when; and stopWaitingWhenAborted, the end of a wait on
 * work that cannot be cancelled, whichever way the signal reached it.
 */

import { describe, it, expect } from 'vitest';
import { createCallAbort, stopWaitingWhenAborted } from '../../src/shared/util/LambderCallAbort.js';

const after = <T>(ms: number, settle: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(settle()), ms));

describe('createCallAbort', () => {
    it('names the site\'s own signal aborted and the call\'s own timeout timeout, before sending and after answering', async () => {
        const site = new AbortController();
        const bySite = createCallAbort({ signal: site.signal });
        expect(bySite.abortReason()).toBeNull();
        expect(bySite.abortFailure('beforeSending')).toBeNull();
        site.abort();
        expect(bySite.abortReason()).toBe('aborted');
        expect(bySite.abortFailure('beforeSending')).toMatchObject({ reason: 'aborted', error: { message: 'Request aborted by its signal; the call was given up on before it was sent.' } });
        bySite.detach();

        const byTimer = createCallAbort({ timeoutMs: 5, signal: new AbortController().signal });
        await after(15, () => undefined);
        expect(byTimer.abortReason()).toBe('timeout');
        expect(byTimer.abortFailure('afterAnswering')).toMatchObject({ reason: 'timeout', error: { message: 'Request timed out after 5ms; the answer arrived too late to be used.' } });
        byTimer.detach();
    });

    it('names a call a site deadline ended timeout, alone or inside AbortSignal.any, so it is reported rather than read as given up', async () => {
        const deadline = createCallAbort({ signal: AbortSignal.timeout(5) });
        const combined = createCallAbort({ timeoutMs: 1000, signal: AbortSignal.any([new AbortController().signal, AbortSignal.timeout(5)]) });
        await after(20, () => undefined);
        expect(deadline.abortFailure('beforeSending')).toMatchObject({ reason: 'timeout', error: { message: 'Request timed out by its signal; the call was given up on before it was sent.' } });
        expect(combined.abortFailure('afterAnswering')).toMatchObject({ reason: 'timeout', error: { message: 'Request timed out by its signal; the answer arrived too late to be used.' } });
        for(const each of [deadline, combined]) each.detach();
    });

    it('lets the first abort name the call: a timeout firing after the site gave up leaves it aborted', async () => {
        const site = new AbortController();
        const abort = createCallAbort({ timeoutMs: 10, signal: site.signal });
        site.abort();
        await after(20, () => undefined);
        expect(abort.abortReason()).toBe('aborted');

        const alreadyAborted = createCallAbort({ timeoutMs: 10, signal: AbortSignal.abort() });
        await after(20, () => undefined);
        expect(alreadyAborted.abortReason()).toBe('aborted');

        // And the other way round: a site that aborts after the timeout fired finds a timed-out call.
        const late = new AbortController();
        const timedOut = createCallAbort({ timeoutMs: 5, signal: late.signal });
        await after(15, () => undefined);
        late.abort();
        expect(timedOut.abortReason()).toBe('timeout');
        for(const each of [abort, alreadyAborted, timedOut]) each.detach();
    });
});

describe('stopWaitingWhenAborted', () => {
    it('ends the wait with the signal\'s reason when it aborts during the wait', async () => {
        const controller = new AbortController();
        const reason = new Error('given up');
        const waiting = stopWaitingWhenAborted(after(50, () => 'late'), controller.signal);
        controller.abort(reason);

        await expect(waiting).rejects.toBe(reason);
    });

    it('ends the wait at once for a signal that aborted before it began, which fires no event', async () => {
        const controller = new AbortController();
        const reason = new Error('given up before the call');
        controller.abort(reason);

        await expect(stopWaitingWhenAborted(after(20, () => 'late'), controller.signal)).rejects.toBe(reason);
    });

    it('still settles what the abandoned work rejects with later, so it never surfaces as an unhandled rejection', async () => {
        const controller = new AbortController();
        controller.abort(new Error('given up'));
        const failsLater = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('the work failed after the wait ended')), 5));

        await expect(stopWaitingWhenAborted(failsLater, controller.signal)).rejects.toThrow('given up');
        await after(20, () => undefined);
    });

    it('hands back the work\'s own result when the signal never aborts, and the work itself without one', async () => {
        const controller = new AbortController();
        await expect(stopWaitingWhenAborted(after(1, () => 'done'), controller.signal)).resolves.toBe('done');
        const work = after(1, () => 'done');
        expect(stopWaitingWhenAborted(work, undefined)).toBe(work);
    });
});

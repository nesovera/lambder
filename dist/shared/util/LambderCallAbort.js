/**
 * One call's abort wiring, shared by LambderCaller (a browser over fetch) and
 * LambderInvokeCaller (a server over a Lambda invoke).
 *
 * Both give a call a `timeoutMs`, both let the site pass its own AbortSignal,
 * and both have to answer the same three questions: which signal does the
 * transport get, has the call already been given up on before it is sent, and
 * did the answer arrive after it was given up on. One implementation keeps
 * the two from drifting apart: a caller that believed a late answer would
 * report `ok: true` for a call its site had already abandoned.
 *
 * Who gave up matters as much as when. A call's own timeout is a failure the
 * callers report; the site's own signal is the site's choice (a superseded
 * read, a view that closed), which nothing should report as something gone
 * wrong, so the two are told apart here, once. A site signal can carry a
 * deadline of its own, though: AbortSignal.timeout() aborts with a
 * TimeoutError, alone or inside AbortSignal.any(), and a call it ends is
 * timed out like one its own timeoutMs ended. Read as the site's choice, it
 * would fail with nothing reporting it.
 *
 * The listener on an external signal is removed in detach() rather than left
 * to `once`: a site's signal usually outlives the call (one controller per
 * page, per view, per request), so a listener per call would accumulate on it
 * for as long as the signal lives.
 */
/** What AbortSignal.timeout() aborts with: a DOMException, which is not an Error everywhere, so it is read by its name. */
const isTimeoutReason = (reason) => typeof reason === "object" && reason !== null && reason.name === "TimeoutError";
export const createCallAbort = (options) => {
    const { timeoutMs, signal: external } = options;
    let timedOut = false;
    let signal = external;
    let timeoutId;
    let detachExternal;
    if (timeoutMs !== undefined) {
        // The timeout gets its own controller chained to the site's signal, so
        // either source aborts the call and only this one knows which did.
        const controller = new AbortController();
        if (external) {
            if (external.aborted) {
                controller.abort(external.reason);
            }
            else {
                const forwardAbort = () => controller.abort(external.reason);
                external.addEventListener("abort", forwardAbort, { once: true });
                detachExternal = () => external.removeEventListener("abort", forwardAbort);
            }
        }
        timeoutId = setTimeout(() => {
            // The first abort names the call: a timer that fires after the
            // site's signal already aborted it finds the call given up on by
            // the site, and must not report it as a timeout.
            if (!controller.signal.aborted)
                timedOut = true;
            controller.abort();
        }, timeoutMs);
        signal = controller.signal;
    }
    // The chained controller aborts with the site signal's own reason, so a
    // deadline the site set is still readable here.
    const abortReason = () => !signal?.aborted ? null : timedOut || isTimeoutReason(signal.reason) ? "timeout" : "aborted";
    return {
        signal,
        abortReason,
        abortFailure: (stage) => {
            const reason = abortReason();
            if (!reason)
                return null;
            const detail = stage === "beforeSending"
                ? "the call was given up on before it was sent"
                : "the answer arrived too late to be used";
            if (reason === "aborted")
                return { reason, error: new Error(`Request aborted by its signal; ${detail}.`) };
            return { reason, error: new Error(timedOut ? `Request timed out after ${timeoutMs}ms; ${detail}.` : `Request timed out by its signal; ${detail}.`) };
        },
        detach: () => {
            if (timeoutId !== undefined)
                clearTimeout(timeoutId);
            detachExternal?.();
        },
    };
};
/**
 * Ends the wait on work that cannot be cancelled, which is what honouring
 * `request.signal` means for a transport running a handler in this process:
 * the callee runs to completion either way, and what the caller's timeout
 * buys is its own answer. Used by lambderHandlerTransport and by
 * LambderInvokeCaller.localTransport, whose in-process calls are the two
 * transports a signal has nothing to cancel, and by the crash reporter's
 * time bound (LambderCrashHandling), where the app's report runs on.
 *
 * A signal that aborted before the wait began rejects it at once with the
 * signal's reason, since it fires no event for a listener added afterwards.
 * `pending` is still attached to either way, so what it later rejects with is
 * settled here rather than left an unhandled rejection. The listener is
 * detached on either outcome, for the reason createCallAbort detaches its own.
 */
export const stopWaitingWhenAborted = (pending, signal) => {
    if (!signal)
        return pending;
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener("abort", onAbort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
};

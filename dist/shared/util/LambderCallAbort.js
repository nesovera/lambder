/**
 * One call's abort wiring, shared by LambderCaller (a browser over fetch) and
 * LambderInvokeCaller (a server over a Lambda invoke).
 *
 * Both give a call a `timeoutMs`, both let the site pass its own AbortSignal,
 * and both have to answer the same three questions: which signal does the
 * transport get, has the call already been given up on before it is sent, and
 * did the answer arrive after it was given up on. Written twice, the two
 * drifted: the browser caller learned not to believe a late answer and the
 * invoke caller did not, so a 20ms timeoutMs there reported `ok: true` at
 * 300ms and the call site acted on data it had already abandoned.
 *
 * The listener on an external signal is removed in detach() rather than left
 * to `once`: a site's signal usually outlives the call (one controller per
 * page, per view, per request), so a listener per call would accumulate on it
 * for as long as the signal lives.
 */
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
        timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        signal = controller.signal;
    }
    return {
        signal,
        timedOut: () => timedOut,
        abortFailure: (stage) => {
            if (!signal?.aborted)
                return null;
            const detail = stage === "beforeSending"
                ? "the call was given up on before it was sent"
                : "the answer arrived too late to be used";
            return timedOut
                ? { reason: "timeout", error: new Error(`Request timed out after ${timeoutMs}ms; ${detail}.`) }
                : { reason: "network", error: new Error(`Request aborted; ${detail}.`) };
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
 * places a signal has nothing to cancel.
 *
 * The listener is detached on either outcome, for the reason createCallAbort
 * detaches its own.
 */
export const stopWaitingWhenAborted = (pending, signal) => {
    if (!signal)
        return pending;
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
};

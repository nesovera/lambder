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

/** How an abandoned call is reported: its own timeout fired, or the site's signal did, which is a `network` failure like any other abort. */
type LambderCallAbortReason = "timeout" | "network";

/** The reason and the error to report for a call that was given up on. */
type LambderCallAbortFailure = { reason: LambderCallAbortReason; error: Error };

/**
 * Where the abort was noticed, which is all that differs between the two
 * checks: nothing was sent, or something came back too late to be used.
 */
export type LambderCallAbortStage = "beforeSending" | "afterAnswering";

type LambderCallAbort = {
    /** What the transport is handed: the chained signal when a timeout is set, the site's own otherwise, and nothing when there is neither. */
    signal: AbortSignal | undefined;
    /** Whether this call's own timeout is what aborted it, rather than the site's signal. */
    timedOut: () => boolean;
    /**
     * The failure to report, or null while the call still stands. Run before
     * handing the request to the transport (a call already abandoned should
     * not reach it) and again after the transport resolves, because honouring
     * `request.signal` is the transport's obligation and not every transport
     * does: an answer that arrives after the abort is not a success.
     */
    abortFailure: (stage: LambderCallAbortStage) => LambderCallAbortFailure | null;
    /** Clears the timer and lets go of the external signal. Belongs in a finally. */
    detach: () => void;
};

export const createCallAbort = (options: { timeoutMs?: number; signal?: AbortSignal }): LambderCallAbort => {
    const { timeoutMs, signal: external } = options;
    let timedOut = false;
    let signal: AbortSignal | undefined = external;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let detachExternal: (() => void) | undefined;
    if(timeoutMs !== undefined){
        // The timeout gets its own controller chained to the site's signal, so
        // either source aborts the call and only this one knows which did.
        const controller = new AbortController();
        if(external){
            if(external.aborted){ controller.abort(external.reason); }
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
            if(!signal?.aborted) return null;
            const detail = stage === "beforeSending"
                ? "the call was given up on before it was sent"
                : "the answer arrived too late to be used";
            return timedOut
                ? { reason: "timeout", error: new Error(`Request timed out after ${timeoutMs}ms; ${detail}.`) }
                : { reason: "network", error: new Error(`Request aborted; ${detail}.`) };
        },
        detach: () => {
            if(timeoutId !== undefined) clearTimeout(timeoutId);
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
export const stopWaitingWhenAborted = <T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
    if(!signal) return pending;
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
};

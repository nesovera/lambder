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
/** Who gave up on a call: a deadline ended it (`timeout`: its own timeoutMs, or a site signal that aborted with a TimeoutError), or the site's own signal did (`aborted`). */
export type LambderCallAbortReason = "timeout" | "aborted";
/** The reason and the error to report for a call that was given up on. */
type LambderCallAbortFailure = {
    reason: LambderCallAbortReason;
    error: Error;
};
/**
 * Where the abort was noticed, which is all that differs between the two
 * checks: nothing was sent, or something came back too late to be used.
 */
export type LambderCallAbortStage = "beforeSending" | "afterAnswering";
type LambderCallAbort = {
    /** What the transport is handed: the chained signal when a timeout is set, the site's own otherwise, and nothing when there is neither. */
    signal: AbortSignal | undefined;
    /**
     * Who aborted the call, or null while nothing has. A transport that
     * rejects once the call is aborted is read by this first, whatever it
     * rejected with: only the caller knows which of the two aborted it.
     */
    abortReason: () => LambderCallAbortReason | null;
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
export declare const createCallAbort: (options: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => LambderCallAbort;
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
export declare const stopWaitingWhenAborted: <T>(pending: Promise<T>, signal: AbortSignal | undefined) => Promise<T>;
export {};

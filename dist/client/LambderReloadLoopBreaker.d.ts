/**
 * Stops a stale client from reloading forever.
 *
 * A versionExpired answer means this client's signature for the endpoint is
 * not the one the server holds (or its version is below the server's floor),
 * and the ordinary response is to reload for the current bundle. When the
 * served bundle is itself stale (a frontend deployed with a signature map the
 * server does not match, a cached bundle, a server deploy that failed behind
 * a fresh frontend), the reload brings back the same bundle, the calls fail
 * the same way, and the page reloads again, indefinitely.
 *
 * The evidence is a versionExpired for a call an earlier load refused within
 * the window: the same endpoint with the same signature and version. A bundle
 * that had changed the endpoint would carry a different signature, and a
 * rebuilt one a different version. Each call is kept with the time it was
 * refused, and only one refused before this document loaded counts: a call
 * this page refused itself (a retry, another caller's) has seen no reload
 * since. Every call refused within the window is kept, not only the latest,
 * because a stale bundle is usually stale for several endpoints and they
 * answer in no fixed order: whichever of them answers first on the next load
 * has to find itself in the record.
 *
 * A page asks one versionExpiredHandler at a time. While it runs, the rest of
 * what the page hears (the other stale endpoints it boots with, a retry,
 * another caller's) is recorded and answered quietly, since the page is being
 * asked already. A handler that has returned while the page is still here may
 * not have reloaded it (a per-call handler that does something else, a reload
 * cancelled at a beforeunload prompt), so the next versionExpired asks again;
 * where it did, asking again before the page unloads only repeats the reload
 * under way. An instance is one page: LambderCaller keeps one at module
 * scope, shared by every caller the page builds (in a runtime with no page,
 * every caller of the process).
 *
 * Once a repeat is confirmed, every versionExpired within the window counts
 * as one, whichever endpoint it names, so an endpoint the stale bundle calls
 * only later does not earn a reload of its own. The window runs from the
 * first versionExpired recorded, not from the latest. After it a reload is
 * allowed again, so a client stuck on a stale bundle retries a few times an
 * hour and recovers once the deploy is fixed.
 *
 * The record has to outlive the reload it watches for, so it lives in
 * sessionStorage, per tab and per origin. Where that does not work (storage
 * blocked, a runtime with no page) nothing outlives the page: it still asks
 * one handler at a time, and a stale bundle there reloads as it would without
 * this class.
 */
/** How long after the first versionExpired a repeat counts as the same loop. */
export declare const RELOAD_LOOP_WINDOW_MS: number;
/**
 * What the caller does about a versionExpired: ask for a reload (the
 * versionExpiredHandler, through runReloadAsk), nothing because the page's
 * ask is still running, or report a confirmed loop instead of asking again.
 */
type ReloadLoopDecision = "askForReload" | "alreadyAsked" | "loopConfirmed";
export declare class LambderReloadLoopBreaker {
    private readonly loadedAt;
    /** Whether the handler this page asked is still running: what the page hears meanwhile stays quiet. */
    private reloadAskPending;
    /** loadedAt: when this document loaded. A call refused before it was refused by an earlier load, with a reload in between. */
    constructor(loadedAt?: number);
    /** Records this versionExpired and decides what the caller does about it. */
    recordVersionExpired(apiName: string, signature: string, version: string, now?: number): ReloadLoopDecision;
    /** Runs the ask an askForReload decision calls for; until it settles, every versionExpired is alreadyAsked. */
    runReloadAsk(ask: () => unknown): Promise<void>;
    private read;
    private write;
}
export {};

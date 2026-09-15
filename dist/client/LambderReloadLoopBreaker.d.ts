/**
 * Stops a stale client from reloading forever.
 *
 * A versionExpired answer means "this client's signature for the endpoint is
 * not the one the server holds", and the ordinary response is to reload and
 * get the current bundle. When the bundle being served is itself the stale
 * one (a frontend deployed with a signature map the server does not match, a
 * cached bundle, a server deploy that failed behind a fresh frontend), the
 * reload brings back the same signature, the same call fails the same way,
 * and the page reloads again, indefinitely.
 *
 * The evidence of that loop is a versionExpired for the same endpoint with
 * the same signature shortly after the last one: a bundle that had actually
 * changed the endpoint would carry a different signature. The record lives
 * in sessionStorage, which is per tab and survives a reload, so the new page
 * instance sees what the previous one saw; without sessionStorage (a test, a
 * non-browser runtime) an in-memory record does the same within one page.
 *
 * Once a repeat is confirmed, every versionExpired within the window from
 * the first one counts as a repeat too, whichever endpoint it names: a stale
 * bundle is usually stale for several endpoints, and one reload per endpoint
 * is still a loop, only a slower one. After the window a reload is allowed
 * again, so a client stuck on a stale bundle retries a few times an hour and
 * recovers by itself once the deploy is fixed.
 */
/** How long after the first versionExpired a repeat counts as the same loop. */
export declare const RELOAD_LOOP_WINDOW_MS: number;
export declare class LambderReloadLoopBreaker {
    /** The record when sessionStorage is unavailable; sessionStorage is read first wherever it exists. */
    private memory;
    /**
     * Records this versionExpired and says whether it repeats a recent one,
     * in which case the caller must not invoke versionExpiredHandler again.
     */
    isRepeat(apiName: string, signature: string, now?: number): boolean;
    private read;
    private write;
}

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
export const RELOAD_LOOP_WINDOW_MS = 5 * 60 * 1000;
const STORAGE_KEY = "lambder:version-expired";

/** One refused call: the endpoint, the signature and version it was sent with, and when it was refused. */
type RefusedCall = [apiName: string, signature: string, version: string, refusedAt: number];
type VersionExpiredRecord = { at: number; confirmed: boolean; calls: RefusedCall[] };

/**
 * What the caller does about a versionExpired: ask for a reload (the
 * versionExpiredHandler, through runReloadAsk), nothing because the page's
 * ask is still running, or report a confirmed loop instead of asking again.
 */
type ReloadLoopDecision = "askForReload" | "alreadyAsked" | "loopConfirmed";

const isRefusedCall = (value: unknown): value is RefusedCall =>
    Array.isArray(value) && value.length === 4
    && typeof value[0] === "string" && typeof value[1] === "string" && typeof value[2] === "string"
    && typeof value[3] === "number";

const isVersionExpiredRecord = (value: unknown): value is VersionExpiredRecord =>
    typeof value === "object" && value !== null
    && typeof (value as VersionExpiredRecord).at === "number"
    && typeof (value as VersionExpiredRecord).confirmed === "boolean"
    && Array.isArray((value as VersionExpiredRecord).calls)
    && (value as VersionExpiredRecord).calls.every(isRefusedCall);

/** A record from the future (a clock set back) is outside the window rather than inside it forever. */
const isWithinWindow = (at: number, now: number) => now >= at && now - at < RELOAD_LOOP_WINDOW_MS;

export class LambderReloadLoopBreaker {
    /** Whether the handler this page asked is still running: what the page hears meanwhile stays quiet. */
    private reloadAskPending = false;

    /** loadedAt: when this document loaded. A call refused before it was refused by an earlier load, with a reload in between. */
    constructor(private readonly loadedAt = performance.timeOrigin){}

    /** Records this versionExpired and decides what the caller does about it. */
    recordVersionExpired(apiName: string, signature: string, version: string, now = Date.now()): ReloadLoopDecision {
        const stored = this.read();
        const record: VersionExpiredRecord = stored && isWithinWindow(stored.at, now) ? stored : { at: now, confirmed: false, calls: [] };
        const earlier = record.calls.find(([name, sig, ver]) => name === apiName && sig === signature && ver === version);
        if(!earlier) record.calls.push([apiName, signature, version, now]);

        let decision: ReloadLoopDecision;
        if(this.reloadAskPending) decision = "alreadyAsked";
        else if(record.confirmed || (earlier !== undefined && earlier[3] < this.loadedAt)) decision = "loopConfirmed";
        else decision = "askForReload";

        if(decision === "loopConfirmed") record.confirmed = true;
        this.write(record);
        return decision;
    }

    /** Runs the ask an askForReload decision calls for; until it settles, every versionExpired is alreadyAsked. */
    async runReloadAsk(ask: () => unknown): Promise<void> {
        this.reloadAskPending = true;
        try { await ask(); }
        finally { this.reloadAskPending = false; }
    }

    private read(): VersionExpiredRecord | null {
        try {
            const stored = globalThis.sessionStorage?.getItem(STORAGE_KEY);
            if(stored){
                const parsed: unknown = JSON.parse(stored);
                if(isVersionExpiredRecord(parsed)) return parsed;
            }
        } catch { /* blocked storage, or a record that is not JSON: read as no record */ }
        return null;
    }

    private write(record: VersionExpiredRecord): void {
        try { globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(record)); }
        catch { /* blocked or full: nothing outlives this page */ }
    }
}

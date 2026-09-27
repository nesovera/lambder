import { assertNumberAtLeast } from "./LambderOptionChecks.js";

/**
 * One pending wait at a time, where each retry after a failure waits longer
 * than the one before it.
 *
 * Most things that retry also wait for other reasons (a refresh cadence, a
 * pause before recreating something), and those waits must never stack with a
 * retry. So the timer holds exactly one wait of either kind: `retry` and
 * `wait` climb the ladder, `after` waits a fixed time without climbing it, and
 * scheduling any of them replaces whatever was waiting. A caller says what to
 * run and when it worked, and never keeps a handle and a counter of its own.
 *
 * The ladder: a retry waits the base plus a share of a ceiling that grows by
 * `factor` with every failed attempt, the whole never past `maxMs`. With full
 * jitter (the default) the share is random, so anything many clients fail at
 * together (a deploy dropping every socket, a power cut bringing every screen
 * in a building up at once) is retried across the whole window instead of in
 * step, which is what keeps the herd off the server.
 *
 * Runs wherever setTimeout does: a browser, a Worker, Node. The upload runner
 * waits on one between tries at storage, and an app's reconnecting client or
 * self-healing screen holds one of its own.
 */

export type LambderBackoffTimerOptions = {
    /**
     * The shortest retry wait, in milliseconds. The first after a reset falls
     * between it and twice it (exactly twice with `jitter: "none"`), so even
     * the first retries of many clients spread out. Default: 1000.
     */
    baseMs?: number;
    /**
     * The longest any retry wait is, in milliseconds, however many attempts
     * have failed; at least `baseMs`. Default: 60000, or `baseMs` when that is
     * longer.
     */
    maxMs?: number;
    /** How much the ceiling grows with each failed attempt. Default: 2. */
    factor?: number;
    /**
     * "full" (the default): the base plus a random share of the ceiling, which
     * spreads a herd out. "none": the base plus the whole ceiling, a
     * predictable ladder for a caller that is alone.
     */
    jitter?: "full" | "none";
};

export class LambderBackoffTimer {
    private readonly baseMs: number;
    private readonly maxMs: number;
    private readonly factor: number;
    private readonly jitter: "full" | "none";
    private attempts = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** Settles the promise of a `wait` that cancel() or a replacement drops, so no `await` is left hanging. */
    private dropPending: (() => void) | null = null;

    constructor(options: LambderBackoffTimerOptions = {}){
        this.baseMs = assertNumberAtLeast(options.baseMs ?? 1_000, 0, "baseMs");
        this.maxMs = assertNumberAtLeast(options.maxMs ?? Math.max(60_000, this.baseMs), this.baseMs, "maxMs");
        this.factor = assertNumberAtLeast(options.factor ?? 2, 1, "factor");
        this.jitter = options.jitter ?? "full";
    }

    /** True while a wait of any kind is pending. False again by the time it runs. */
    get pending(): boolean {
        return this.timer !== null;
    }

    /**
     * Runs `run` after the next rung of the ladder, counting one more failed
     * attempt. Replaces whatever was waiting.
     */
    retry(run: () => void): void {
        this.schedule(this.nextRung(), run, null);
    }

    /**
     * Resolves after the next rung of the ladder, counting one more failed
     * attempt: the `retry` for code that awaits rather than calls back.
     * Replaces whatever was waiting. Rejects at once with the signal's reason
     * when `signal` aborts, and with an Error when cancel() or a later wait
     * drops it before it ran, so an await on it always settles.
     */
    wait(signal?: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if(signal?.aborted) return reject(abortReasonOf(signal));
            const onAbort = () => this.cancel();
            const settle = (outcome: () => void) => {
                signal?.removeEventListener("abort", onAbort);
                outcome();
            };
            this.schedule(
                this.nextRung(),
                () => settle(resolve),
                () => settle(() => reject(signal?.aborted ? abortReasonOf(signal) : new Error("LambderBackoffTimer: the wait was dropped by cancel() or by a later wait before it ran."))),
            );
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    /**
     * Runs `run` after a fixed wait, off the ladder: nothing failed, so nothing
     * climbs. Replaces whatever was waiting.
     */
    after(delayMs: number, run: () => void): void {
        this.schedule(delayMs, run, null);
    }

    /** The attempt worked: the next failure waits the shortest time again. A pending wait is left alone. */
    reset(): void {
        this.attempts = 0;
    }

    /** Drops the pending wait (the caller is trying right now, or going away), keeping the count. */
    cancel(): void {
        if(this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
        const drop = this.dropPending;
        this.dropPending = null;
        drop?.();
    }

    /** The next wait on the ladder, in milliseconds, counting one more failed attempt. */
    private nextRung(): number {
        const ceiling = Math.min(this.baseMs * this.factor ** this.attempts, this.maxMs - this.baseMs);
        this.attempts += 1;
        return this.baseMs + (this.jitter === "full" ? Math.random() : 1) * ceiling;
    }

    private schedule(delayMs: number, run: () => void, drop: (() => void) | null): void {
        this.cancel();
        this.dropPending = drop;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.dropPending = null;
            run();
        }, delayMs);
    }
}

/** What an aborted signal carries, or an Error for a runtime whose signals carry nothing. */
const abortReasonOf = (signal: AbortSignal): unknown =>
    (signal as { reason?: unknown }).reason ?? new Error("LambderBackoffTimer: the wait was aborted.");

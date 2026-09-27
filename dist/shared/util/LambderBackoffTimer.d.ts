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
export declare class LambderBackoffTimer {
    private readonly baseMs;
    private readonly maxMs;
    private readonly factor;
    private readonly jitter;
    private attempts;
    private timer;
    /** Settles the promise of a `wait` that cancel() or a replacement drops, so no `await` is left hanging. */
    private dropPending;
    constructor(options?: LambderBackoffTimerOptions);
    /** True while a wait of any kind is pending. False again by the time it runs. */
    get pending(): boolean;
    /**
     * Runs `run` after the next rung of the ladder, counting one more failed
     * attempt. Replaces whatever was waiting.
     */
    retry(run: () => void): void;
    /**
     * Resolves after the next rung of the ladder, counting one more failed
     * attempt: the `retry` for code that awaits rather than calls back.
     * Replaces whatever was waiting. Rejects at once with the signal's reason
     * when `signal` aborts, and with an Error when cancel() or a later wait
     * drops it before it ran, so an await on it always settles.
     */
    wait(signal?: AbortSignal): Promise<void>;
    /**
     * Runs `run` after a fixed wait, off the ladder: nothing failed, so nothing
     * climbs. Replaces whatever was waiting.
     */
    after(delayMs: number, run: () => void): void;
    /** The attempt worked: the next failure waits the shortest time again. A pending wait is left alone. */
    reset(): void;
    /** Drops the pending wait (the caller is trying right now, or going away), keeping the count. */
    cancel(): void;
    /** The next wait on the ladder, in milliseconds, counting one more failed attempt. */
    private nextRung;
    private schedule;
}

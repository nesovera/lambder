import { assertNumberAtLeast } from "./LambderOptionChecks.js";
/**
 * The longest delay setTimeout keeps: a longer one overflows its 32-bit
 * millisecond count and fires at once, in browsers and in Node alike, so a
 * ladder that reached past it would retry with no pause at all.
 */
const LONGEST_TIMER_DELAY_MS = 2_147_483_647;
export class LambderBackoffTimer {
    baseMs;
    maxMs;
    factor;
    jitter;
    retriesSinceReset = 0;
    timer = null;
    /** Settles the promise of a `wait` that cancel() or a replacement drops, so no `await` is left hanging. */
    dropPending = null;
    constructor(options = {}) {
        const baseMs = options.baseMs ?? 1_000;
        // Every rung is a multiple of the base, so a base of 0 is a retry
        // loop with no pause.
        if (typeof baseMs !== "number" || !(baseMs > 0) || baseMs > LONGEST_TIMER_DELAY_MS) {
            throw new Error(`Lambder: LambderBackoffTimer baseMs must be a number above 0 and at most ${LONGEST_TIMER_DELAY_MS}, got ${String(baseMs)}: every wait is a multiple of it, so 0 retries with no pause, and setTimeout fires a longer delay at once.`);
        }
        this.baseMs = baseMs;
        this.maxMs = assertNumberAtLeast(options.maxMs ?? Math.max(60_000, this.baseMs), this.baseMs, "maxMs");
        if (this.maxMs > LONGEST_TIMER_DELAY_MS) {
            throw new Error(`Lambder: LambderBackoffTimer maxMs must be at most ${LONGEST_TIMER_DELAY_MS}, got ${this.maxMs}: setTimeout fires a longer delay at once, so the top of the ladder would retry with no pause.`);
        }
        this.factor = assertNumberAtLeast(options.factor ?? 2, 1, "factor");
        const jitter = options.jitter ?? "full";
        if (jitter !== "full" && jitter !== "none") {
            throw new Error(`Lambder: LambderBackoffTimer jitter must be "full" or "none", got ${JSON.stringify(jitter)}.`);
        }
        this.jitter = jitter;
    }
    /** True while a wait of any kind is pending. False again by the time it runs. */
    get pending() {
        return this.timer !== null;
    }
    /**
     * How many retries `retry` and `wait` have scheduled since the last reset
     * (or since the timer was built), a dropped one included: the rung the
     * next one climbs from. A loop that gives up after so many retries reads
     * it here rather than keeping a counter of its own.
     */
    get retries() {
        return this.retriesSinceReset;
    }
    /**
     * Runs `run` after the next rung of the ladder, counting one more retry.
     * Replaces whatever was waiting.
     */
    retry(run) {
        this.schedule(this.nextRung(), run, null);
    }
    /**
     * Resolves after the next rung of the ladder, counting one more retry:
     * the `retry` for code that awaits rather than calls back.
     * Replaces whatever was waiting. Rejects at once with the signal's reason
     * when `signal` aborts, and with an Error when cancel() or a later wait
     * drops it before it ran, so an await on it always settles.
     */
    wait(signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted)
                return reject(abortReasonOf(signal));
            const onAbort = () => this.cancel();
            const settle = (outcome) => {
                signal?.removeEventListener("abort", onAbort);
                outcome();
            };
            this.schedule(this.nextRung(), () => settle(resolve), () => settle(() => reject(signal?.aborted ? abortReasonOf(signal) : new Error("LambderBackoffTimer: the wait was dropped by cancel() or by a later wait before it ran."))));
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }
    /**
     * Runs `run` after a fixed wait, off the ladder: nothing failed, so nothing
     * climbs. Replaces whatever was waiting.
     */
    after(delayMs, run) {
        this.schedule(delayMs, run, null);
    }
    /** The attempt worked: the next failure waits the shortest time again, and `retries` is 0. A pending wait is left alone. */
    reset() {
        this.retriesSinceReset = 0;
    }
    /** Drops the pending wait (the caller is trying right now, or going away), keeping the count. */
    cancel() {
        if (this.timer === null)
            return;
        clearTimeout(this.timer);
        this.timer = null;
        const drop = this.dropPending;
        this.dropPending = null;
        drop?.();
    }
    /** The next wait on the ladder, in milliseconds, counting one more retry. */
    nextRung() {
        const ceiling = Math.min(this.baseMs * this.factor ** this.retriesSinceReset, this.maxMs - this.baseMs);
        this.retriesSinceReset += 1;
        return this.baseMs + (this.jitter === "full" ? Math.random() : 1) * ceiling;
    }
    schedule(delayMs, run, drop) {
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
const abortReasonOf = (signal) => signal.reason ?? new Error("LambderBackoffTimer: the wait was aborted.");

import { type LambderRateLimiter, type LambderRateLimitPolicy, type LambderRateLimitResult, type LambderRateLimitWindow } from "../shared/contracts/LambderRateLimiter.js";
/**
 * Fixed-window rate limiter held in memory: the same windows, the same
 * attempts-count semantics and the same evaluation order as
 * LambderDdbRateLimiter, with a Map in place of the table. For tests and
 * for the mock runtime; a single-process server could use it too, with the
 * caveat that its counters are per process and vanish with it.
 *
 * `now` is injectable so a test can move time forward and watch a window
 * reset without waiting for it.
 *
 * `maxEntries` (100,000 counters by default) is the one way this limiter
 * differs from the table: past the ceiling, the counters closest to their
 * window's end are dropped, and a key whose counter was dropped starts that
 * window again from zero. Reaching it takes one distinct key per counter (a
 * per-IP limit under a flood from many IPs), and the long-window counters,
 * with the most life left, go last. Where that matters, use
 * LambderDdbRateLimiter, whose counters live outside the process.
 */
export declare class LambderMemoryRateLimiter implements LambderRateLimiter {
    private readonly counters;
    private readonly now;
    constructor(options?: {
        now?: () => number;
        maxEntries?: number;
    });
    clockMilliseconds(): number;
    isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult>;
    /** The attempts counted so far for a key in the current window of `window`; for assertions. */
    countOf(trackerKey: string, window: LambderRateLimitWindow): number;
    /** Forgets every counter. */
    reset(): void;
}

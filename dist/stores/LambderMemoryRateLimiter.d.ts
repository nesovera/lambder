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
 * `maxEntries` is the ceiling on counters held at once, 100,000 by default,
 * and it is the one way this limiter differs from the table: a process cannot
 * hold counters without bound, so past the ceiling the counters closest to
 * their window's end are dropped and a key whose counter was dropped starts
 * that window again from zero. It takes one distinct key per counter to get
 * there (a limit keyed per IP under a flood from many of them), and the
 * counters with the most life left, which are the long-window ones, are the
 * last to go. A deployment where that matters wants LambderDdbRateLimiter,
 * whose counters are not held in the process at all.
 */
export declare class LambderMemoryRateLimiter implements LambderRateLimiter {
    private readonly counters;
    private readonly now;
    constructor(options?: {
        now?: () => number;
        maxEntries?: number;
    });
    isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult>;
    /** The attempts counted so far for a key in the current window of `window`; for assertions. */
    countOf(trackerKey: string, window: LambderRateLimitWindow): number;
    /** Forgets every counter. */
    reset(): void;
}

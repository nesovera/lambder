import {
    RATE_LIMIT_WINDOWS,
    type LambderRateLimiter,
    type LambderRateLimitPolicy,
    type LambderRateLimitResult,
    type LambderRateLimitWindow,
} from "../shared/contracts/LambderRateLimiter.js";
import { LambderExpiringMap } from "../shared/util/LambderExpiringMap.js";
import { joinKeyFields } from "../shared/util/LambderKeyFields.js";

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
export class LambderMemoryRateLimiter implements LambderRateLimiter {
    private readonly counters: LambderExpiringMap<{ count: number }>;
    private readonly now: () => number;

    constructor(options: { now?: () => number; maxEntries?: number } = {}){
        this.now = options.now ?? (() => Date.now());
        this.counters = new LambderExpiringMap<{ count: number }>({ now: this.now, maxEntries: options.maxEntries });
    }

    async isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult> {
        const nowSeconds = Math.floor(this.now() / 1000);
        for(const { key, seconds } of RATE_LIMIT_WINDOWS){
            const limit = policy[key];
            if(!limit) continue;
            const windowStart = Math.floor(nowSeconds / seconds) * seconds;
            // The table gives the tracker key and the window separate
            // attributes; one string here has to keep them as distinct, so the
            // fields are joined through the escaping join rather than glued.
            const counterKey = joinKeyFields(trackerKey, key, String(windowStart));
            const counter = this.counters.get(counterKey) ?? { count: 0 };
            // The DynamoDB limiter's conditional ADD: allowed while the count
            // before this attempt is under the limit, and the refused attempt
            // leaves the counter where it was.
            if(counter.count >= limit) return { window: key, limit, resetAt: windowStart + seconds };
            counter.count += 1;
            // The counter dies with its window, which is also the table's TTL.
            this.counters.set(counterKey, counter, windowStart + seconds);
        }
        return false;
    }

    /** The attempts counted so far for a key in the current window of `window`; for assertions. */
    countOf(trackerKey: string, window: LambderRateLimitWindow): number {
        const seconds = RATE_LIMIT_WINDOWS.find((entry) => entry.key === window)!.seconds;
        const windowStart = Math.floor(Math.floor(this.now() / 1000) / seconds) * seconds;
        return this.counters.get(joinKeyFields(trackerKey, window, String(windowStart)))?.count ?? 0;
    }

    /** Forgets every counter. */
    reset(): void {
        this.counters.clear();
    }
}

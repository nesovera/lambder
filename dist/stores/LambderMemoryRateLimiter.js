import { RATE_LIMIT_WINDOWS, } from "../shared/contracts/LambderRateLimiter.js";
import { LambderExpiringMap } from "../shared/util/LambderExpiringMap.js";
import { joinKeyFields } from "../shared/util/joinKeyFields.js";
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
export class LambderMemoryRateLimiter {
    counters;
    now;
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.counters = new LambderExpiringMap({ now: this.now, maxEntries: options.maxEntries });
    }
    clockMilliseconds() {
        return this.now();
    }
    async isRateLimited(trackerKey, policy) {
        const nowSeconds = Math.floor(this.now() / 1000);
        for (const { key, seconds } of RATE_LIMIT_WINDOWS) {
            const limit = policy[key];
            if (!limit)
                continue;
            const windowStart = Math.floor(nowSeconds / seconds) * seconds;
            // The table keeps the tracker key and the window in separate
            // attributes; one string has to keep them as distinct, hence the
            // escaping join.
            const counterKey = joinKeyFields(trackerKey, key, String(windowStart));
            const counter = this.counters.get(counterKey) ?? { count: 0 };
            // The DynamoDB limiter's conditional ADD: allowed while the count
            // before this attempt is under the limit, and the refused attempt
            // leaves the counter where it was.
            if (counter.count >= limit)
                return { window: key, limit, resetAt: windowStart + seconds };
            counter.count += 1;
            // The counter dies with its window, which is also the table's TTL.
            this.counters.set(counterKey, counter, windowStart + seconds);
        }
        return false;
    }
    /** The attempts counted so far for a key in the current window of `window`; for assertions. */
    countOf(trackerKey, window) {
        const seconds = RATE_LIMIT_WINDOWS.find((entry) => entry.key === window).seconds;
        const windowStart = Math.floor(Math.floor(this.now() / 1000) / seconds) * seconds;
        return this.counters.get(joinKeyFields(trackerKey, window, String(windowStart)))?.count ?? 0;
    }
    /** Forgets every counter. */
    reset() {
        this.counters.clear();
    }
}

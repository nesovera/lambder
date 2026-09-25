/**
 * The rate-limit vocabulary every part of Lambder shares: the fixed windows a
 * policy may cap, the policy shape, what an exceeded check reports, and the
 * one method the rate-limit engine asks of a limiter.
 *
 * Kept apart from the DynamoDB limiter on purpose: importing it from the
 * store would pull the DynamoDB SDK loader into the engine's import graph and
 * keep the policy layer from running anywhere but inside a Lambda. Pure and
 * dependency-free, so the mock runtime and the browser entry can resolve it.
 */

/**
 * The fixed windows a policy may cap, smallest first (the evaluation order),
 * with their length. The policy type derives from this table, so the two can
 * never drift.
 */
export const RATE_LIMIT_WINDOWS = [
    { key: "perMin", seconds: 60 },
    { key: "per10Min", seconds: 10 * 60 },
    { key: "perHour", seconds: 60 * 60 },
    { key: "perDay", seconds: 24 * 60 * 60 },
    { key: "perWeek", seconds: 7 * 24 * 60 * 60 },
    { key: "perMonth", seconds: 30 * 24 * 60 * 60 },
] as const satisfies readonly { key: string; seconds: number }[];

export type LambderRateLimitWindow = (typeof RATE_LIMIT_WINDOWS)[number]["key"];

/** Per-window caps. A window that is absent or 0 is not enforced. */
export type LambderRateLimitPolicy = Partial<Record<LambderRateLimitWindow, number>>;

/**
 * The window that refused: which one, its limit, and the epoch second at
 * which that fixed window resets (Retry-After derives from it).
 */
export type LambderRateLimitExceeded = {
    window: LambderRateLimitWindow;
    limit: number;
    resetAt: number;
};

/** `false` when allowed, otherwise the window whose limit was hit. */
export type LambderRateLimitResult = false | LambderRateLimitExceeded;

/**
 * What the rate-limit engine asks of a limiter: count one attempt against
 * every window the policy caps and say whether any of them is over. The
 * DynamoDB limiter and the in-memory one implement it; an app may bring its
 * own (Redis, a database) by implementing this one method.
 *
 * The engine validates a policy before it reaches here, so every capped
 * window arrives as a non-negative whole number. A caller reaching
 * isRateLimited directly owes the same precondition: the two shipped
 * implementations disagree on a negative cap (one refuses the first attempt,
 * the other allows it), since neither is meant to be asked.
 *
 * The tracker key is bounded there too: the variable half of it (a custom
 * key handler's return, a session key) is replaced by its own sha256 once it
 * passes 1024 UTF-8 bytes as written into the key, so an implementation with
 * a key limit of its own never meets a key it has to refuse. That matters
 * because a limiter's refusal is a throw, and a throw is what failOpen
 * swallows into no limit at all.
 *
 * A limiter that answers a run of requests with one continuing failure (the
 * DynamoDB limiter, for a flooded partition it cannot size) may throw the
 * same error object for each of them: the engine logs a failure once, not
 * once per request that meets it.
 */
export interface LambderRateLimiter {
    isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult>;
    /**
     * The clock the windows are computed against, in epoch milliseconds, for
     * a limiter that keeps one of its own (an injected test clock). A
     * refusal's `resetAt` is a second on this clock, so the engine reads the
     * Retry-After against it. Optional: without it, the engine reads
     * Date.now().
     */
    clockMilliseconds?(): number;
}

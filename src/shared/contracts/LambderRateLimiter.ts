/**
 * The rate-limit vocabulary every part of Lambder shares: the fixed windows a
 * policy may cap, the policy shape, what an exceeded check reports, and the
 * one method the rate-limit engine asks of a limiter.
 *
 * Kept apart from the DynamoDB limiter on purpose. The engine needs only this
 * table, and importing it from the store would pull the DynamoDB SDK loader
 * into the engine's import graph, which is what kept the policy layer from
 * running anywhere but inside a Lambda. Pure and dependency-free, so the
 * mock runtime and the browser entry can resolve it.
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
 * The engine validates a policy before it ever reaches here, so every capped
 * window arrives as a non-negative whole number and a limiter never has to
 * invent an answer for a nonsense one. A caller reaching isRateLimited
 * directly owes the same precondition: the two shipped implementations
 * disagree on a negative cap (one refuses the first attempt, the other allows
 * it) because neither was ever meant to be asked.
 *
 * The tracker key is bounded there too: the variable half of it (a custom
 * key handler's return, a session key) is replaced by its own sha256 past
 * 1024 UTF-8 bytes, so an implementation with a key limit of its own never
 * meets a key it has to refuse. That matters because a limiter's refusal is a
 * throw, and a throw is what failOpen swallows into no limit at all.
 */
export interface LambderRateLimiter {
    isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult>;
}

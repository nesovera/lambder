import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
/**
 * The fixed windows a policy may cap, smallest first (the evaluation order),
 * with their length. The policy type derives from this table, so the two can
 * never drift.
 */
export declare const RATE_LIMIT_WINDOWS: readonly [{
    readonly key: "perMin";
    readonly seconds: 60;
}, {
    readonly key: "per10Min";
    readonly seconds: number;
}, {
    readonly key: "perHour";
    readonly seconds: number;
}, {
    readonly key: "perDay";
    readonly seconds: number;
}, {
    readonly key: "perWeek";
    readonly seconds: number;
}, {
    readonly key: "perMonth";
    readonly seconds: number;
}];
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
export interface LambderDdbRateLimiterOptions {
    tableName: string;
    region?: string;
    /** Partition key prefix, keeps counters separated from other systems in a shared table. Default: "RL". */
    keyPrefix?: string;
    /** Multiplier applied to the window length when setting the item TTL. */
    ttlWindowMultiplier?: number;
    /** Allow the request when DynamoDB itself errors. Defaults to false. */
    failOpen?: boolean;
    client?: DynamoDBClient;
}
/**
 * Fixed-window rate limiter backed by DynamoDB.
 *
 * Each window is a single item counted with a conditional `ADD`, so the
 * increment and the limit check happen atomically in one request. Windows are
 * evaluated from smallest to largest and evaluation stops at the first
 * exceeded window, which keeps blocked requests cheap and spares the larger
 * counters. Attempts count, not successes: a counter checked before the
 * refusing one keeps its increment (there is no compensating decrement, which
 * would give up the conditional-ADD atomicity). Items carry an `expiresAt`
 * attribute for DynamoDB TTL.
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on `expiresAt`.
 * Items are prefixed `RL#` by default, so the table can be shared with
 * LambderDdbCache (`CACHE#`) and LambderDdbIdempotency (`IDEM#`) without key
 * collisions.
 */
export declare class LambderDdbRateLimiter {
    readonly tableName: string;
    readonly keyPrefix: string;
    private readonly client;
    private readonly ttlWindowMultiplier;
    private readonly failOpen;
    constructor(options: LambderDdbRateLimiterOptions);
    /**
     * Increment every configured window for `trackerKey` (IP, session, user id, ...)
     * and report whether any of them is over its limit, with the window's
     * reset time when so.
     */
    isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult>;
    /** Increments one window counter. Returns true when the limit was already reached. */
    private incrementWindow;
}
export default LambderDdbRateLimiter;

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
export interface LambderRateLimitPolicy {
    perMin?: number;
    per10Min?: number;
    perHour?: number;
    perDay?: number;
    perWeek?: number;
    perMonth?: number;
}
export type LambderRateLimitExceededMap = Partial<Record<keyof LambderRateLimitPolicy, number>>;
/** `false` when allowed, otherwise the window(s) whose limit was hit. */
export type LambderRateLimitResult = false | LambderRateLimitExceededMap;
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
 * exceeded window, which keeps blocked requests cheap and avoids inflating the
 * larger counters. Items carry an `expiresAt` attribute for DynamoDB TTL.
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
     * and report whether any of them is over its limit.
     */
    isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult>;
    /** Increments one window counter. Returns true when the limit was already reached. */
    private incrementWindow;
}
export default LambderDdbRateLimiter;

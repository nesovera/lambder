import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { type LambderRateLimiter, type LambderRateLimitPolicy, type LambderRateLimitResult } from "../shared/contracts/LambderRateLimiter.js";
export interface LambderDdbRateLimiterOptions {
    tableName: string;
    /** Region the client is created for on first use; the SDK's default chain otherwise. */
    region?: string;
    /** Partition key prefix, keeps counters separated from other systems in a shared table. Default: "RL". */
    keyPrefix?: string;
    /** Multiplier applied to the window length when setting the item TTL. */
    ttlWindowMultiplier?: number;
    client?: DynamoDBClient;
    /**
     * The clock the windows are computed against, injectable the way
     * LambderMemoryRateLimiter's is, so the conformance suite can drive both
     * implementations across a window boundary through one clock.
     */
    now?: () => number;
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
 * The tracker key is caller data (an address, a session key, whatever a
 * policy handler returned), so a key whose partition key would pass
 * DynamoDB's 2048-byte limit is refused here, before any window is counted,
 * rather than reaching the table and coming back as a ValidationException:
 * that is not a conditional-check failure, so it escapes as a store error and
 * a caller failing open on it counts nothing at all, which is the limit
 * silently off. Lambder's own engine folds an over-long key into a digest
 * long before this, so a key that gets here came from a direct caller.
 *
 * A DynamoDB error propagates: a limiter says whether the caller is over its
 * limit, and it cannot answer that question when it cannot reach the table.
 * Whether an unanswerable limit lets the request through is the application's
 * call, not the storage's, so it is made once for every limiter at
 * `rateLimits.failOpen` and the engine there handles the throw.
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on `expiresAt`.
 * Items are prefixed `RL#` by default, so the table can be shared with
 * LambderDdbCache (`CACHE#`) and LambderDdbIdempotencyStore (`IDEM#`) without key
 * collisions.
 */
export declare class LambderDdbRateLimiter implements LambderRateLimiter {
    readonly tableName: string;
    readonly keyPrefix: string;
    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    private readonly ready;
    private readonly ttlWindowMultiplier;
    private readonly now;
    constructor(options: LambderDdbRateLimiterOptions);
    /**
     * Increment every configured window for `trackerKey` (IP, session, user id, ...)
     * and report whether any of them is over its limit, with the window's
     * reset time when so.
     */
    isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult>;
    /** The item's partition key, refused when the tracker key makes it one DynamoDB will not take. */
    private partitionKeyFor;
    /** Increments one window counter. Returns true when the limit was already reached. */
    private incrementWindow;
}
export default LambderDdbRateLimiter;

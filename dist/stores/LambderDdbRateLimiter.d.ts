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
 * Each window is one item counted with a conditional `ADD`, so the increment
 * and the limit check are one atomic request. Windows are evaluated smallest
 * first and evaluation stops at the first exceeded one, which keeps blocked
 * requests cheap and spares the larger counters. Attempts count, not
 * successes: a counter checked before the refusing one keeps its increment,
 * since a compensating decrement would give up the conditional-ADD
 * atomicity. Items carry an `expiresAt` attribute for DynamoDB TTL.
 *
 * The tracker key is caller data (an address, a session key, whatever a
 * policy handler returned), so a key whose partition key would pass
 * DynamoDB's 2048-byte limit is refused here, before any window is counted.
 * At the table it would come back as a ValidationException, which is not a
 * conditional-check failure: it would escape as a store error, and a caller
 * failing open on it would count nothing, leaving the limit silently off.
 * Lambder's own engine folds an over-long key into a digest first, so a key
 * that gets here came from a direct caller.
 *
 * A DynamoDB error propagates: a limiter cannot say whether the caller is
 * over its limit when it cannot reach the table, and whether an unanswerable
 * limit lets the request through is the application's call, made once for
 * every limiter at `rateLimits.failOpen`.
 *
 * A throttle on the key's range can be an answer instead. DynamoDB
 * throttles a partition's writes at roughly a thousand a second, and the SDK
 * retries first, so a throttle whose reason is KeyRangeThroughputExceeded
 * means the partition holding this counter is flooded. A partition holds a
 * range of keys, though, not one: a flood on one address, or a session or
 * cache spike on a shared table, throttles every counter on the same
 * partition. The key's own counts tell the flood from its neighbours: the
 * throttled window's and every capped window's after it, the ones this
 * attempt has not been counted against yet, each read with a consistent
 * GetItem, in parallel (reads have their own throughput, which the throttled
 * writes leave alone). A key at or over the limit of any of them is the
 * flood: it is refused, since passed on as a failure `failOpen` would wave
 * the flood through unmetered, and the Retry-After is a few seconds, the
 * time the partition takes to recover, rather than the window's reset. A key
 * over its daily cap whose per-minute counter has just started again is the
 * flood as much as one over its per-minute cap. Under every limit, or when a
 * read fails too, the key is a neighbour: the throttle propagates like any
 * other store failure and `failOpen` decides, as it does for a throttle of
 * the table or the account (its provisioned capacity, an on-demand maximum,
 * the account's quota), so no caller under its limit is refused because the
 * table is busy with somebody else.
 *
 * A flood repeats, and each repeat would cost the partition another
 * throttled write and another consistent read, until the reads throttle too
 * and the flood fails open. So the process remembers, for
 * THROTTLED_RETRY_SECONDS, each window it read at its limit, and refuses the
 * key's next attempts from memory without touching the table, which also
 * lets the partition recover for the neighbours. A count only rises within
 * its window, so the table would answer the same. A window whose read was
 * throttled as well is remembered too, with the throttle it was answered
 * with: a next attempt whose write is throttled there again skips the read
 * and throws that same throttle, which `rateLimits.failOpen` logs once
 * rather than once per request.
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
    /** The windows seen during key-range throttles, by (partition key, window, window start); see the class doc. */
    private readonly throttledWindows;
    constructor(options: LambderDdbRateLimiterOptions);
    /** The clock the windows are computed against, for the engine's Retry-After. */
    clockMilliseconds(): number;
    /**
     * Increment every configured window for `trackerKey` (IP, session, user id, ...)
     * and report whether any of them is over its limit, with the window's
     * reset time when so.
     */
    isRateLimited(trackerKey: string, policy: LambderRateLimitPolicy): Promise<LambderRateLimitResult>;
    /** The item's partition key, refused when the tracker key makes it one DynamoDB will not take. */
    private partitionKeyFor;
    /**
     * Increments one window counter. True when the limit was already reached
     * (the refused condition is the limiter's own answer); any other failure
     * throws.
     */
    private incrementWindow;
    /**
     * The answer to a key-range throttle on the first of `uncounted`: that
     * window and every capped one after it, the windows this attempt has not
     * been counted against. The windows before it counted this attempt and
     * allowed it, so reading them could only turn the attempt that filled
     * one into a refusal.
     *
     * Each count is read strongly consistent: the count that decides is the
     * one the throttled writes were racing to raise, and a replica lagging
     * behind them could read a key that has just reached its limit as under
     * it. Any window at or over its limit refuses, and is remembered (see the
     * class doc). Otherwise the throttle is thrown on, and when a read was
     * throttled too, the throttled window is remembered with it, so the
     * key's next attempts skip the read and throw that same throttle.
     */
    private answerKeyRangeThrottle;
}
export default LambderDdbRateLimiter;

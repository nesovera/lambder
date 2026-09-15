import type { DynamoDBClient, UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import {
    assertPartitionKeyFits, createDynamoClientLoader, isConditionalCheckFailure,
    type LambderDynamoClientReady,
} from "./LambderDdbSdk.js";
import { assertNumberAtLeast } from "../shared/util/LambderOptionChecks.js";
import {
    RATE_LIMIT_WINDOWS,
    type LambderRateLimiter,
    type LambderRateLimitPolicy,
    type LambderRateLimitResult,
} from "../shared/contracts/LambderRateLimiter.js";

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
export class LambderDdbRateLimiter implements LambderRateLimiter {
    readonly tableName: string;
    readonly keyPrefix: string;

    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    private readonly ready: () => Promise<LambderDynamoClientReady>;
    private readonly ttlWindowMultiplier: number;
    private readonly now: () => number;

    constructor(options: LambderDdbRateLimiterOptions) {
        if (!options.tableName.trim()) throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "RL";

        this.ttlWindowMultiplier = assertNumberAtLeast(options.ttlWindowMultiplier ?? 2, 1, "ttlWindowMultiplier");

        this.now = options.now ?? (() => Date.now());
        this.ready = createDynamoClientLoader({ user: "LambderDdbRateLimiter", region: options.region, client: options.client });
    }

    /**
     * Increment every configured window for `trackerKey` (IP, session, user id, ...)
     * and report whether any of them is over its limit, with the window's
     * reset time when so.
     */
    async isRateLimited(
        trackerKey: string,
        policy: LambderRateLimitPolicy,
    ): Promise<LambderRateLimitResult> {
        const nowSeconds = Math.floor(this.now() / 1000);
        // Once for the whole call, and before the first window is counted: a
        // key the table will not take fails every window the same way, so
        // refusing it here is the difference between one clear error and a
        // policy that counts nothing while reporting nothing.
        const partitionKey = this.partitionKeyFor(trackerKey);
        for (const { key, seconds } of RATE_LIMIT_WINDOWS) {
            const limit = policy[key];
            if (!limit) continue;

            const windowStart = Math.floor(nowSeconds / seconds) * seconds;
            const exceeded = await this.incrementWindow(partitionKey, key, windowStart, seconds, limit, nowSeconds);
            if (exceeded) return { window: key, limit, resetAt: windowStart + seconds };
        }
        return false;
    }

    /** The item's partition key, refused when the tracker key makes it one DynamoDB will not take. */
    private partitionKeyFor(trackerKey: string): string {
        return assertPartitionKeyFits({
            user: "LambderDdbRateLimiter",
            what: "tracker key",
            partitionKey: `${this.keyPrefix}#${trackerKey}`,
            remedy: "Shorten the key the policy hands the limiter.",
        });
    }

    /** Increments one window counter. Returns true when the limit was already reached. */
    private async incrementWindow(
        partitionKey: string,
        sortKeyPrefix: string,
        windowStart: number,
        windowSeconds: number,
        limit: number,
        nowSeconds: number,
    ): Promise<boolean> {
        const expiresAt = nowSeconds + Math.ceil(windowSeconds * this.ttlWindowMultiplier);

        const input: UpdateItemCommandInput = {
            TableName: this.tableName,
            Key: {
                pk: { S: partitionKey },
                sk: { S: `${sortKeyPrefix}#${windowStart}` },
            },
            UpdateExpression: "ADD #count :one SET #expiresAt = if_not_exists(#expiresAt, :expiresAt)",
            ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
            ExpressionAttributeNames: { "#count": "count", "#expiresAt": "expiresAt" },
            ExpressionAttributeValues: {
                ":one": { N: "1" },
                ":expiresAt": { N: String(expiresAt) },
                ":limit": { N: String(limit) },
            },
        };

        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.UpdateItemCommand(input));
            return false;
        } catch (error) {
            // The refused condition is the limiter's own answer; anything else
            // is the table being unreachable, which only the caller can decide
            // what to do about.
            if (isConditionalCheckFailure(error)) return true;
            throw error;
        }
    }
}

export default LambderDdbRateLimiter;

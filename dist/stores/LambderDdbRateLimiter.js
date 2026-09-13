import { loadDynamoClientSdk } from "./LambderDdbSdk.js";
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
];
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
export class LambderDdbRateLimiter {
    tableName;
    keyPrefix;
    /** The client given at creation, or one created from `region` on first use; the SDK arrives with it. */
    providedClient;
    region;
    readyPromise;
    ttlWindowMultiplier;
    failOpen;
    constructor(options) {
        if (!options.tableName.trim())
            throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "RL";
        this.ttlWindowMultiplier = options.ttlWindowMultiplier ?? 2;
        if (!Number.isFinite(this.ttlWindowMultiplier) || this.ttlWindowMultiplier < 1) {
            throw new Error("ttlWindowMultiplier must be a number greater than or equal to 1");
        }
        this.failOpen = options.failOpen ?? false;
        this.providedClient = options.client;
        this.region = options.region;
    }
    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    ready() {
        this.readyPromise ??= loadDynamoClientSdk("LambderDdbRateLimiter")
            .then((sdk) => ({ sdk, client: this.providedClient ?? new sdk.DynamoDBClient(this.region ? { region: this.region } : {}) }))
            .catch((error) => { this.readyPromise = undefined; throw error; });
        return this.readyPromise;
    }
    /**
     * Increment every configured window for `trackerKey` (IP, session, user id, ...)
     * and report whether any of them is over its limit, with the window's
     * reset time when so.
     */
    async isRateLimited(trackerKey, policy) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        for (const { key, seconds } of RATE_LIMIT_WINDOWS) {
            const limit = policy[key];
            if (!limit)
                continue;
            const windowStart = Math.floor(nowSeconds / seconds) * seconds;
            const exceeded = await this.incrementWindow(trackerKey, key, windowStart, seconds, limit, nowSeconds);
            if (exceeded)
                return { window: key, limit, resetAt: windowStart + seconds };
        }
        return false;
    }
    /** Increments one window counter. Returns true when the limit was already reached. */
    async incrementWindow(trackerKey, sortKeyPrefix, windowStart, windowSeconds, limit, nowSeconds) {
        const expiresAt = nowSeconds + Math.ceil(windowSeconds * this.ttlWindowMultiplier);
        const input = {
            TableName: this.tableName,
            Key: {
                pk: { S: `${this.keyPrefix}#${trackerKey}` },
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
        }
        catch (error) {
            if (error.name === "ConditionalCheckFailedException")
                return true;
            if (this.failOpen) {
                // Failing open swallows the error from the caller's view, so
                // keep the infra failure visible in the logs.
                console.error(`LambderDdbRateLimiter: DynamoDB error while counting "${trackerKey}", allowing the request (failOpen).`, error);
                return false;
            }
            throw error;
        }
    }
}
export default LambderDdbRateLimiter;

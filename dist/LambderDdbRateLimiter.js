import { DynamoDBClient, UpdateItemCommand, } from "@aws-sdk/client-dynamodb";
const WINDOW_CONFIG = [
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
 * exceeded window, which keeps blocked requests cheap and avoids inflating the
 * larger counters. Items carry an `expiresAt` attribute for DynamoDB TTL.
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on `expiresAt`.
 * Items are prefixed `RL#` by default, so the table can be shared with
 * LambderDdbCache (`CACHE#`) and LambderDdbIdempotency (`IDEM#`) without key
 * collisions.
 */
export class LambderDdbRateLimiter {
    tableName;
    keyPrefix;
    client;
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
        this.client = options.client ?? new DynamoDBClient(options.region ? { region: options.region } : {});
    }
    /**
     * Increment every configured window for `trackerKey` (IP, session, user id, ...)
     * and report whether any of them is over its limit.
     */
    async isRateLimited(trackerKey, policy) {
        for (const { key, seconds } of WINDOW_CONFIG) {
            const limit = policy[key];
            if (!limit)
                continue;
            const exceeded = await this.incrementWindow(trackerKey, key, seconds, limit);
            if (exceeded)
                return { [key]: limit };
        }
        return false;
    }
    /** Increments one window counter. Returns true when the limit was already reached. */
    async incrementWindow(trackerKey, sortKeyPrefix, windowSeconds, limit) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
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
            await this.client.send(new UpdateItemCommand(input));
            return false;
        }
        catch (error) {
            if (error.name === "ConditionalCheckFailedException")
                return true;
            if (this.failOpen)
                return false;
            throw error;
        }
    }
}
export default LambderDdbRateLimiter;

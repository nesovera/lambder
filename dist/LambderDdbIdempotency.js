import crypto from "crypto";
import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand, } from "@aws-sdk/client-dynamodb";
/**
 * DynamoDB-backed idempotency records: one item per (identity, api, key)
 * scope, claimed atomically with a conditional put. The first request claims
 * the scope as "pending"; concurrent duplicates see "pending"; once the
 * response is stored via complete(), replays get it back verbatim until the
 * TTL. Records whose expiresAt has passed count as absent (DynamoDB TTL
 * deletion is lazy, so expiry is enforced in the condition, not left to TTL).
 *
 * Every claim carries a random ownerToken, and complete()/abandon() are
 * conditional on still holding it: an original that outlives its pending TTL
 * and loses the scope to a retry can no longer overwrite or delete the
 * retry's claim (both settle calls become silent no-ops instead).
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on
 * `expiresAt`. Items are prefixed `IDEM#` by default, so the table can be
 * shared with LambderDdbRateLimiter (`RL#`) and LambderDdbCache (`CACHE#`)
 * without key collisions.
 */
export class LambderDdbIdempotency {
    tableName;
    keyPrefix;
    client;
    constructor(options) {
        if (!options.tableName.trim())
            throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "IDEM";
        this.client = options.client ?? new DynamoDBClient(options.region ? { region: options.region } : {});
    }
    itemKey(scopeKey) {
        return { pk: { S: `${this.keyPrefix}#${scopeKey}` }, sk: { S: "idem" } };
    }
    /**
     * Claim the scope. "new" means this request now owns it (proven by the
     * returned ownerToken) and must call complete() or abandon(); "pending"
     * means another request owns it right now; "done" carries the stored
     * response to replay.
     */
    async begin(scopeKey, { pendingTtlSeconds }) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const ownerToken = crypto.randomBytes(16).toString("hex");
        try {
            await this.client.send(new PutItemCommand({
                TableName: this.tableName,
                Item: {
                    ...this.itemKey(scopeKey),
                    state: { S: "pending" },
                    ownerToken: { S: ownerToken },
                    expiresAt: { N: String(nowSeconds + pendingTtlSeconds) },
                },
                ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
                ExpressionAttributeValues: { ":now": { N: String(nowSeconds) } },
            }));
            return { state: "new", ownerToken };
        }
        catch (error) {
            if (error.name !== "ConditionalCheckFailedException")
                throw error;
        }
        const existing = await this.client.send(new GetItemCommand({
            TableName: this.tableName,
            Key: this.itemKey(scopeKey),
            ConsistentRead: true,
        }));
        const item = existing.Item;
        // Deleted between the put and the read: treat as in-flight, the retry resolves it.
        if (!item)
            return { state: "pending" };
        if (item.state?.S === "done") {
            return {
                state: "done",
                statusCode: Number(item.statusCode?.N ?? 200),
                contentType: item.contentType?.S ?? null,
                body: item.body?.S ?? "",
            };
        }
        return { state: "pending" };
    }
    /**
     * Store the response for replays, overwriting the pending claim. Requires
     * still holding the claim: returns false (storing nothing) when the
     * ownerToken no longer matches, i.e. the claim expired and a retry took
     * the scope over.
     */
    async complete(scopeKey, ownerToken, { statusCode, contentType, body, ttlSeconds }) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        try {
            await this.client.send(new PutItemCommand({
                TableName: this.tableName,
                Item: {
                    ...this.itemKey(scopeKey),
                    state: { S: "done" },
                    ownerToken: { S: ownerToken },
                    statusCode: { N: String(statusCode) },
                    ...(contentType ? { contentType: { S: contentType } } : {}),
                    body: { S: body },
                    expiresAt: { N: String(nowSeconds + ttlSeconds) },
                },
                ConditionExpression: "ownerToken = :owner",
                ExpressionAttributeValues: { ":owner": { S: ownerToken } },
            }));
            return true;
        }
        catch (error) {
            if (error.name !== "ConditionalCheckFailedException")
                throw error;
            return false;
        }
    }
    /**
     * Release the claim without storing a response (crash, uncacheable
     * response), so a retry can execute. Conditional on still holding the
     * claim; a lost claim makes this a silent no-op.
     */
    async abandon(scopeKey, ownerToken) {
        try {
            await this.client.send(new DeleteItemCommand({
                TableName: this.tableName,
                Key: this.itemKey(scopeKey),
                ConditionExpression: "ownerToken = :owner",
                ExpressionAttributeValues: { ":owner": { S: ownerToken } },
            }));
        }
        catch (error) {
            if (error.name !== "ConditionalCheckFailedException")
                throw error;
        }
    }
}
export default LambderDdbIdempotency;

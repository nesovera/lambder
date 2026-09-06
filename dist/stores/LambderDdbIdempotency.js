import crypto from "crypto";
import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand, } from "@aws-sdk/client-dynamodb";
import { brotliCompressText, brotliDecompressText } from "./LambderDdbCompression.js";
/** Bodies at or above this size are stored Brotli-compressed; smaller ones stay plain. */
const COMPRESS_MIN_BYTES = 1024;
/**
 * Stored-body budget inside DynamoDB's 400KB item limit (headers, keys and
 * attributes need headroom). Applies to the bytes actually stored, so a
 * large compressible response (JSON usually shrinks 5-10x) still replays.
 */
const MAX_STORED_BODY_BYTES = 350_000;
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
 * Stored bodies of 1KB or more are Brotli-compressed (same scheme as
 * LambderDdbCache): the bodies are JSON envelopes that typically shrink
 * 5-10x, which cuts DynamoDB write units and lets large responses fit the
 * item budget instead of skipping replay storage.
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on
 * `expiresAt`. Items are prefixed `IDEM#` by default, so the table can be
 * shared with LambderDdbRateLimiter (`RL#`) and LambderDdbCache (`CACHE#`)
 * without key collisions.
 */
export class LambderDdbIdempotency {
    tableName;
    keyPrefix;
    compressionQuality;
    client;
    constructor(options) {
        if (!options.tableName.trim())
            throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "IDEM";
        this.compressionQuality = options.compressionQuality ?? 5;
        if (!Number.isInteger(this.compressionQuality) || this.compressionQuality < 0 || this.compressionQuality > 11) {
            throw new Error("compressionQuality must be an integer from 0 to 11");
        }
        this.client = options.client ?? new DynamoDBClient(options.region ? { region: options.region } : {});
    }
    itemKey(scopeKey) {
        return { pk: { S: `${this.keyPrefix}#${scopeKey}` }, sk: { S: "idem" } };
    }
    /** Parse a stored item's response headers. */
    static readItemHeaders(item) {
        const raw = item.headersJson?.S;
        if (!raw)
            return {};
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object")
                return parsed;
        }
        catch { /* corrupt record: replay with no headers rather than fail */ }
        return {};
    }
    /** A stored item's response body: plain (`body`) or Brotli (`bodyBr` + `bodyBytes`). */
    static async readItemBody(item) {
        const compressed = item.bodyBr?.B;
        if (compressed) {
            const declaredBytes = Number(item.bodyBytes?.N ?? 0);
            if (!declaredBytes)
                throw new Error("LambderDdbIdempotency: compressed record is missing bodyBytes.");
            const output = await brotliDecompressText(Buffer.from(compressed), declaredBytes);
            if (output.length !== declaredBytes) {
                throw new Error("LambderDdbIdempotency: stored body length does not match its record.");
            }
            return output.toString("utf8");
        }
        return item.body?.S ?? "";
    }
    /**
     * Read the scope without claiming it: the stored response when a
     * completed, unexpired record exists, null otherwise (absent, pending, or
     * expired). Eventually-consistent read: a miss here only means the caller
     * proceeds to begin(), whose read is authoritative.
     */
    async peek(scopeKey) {
        const existing = await this.client.send(new GetItemCommand({
            TableName: this.tableName,
            Key: this.itemKey(scopeKey),
        }));
        const item = existing.Item;
        if (!item || item.state?.S !== "done")
            return null;
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (Number(item.expiresAt?.N ?? 0) <= nowSeconds)
            return null;
        return {
            statusCode: Number(item.statusCode?.N ?? 200),
            headers: LambderDdbIdempotency.readItemHeaders(item),
            body: await LambderDdbIdempotency.readItemBody(item),
        };
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
                headers: LambderDdbIdempotency.readItemHeaders(item),
                body: await LambderDdbIdempotency.readItemBody(item),
            };
        }
        return { state: "pending" };
    }
    /**
     * Store the response for replays, overwriting the pending claim. Bodies
     * of COMPRESS_MIN_BYTES or more are stored Brotli-compressed (they are
     * JSON envelopes, which typically shrink 5-10x), cutting DynamoDB write
     * units and letting large responses fit the item budget; smaller bodies
     * stay plain. Returns:
     *
     * - "stored": the record is in place and will replay.
     * - "too-large": even compressed, the body exceeds the item budget;
     *   nothing was written and the caller should release the claim.
     * - "lost": the ownerToken no longer matches, i.e. the claim expired and
     *   a retry took the scope over; nothing was written.
     */
    async complete(scopeKey, ownerToken, { statusCode, headers, body, ttlSeconds }) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const rawBody = Buffer.from(body, "utf8");
        let bodyAttributes;
        if (rawBody.byteLength >= COMPRESS_MIN_BYTES) {
            const compressed = await brotliCompressText(rawBody, this.compressionQuality);
            if (compressed.byteLength > MAX_STORED_BODY_BYTES)
                return "too-large";
            // bodyBytes bounds and verifies decompression on read.
            bodyAttributes = { bodyBr: { B: compressed }, bodyBytes: { N: String(rawBody.byteLength) } };
        }
        else {
            bodyAttributes = { body: { S: body } };
        }
        try {
            await this.client.send(new PutItemCommand({
                TableName: this.tableName,
                Item: {
                    ...this.itemKey(scopeKey),
                    state: { S: "done" },
                    ownerToken: { S: ownerToken },
                    statusCode: { N: String(statusCode) },
                    headersJson: { S: JSON.stringify(headers) },
                    ...bodyAttributes,
                    expiresAt: { N: String(nowSeconds + ttlSeconds) },
                },
                ConditionExpression: "ownerToken = :owner",
                ExpressionAttributeValues: { ":owner": { S: ownerToken } },
            }));
            return "stored";
        }
        catch (error) {
            if (error.name !== "ConditionalCheckFailedException")
                throw error;
            return "lost";
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

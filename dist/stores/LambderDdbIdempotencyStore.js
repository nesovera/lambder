import { assertPartitionKeyFits, createDynamoClientLoader, isConditionalCheckFailure, } from "./LambderDdbSdk.js";
import { getCrypto } from "../shared/util/LambderNodeModules.js";
import { compressText, restoreText } from "../shared/wire/LambderCompressionCodec.js";
import { resolveCompressionOption, } from "../shared/wire/LambderCompressionOption.js";
/** Bodies of 1KB or more are stored Brotli-compressed by default; smaller ones stay plain. */
const COMPRESSION_DEFAULTS = { minBytes: 1024, quality: 5 };
/**
 * Stored-body budget inside DynamoDB's 400KB item limit (headers, keys and
 * attributes need headroom). Applies to the bytes actually stored, so a
 * large compressible response (JSON usually shrinks 5-10x) still replays.
 */
const MAX_STORED_BODY_BYTES = 350_000;
/**
 * Ceiling on a stored body's declared length, the budget the restore
 * decompresses under. The store's own writes stay far inside it (a response
 * that reaches a client is a few megabytes at most, and the compressed bytes
 * must fit MAX_STORED_BODY_BYTES), so a record declaring more is not this
 * store's, and trusting it would let a few hundred kilobytes of Brotli expand
 * until the function dies. The cache bounds the same number against its
 * maxValueBytes.
 */
const MAX_REPLAY_BODY_BYTES = 32 * 1024 * 1024;
/**
 * What an item that keeps no fingerprint reports: one no request matches,
 * since the engine's fingerprints are never empty. Such an item was not
 * written by this store (every claim and record it writes keeps one), so the
 * engine refuses the key as reused, a 409 a key scope moves past, rather than
 * replaying an answer it cannot tie to the request or reading the scope as
 * free and running the request over it.
 */
const UNKNOWN_REQUEST_FINGERPRINT = "";
/**
 * A number attribute as stored, or the fallback when it is missing or not a
 * number. `Number(undefined)` and `Number("nope")` are both NaN, which every
 * later comparison answers false to: a NaN expiry reads as "not expired" and
 * a NaN status code reaches the client as one.
 */
const storedNumber = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
};
/** 16 random bytes, hex, through the optional-crypto seam so a bundler's browser stub cannot break the import. */
const newOwnerToken = async () => {
    const crypto = await getCrypto();
    if (!crypto)
        throw new Error("LambderDdbIdempotencyStore requires a Node.js environment.");
    return crypto.randomBytes(16).toString("hex");
};
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
 * and loses the scope to a retry cannot overwrite or delete the retry's claim
 * (both settle calls become silent no-ops). complete() also requires the
 * claim to be unexpired, so an owner whose claim ran out reports "lost"
 * whether or not TTL deletion has caught up with it, as the memory store
 * does. abandon() also requires the claim to be pending, so it never deletes
 * a stored answer.
 *
 * Stored bodies are Brotli-compressed from 1KB by default (the scheme
 * LambderDdbCache uses, see the `compression` option): JSON envelopes
 * typically shrink 5-10x, which cuts write units and lets large responses
 * fit the item budget instead of skipping replay storage.
 *
 * The scope key carries caller data (the client's idempotency key, and an
 * identity when one is configured), so a partition key past DynamoDB's
 * 2048-byte limit is refused here with an error naming the limit, rather
 * than coming back from the table as a ValidationException that reads as
 * "the table is broken".
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on
 * `expiresAt`. Items are prefixed `IDEM#` by default, so the table can be
 * shared with LambderDdbRateLimiter (`RL#`) and LambderDdbCache (`CACHE#`)
 * without key collisions.
 */
export class LambderDdbIdempotencyStore {
    tableName;
    keyPrefix;
    compression;
    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    ready;
    now;
    constructor(options) {
        if (!options.tableName.trim())
            throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "IDEM";
        this.compression = resolveCompressionOption(options.compression, COMPRESSION_DEFAULTS);
        this.now = options.now ?? (() => Date.now());
        this.ready = createDynamoClientLoader({ user: "LambderDdbIdempotencyStore", region: options.region, client: options.client });
    }
    nowSeconds() { return Math.floor(this.now() / 1000); }
    itemKey(scopeKey) {
        const partitionKey = assertPartitionKeyFits({
            user: "LambderDdbIdempotencyStore",
            what: "scope key",
            partitionKey: `${this.keyPrefix}#${scopeKey}`,
            remedy: "Shorten the idempotency key or the identity it is scoped by.",
        });
        return { pk: { S: partitionKey }, sk: { S: "idem" } };
    }
    /**
     * A stored item's response headers: the multi-value map the answer
     * replays. Every entry is checked to BE one, because the engine hands
     * what comes back to the response builder, which would ship a number or a
     * bare string as a header value.
     */
    static readItemHeaders(item) {
        const raw = item.headersJson?.S;
        if (!raw)
            return {};
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return {}; // Corrupt record: replay with no headers rather than fail the request.
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const headers = {};
        for (const [name, value] of Object.entries(parsed)) {
            // An own "__proto__" key survives JSON.parse and assigning it here
            // would set this object's prototype instead of adding a header.
            if (name === "__proto__")
                continue;
            if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
                headers[name] = value;
        }
        return headers;
    }
    /**
     * A stored item's response body: plain (`body`) or Brotli (`bodyBr` +
     * `bodyBytes`). The stored length is the decompression budget, so it is
     * checked here the way the headers are: a record declaring more than this
     * store ever writes is unusable, not an invitation to allocate it.
     */
    static async readItemBody(item) {
        const compressed = item.bodyBr?.B;
        if (!compressed)
            return item.body?.S ?? "";
        const declaredBytes = storedNumber(item.bodyBytes?.N, 0);
        if (declaredBytes > MAX_REPLAY_BODY_BYTES) {
            throw new Error(`LambderDdbIdempotencyStore: the stored body declares ${declaredBytes} bytes, over the ${MAX_REPLAY_BODY_BYTES}-byte replay limit, so the record is unusable.`);
        }
        return await restoreText(compressed, "br", { declaredBytes });
    }
    /** A stored answer as the engine reads it, with every field of the record checked rather than cast. */
    static async answerOf(item) {
        return {
            statusCode: storedNumber(item.statusCode?.N, 200),
            headers: LambderDdbIdempotencyStore.readItemHeaders(item),
            body: await LambderDdbIdempotencyStore.readItemBody(item),
            fingerprint: LambderDdbIdempotencyStore.fingerprintOf(item),
        };
    }
    /** The request fingerprint an item keeps; see UNKNOWN_REQUEST_FINGERPRINT for one that keeps none. */
    static fingerprintOf(item) {
        return item.fingerprint?.S ?? UNKNOWN_REQUEST_FINGERPRINT;
    }
    /**
     * Read the scope without claiming it: the stored response when a
     * completed, unexpired record exists, null otherwise (absent, pending, or
     * expired). Eventually-consistent read: a miss here only means the caller
     * proceeds to begin(), whose read is authoritative.
     */
    async peek(scopeKey) {
        const { client, sdk } = await this.ready();
        const existing = await client.send(new sdk.GetItemCommand({
            TableName: this.tableName,
            Key: this.itemKey(scopeKey),
        }));
        const item = existing.Item;
        if (!item || item.state?.S !== "done")
            return null;
        if (storedNumber(item.expiresAt?.N, 0) <= this.nowSeconds())
            return null;
        return await LambderDdbIdempotencyStore.answerOf(item);
    }
    /**
     * Claim the scope. "new" means this request now owns it (proven by the
     * returned ownerToken) and must call complete() or abandon(); "pending"
     * means another request owns it right now; "done" carries the stored
     * response to replay.
     *
     * One write either way: a refused claim hands back the item that refused
     * it (ALL_OLD), so there is no read after it. That item is also how a
     * claim the SDK retried after it had already landed recognizes itself:
     * the item carries this call's own ownerToken, so the scope is ours
     * rather than somebody else's in-flight original.
     */
    async begin(scopeKey, { pendingTtlSeconds, fingerprint }) {
        const nowSeconds = this.nowSeconds();
        const ownerToken = await newOwnerToken();
        let item;
        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.PutItemCommand({
                TableName: this.tableName,
                Item: {
                    ...this.itemKey(scopeKey),
                    state: { S: "pending" },
                    ownerToken: { S: ownerToken },
                    fingerprint: { S: fingerprint },
                    expiresAt: { N: String(nowSeconds + pendingTtlSeconds) },
                },
                // Every clause is one a missing attribute can satisfy rather
                // than block: DynamoDB reads a comparison whose operand path
                // is absent as FALSE, so `expiresAt <= :now` alone would
                // refuse an item carrying no expiry for ever, and a pending
                // one would deadlock its scope with no TTL able to retire it.
                ConditionExpression: "attribute_not_exists(pk) OR attribute_not_exists(expiresAt) OR expiresAt <= :now",
                ExpressionAttributeValues: { ":now": { N: String(nowSeconds) } },
                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            }));
            return { state: "new", ownerToken };
        }
        catch (error) {
            if (!isConditionalCheckFailure(error))
                throw error;
            item = error.Item;
        }
        // Refused with no item to show for it: gone again by the time the
        // condition was read, which the next retry resolves. The caller's own
        // fingerprint keeps it the in-flight 409, which a client retries
        // under the same key.
        if (!item)
            return { state: "pending", fingerprint };
        if (item.ownerToken?.S === ownerToken)
            return { state: "new", ownerToken };
        // The same expiry test peek runs, because the condition above cannot
        // make it: an item whose expiresAt is present but unreadable (a
        // partial write, another writer on a shared table) refuses the claim
        // AND is past nothing, so replaying it here would replay a stored
        // answer for ever. An unreadable expiry counts as expired, and the
        // scope reads as pending rather than as done.
        const live = storedNumber(item.expiresAt?.N, 0) > nowSeconds;
        if (live && item.state?.S === "done")
            return { state: "done", ...await LambderDdbIdempotencyStore.answerOf(item) };
        return { state: "pending", fingerprint: LambderDdbIdempotencyStore.fingerprintOf(item) };
    }
    /**
     * Store the response for replays, overwriting the pending claim. Bodies
     * from the compression option's minBytes up are stored Brotli-compressed
     * (see the class comment); smaller bodies, or all of them with
     * compression off, stay plain. Returns:
     *
     * - "stored": the record is in place and will replay.
     * - "too-large": even compressed, the body exceeds the item budget;
     *   nothing was written and the caller should release the claim.
     * - "lost": the ownerToken no longer matches, i.e. the claim expired and
     *   a retry took the scope over; nothing was written.
     */
    async complete(scopeKey, ownerToken, { statusCode, headers, body, fingerprint, ttlSeconds }) {
        const nowSeconds = this.nowSeconds();
        const rawBody = Buffer.from(body, "utf8");
        let bodyAttributes;
        // A zero-length body is never compressed, whatever minBytes says: it
        // would be stored as `bodyBr` with `bodyBytes: 0`, and a declared
        // length of zero is one the codec refuses on the way back, so the
        // record would be unreadable for its whole TTL and every retry would
        // execute again. The plain path stores it as the empty string, which
        // reads back as one.
        if (this.compression && rawBody.byteLength > 0 && rawBody.byteLength >= this.compression.minBytes) {
            const compressed = await compressText(rawBody, "br", this.compression.quality);
            if (compressed.byteLength > MAX_STORED_BODY_BYTES)
                return "too-large";
            // bodyBytes bounds and verifies decompression on read.
            bodyAttributes = { bodyBr: { B: compressed }, bodyBytes: { N: String(rawBody.byteLength) } };
        }
        else {
            // The budget is on what actually gets stored, so the plain path is
            // measured too. Without this an oversized body reaches DynamoDB and
            // comes back as a ValidationException, which is not a
            // ConditionalCheckFailedException and so escapes as a store error.
            if (rawBody.byteLength > MAX_STORED_BODY_BYTES)
                return "too-large";
            bodyAttributes = { body: { S: body } };
        }
        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.PutItemCommand({
                TableName: this.tableName,
                Item: {
                    ...this.itemKey(scopeKey),
                    state: { S: "done" },
                    ownerToken: { S: ownerToken },
                    statusCode: { N: String(statusCode) },
                    headersJson: { S: JSON.stringify(headers) },
                    ...bodyAttributes,
                    fingerprint: { S: fingerprint },
                    expiresAt: { N: String(nowSeconds + ttlSeconds) },
                },
                // The claim has to be BOTH still owned and still live. Owner
                // alone would let an owner whose claim has expired store over
                // it, since DynamoDB's TTL deletion is lazy and the expired
                // item is usually still there; the memory store answers "lost"
                // for the same call, and DynamoDB's answer would depend on
                // whether AWS had run the sweep yet.
                ConditionExpression: "ownerToken = :owner AND expiresAt > :now",
                ExpressionAttributeValues: { ":owner": { S: ownerToken }, ":now": { N: String(nowSeconds) } },
            }));
            return "stored";
        }
        catch (error) {
            if (!isConditionalCheckFailure(error))
                throw error;
            return "lost";
        }
    }
    /**
     * Release the claim without storing a response (crash, uncacheable
     * response), so a retry can execute. Conditional on still holding the
     * claim AND on its still being pending: a lost claim makes this a silent
     * no-op, and so does a settled record, whose owner token is still the
     * caller's. The engine abandons after a complete() that threw, and one
     * whose response was lost may have landed; deleting its record would
     * hand the retry a free scope, and the operation would run twice.
     */
    async abandon(scopeKey, ownerToken) {
        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.DeleteItemCommand({
                TableName: this.tableName,
                Key: this.itemKey(scopeKey),
                // `state` is a DynamoDB reserved word, hence the name placeholder.
                ConditionExpression: "ownerToken = :owner AND #state = :pending",
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: { ":owner": { S: ownerToken }, ":pending": { S: "pending" } },
            }));
        }
        catch (error) {
            if (!isConditionalCheckFailure(error))
                throw error;
        }
    }
}
export default LambderDdbIdempotencyStore;

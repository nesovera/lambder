import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    assertPartitionKeyFits, createDynamoClientLoader, isConditionalCheckFailure,
    type LambderDynamoClientReady,
} from "./LambderDdbSdk.js";
import { getCrypto } from "../shared/util/LambderNodeModules.js";
import { compressText, restoreText } from "../shared/wire/LambderCompressionCodec.js";
import type {
    LambderIdempotencyStore,
    LambderIdempotencyDoneRecord,
    LambderIdempotencyBeginResult,
} from "../shared/contracts/LambderIdempotencyStore.js";
import {
    resolveCompressionOption,
    type LambderCompressionOption, type LambderCompressionSettings,
} from "../shared/wire/LambderCompressionOption.js";

/** Bodies of 1KB or more are stored Brotli-compressed by default; smaller ones stay plain. */
const COMPRESSION_DEFAULTS: LambderCompressionSettings = { minBytes: 1024, quality: 5 };
/**
 * Stored-body budget inside DynamoDB's 400KB item limit (headers, keys and
 * attributes need headroom). Applies to the bytes actually stored, so a
 * large compressible response (JSON usually shrinks 5-10x) still replays.
 */
const MAX_STORED_BODY_BYTES = 350_000;
/**
 * Ceiling on a stored body's declared length, which is the budget the restore
 * decompresses under. The store's own writes stay far inside it (a response
 * that reaches a client at all is a few megabytes at most, and the compressed
 * bytes have to fit MAX_STORED_BODY_BYTES), so a record declaring more than
 * this is one this store did not write, and taking its word for it would let
 * a few hundred kilobytes of Brotli expand until the function dies. The
 * cache bounds the same number the same way, against its maxValueBytes.
 */
const MAX_REPLAY_BODY_BYTES = 32 * 1024 * 1024;

/**
 * A stored item as this store writes it. Nothing validates what comes back
 * from a table, so the attributes are typed as optional and every load-bearing
 * one is checked where it is read: a record written by an older version, by
 * another system sharing the table, or by a partial write is a record to
 * refuse rather than to cast.
 */
type LambderIdempotencyItem = {
    state?: { S?: string };
    ownerToken?: { S?: string };
    statusCode?: { N?: string };
    headersJson?: { S?: string };
    body?: { S?: string };
    bodyBr?: { B?: Uint8Array };
    bodyBytes?: { N?: string };
    expiresAt?: { N?: string };
};

/**
 * A number attribute as stored, or the fallback when it is missing or not a
 * number. `Number(undefined)` and `Number("nope")` are both NaN, which every
 * later comparison answers false to: a NaN expiry reads as "not expired" and
 * a NaN status code reaches the client as one.
 */
const storedNumber = (raw: string | undefined, fallback: number): number => {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
};

/** 16 random bytes, hex, through the optional-crypto seam so a bundler's browser stub cannot break the import. */
const newOwnerToken = async (): Promise<string> => {
    const crypto = await getCrypto();
    if(!crypto) throw new Error("LambderDdbIdempotencyStore requires a Node.js environment.");
    return crypto.randomBytes(16).toString("hex");
};

export interface LambderDdbIdempotencyStoreOptions {
    tableName: string;
    /** Region the client is created for on first use; the SDK's default chain otherwise. */
    region?: string;
    /** Partition key prefix, keeps records separated from other systems in a shared table. Default: "IDEM". */
    keyPrefix?: string;
    /**
     * Brotli compression of stored bodies. `true` (the default) is
     * `{ minBytes: 1024, quality: 5 }`; `false` stores every body plain; an
     * object overrides the defaults. Records of either shape read back, so
     * it can be switched on or off on a live table.
     */
    compression?: LambderCompressionOption;
    client?: DynamoDBClient;
    /**
     * The clock claims and records are expired against, injectable the way
     * LambderMemoryIdempotencyStore's is, so the conformance suite can expire a
     * claim in both implementations through one clock.
     */
    now?: () => number;
}

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
 * retry's claim (both settle calls become silent no-ops instead). complete()
 * also requires the claim to be unexpired, so an owner whose claim ran out
 * reports "lost" whether or not TTL deletion has caught up with it, which is
 * what the memory store has always reported.
 *
 * Stored bodies are Brotli-compressed from 1KB by default (same scheme as
 * LambderDdbCache, see the `compression` option): the bodies are JSON
 * envelopes that typically shrink 5-10x, which cuts DynamoDB write units
 * and lets large responses fit the item budget instead of skipping replay
 * storage.
 *
 * The scope key carries caller data (the client's idempotency key, and an
 * identity when one is configured), so a scope whose partition key would pass
 * DynamoDB's 2048-byte limit is refused here with an error that names the
 * limit, rather than reaching the table and coming back as a
 * ValidationException that reads as "the table is broken".
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on
 * `expiresAt`. Items are prefixed `IDEM#` by default, so the table can be
 * shared with LambderDdbRateLimiter (`RL#`) and LambderDdbCache (`CACHE#`)
 * without key collisions.
 */
export class LambderDdbIdempotencyStore implements LambderIdempotencyStore {
    readonly tableName: string;
    readonly keyPrefix: string;
    private readonly compression: LambderCompressionSettings | null;
    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    private readonly ready: () => Promise<LambderDynamoClientReady>;
    private readonly now: () => number;

    constructor(options: LambderDdbIdempotencyStoreOptions){
        if(!options.tableName.trim()) throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "IDEM";
        this.compression = resolveCompressionOption(options.compression, COMPRESSION_DEFAULTS);
        this.now = options.now ?? (() => Date.now());
        this.ready = createDynamoClientLoader({ user: "LambderDdbIdempotencyStore", region: options.region, client: options.client });
    }

    private nowSeconds(): number { return Math.floor(this.now() / 1000); }

    private itemKey(scopeKey: string){
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
    private static readItemHeaders(item: LambderIdempotencyItem): Record<string, string[]> {
        const raw = item.headersJson?.S;
        if(!raw) return {};
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {}; // Corrupt record: replay with no headers rather than fail the request.
        }
        if(!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const headers: Record<string, string[]> = {};
        for(const [name, value] of Object.entries(parsed)){
            // An own "__proto__" key survives JSON.parse and assigning it here
            // would set this object's prototype instead of adding a header.
            if(name === "__proto__") continue;
            if(Array.isArray(value) && value.every((entry) => typeof entry === "string")) headers[name] = value;
        }
        return headers;
    }

    /**
     * A stored item's response body: plain (`body`) or Brotli (`bodyBr` +
     * `bodyBytes`). The stored length is the decompression budget, so it is
     * checked here the way the headers are: a record declaring more than this
     * store ever writes is unusable, not an invitation to allocate it.
     */
    private static async readItemBody(item: LambderIdempotencyItem): Promise<string> {
        const compressed = item.bodyBr?.B;
        if(!compressed) return item.body?.S ?? "";
        const declaredBytes = storedNumber(item.bodyBytes?.N, 0);
        if(declaredBytes > MAX_REPLAY_BODY_BYTES){
            throw new Error(`LambderDdbIdempotencyStore: the stored body declares ${declaredBytes} bytes, over the ${MAX_REPLAY_BODY_BYTES}-byte replay limit, so the record is unusable.`);
        }
        return await restoreText(compressed, "br", { declaredBytes });
    }

    /** A stored answer as the engine reads it, with every field of the record checked rather than cast. */
    private static async answerOf(item: LambderIdempotencyItem): Promise<LambderIdempotencyDoneRecord> {
        return {
            statusCode: storedNumber(item.statusCode?.N, 200),
            headers: LambderDdbIdempotencyStore.readItemHeaders(item),
            body: await LambderDdbIdempotencyStore.readItemBody(item),
        };
    }

    /**
     * Read the scope without claiming it: the stored response when a
     * completed, unexpired record exists, null otherwise (absent, pending, or
     * expired). Eventually-consistent read: a miss here only means the caller
     * proceeds to begin(), whose read is authoritative.
     */
    async peek(scopeKey: string): Promise<LambderIdempotencyDoneRecord | null> {
        const { client, sdk } = await this.ready();
        const existing = await client.send(new sdk.GetItemCommand({
            TableName: this.tableName,
            Key: this.itemKey(scopeKey),
        }));
        const item: LambderIdempotencyItem | undefined = existing.Item;
        if(!item || item.state?.S !== "done") return null;
        if(storedNumber(item.expiresAt?.N, 0) <= this.nowSeconds()) return null;
        return await LambderDdbIdempotencyStore.answerOf(item);
    }

    /**
     * Claim the scope. "new" means this request now owns it (proven by the
     * returned ownerToken) and must call complete() or abandon(); "pending"
     * means another request owns it right now; "done" carries the stored
     * response to replay.
     */
    async begin(scopeKey: string, { pendingTtlSeconds }: { pendingTtlSeconds: number }): Promise<LambderIdempotencyBeginResult> {
        const nowSeconds = this.nowSeconds();
        const ownerToken = await newOwnerToken();
        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.PutItemCommand({
                TableName: this.tableName,
                Item: {
                    ...this.itemKey(scopeKey),
                    state: { S: "pending" },
                    ownerToken: { S: ownerToken },
                    expiresAt: { N: String(nowSeconds + pendingTtlSeconds) },
                },
                // Every clause is one a missing attribute can satisfy rather
                // than block: DynamoDB reads a comparison whose operand path
                // is absent as FALSE, so a condition that only asked
                // `expiresAt <= :now` refused an item carrying no expiry for
                // ever, and a pending one of those deadlocked its scope with
                // no TTL able to retire it.
                ConditionExpression: "attribute_not_exists(pk) OR attribute_not_exists(expiresAt) OR expiresAt <= :now",
                ExpressionAttributeValues: { ":now": { N: String(nowSeconds) } },
            }));
            return { state: "new", ownerToken };
        } catch (error) {
            if(!isConditionalCheckFailure(error)) throw error;
        }

        const { client, sdk } = await this.ready();
        const existing = await client.send(new sdk.GetItemCommand({
            TableName: this.tableName,
            Key: this.itemKey(scopeKey),
            ConsistentRead: true,
        }));
        const item: LambderIdempotencyItem | undefined = existing.Item;
        // Deleted between the put and the read: treat as in-flight, the retry resolves it.
        if(!item) return { state: "pending" };
        // The same expiry test peek runs, because the condition above cannot
        // make it: an item whose expiresAt is present but unreadable (a
        // partial write, another writer on a shared table) refuses the claim
        // AND is past nothing, so replaying it here would replay a stored
        // answer for ever. An unreadable expiry counts as expired, and the
        // scope reads as pending rather than as done.
        const live = storedNumber(item.expiresAt?.N, 0) > nowSeconds;
        if(live && item.state?.S === "done") return { state: "done", ...await LambderDdbIdempotencyStore.answerOf(item) };
        return { state: "pending" };
    }

    /**
     * Store the response for replays, overwriting the pending claim. Bodies
     * from the compression option's minBytes are stored Brotli-compressed
     * (they are JSON envelopes, which typically shrink 5-10x), cutting
     * DynamoDB write units and letting large responses fit the item budget;
     * smaller bodies, or all of them with compression off, stay plain.
     * Returns:
     *
     * - "stored": the record is in place and will replay.
     * - "too-large": even compressed, the body exceeds the item budget;
     *   nothing was written and the caller should release the claim.
     * - "lost": the ownerToken no longer matches, i.e. the claim expired and
     *   a retry took the scope over; nothing was written.
     */
    async complete(
        scopeKey: string,
        ownerToken: string,
        { statusCode, headers, body, ttlSeconds }: LambderIdempotencyDoneRecord & { ttlSeconds: number },
    ): Promise<"stored" | "too-large" | "lost"> {
        const nowSeconds = this.nowSeconds();

        const rawBody = Buffer.from(body, "utf8");
        let bodyAttributes: Record<string, { S: string } | { B: Uint8Array } | { N: string }>;
        // A zero-length body is never compressed, whatever minBytes says: it
        // would be stored as `bodyBr` with `bodyBytes: 0`, and a declared
        // length of zero is one the codec refuses on the way back, so the
        // record would be unreadable for its whole TTL and every retry would
        // execute again. The plain path stores it as the empty string, which
        // reads back as one.
        if(this.compression && rawBody.byteLength > 0 && rawBody.byteLength >= this.compression.minBytes){
            const compressed = await compressText(rawBody, "br", this.compression.quality);
            if(compressed.byteLength > MAX_STORED_BODY_BYTES) return "too-large";
            // bodyBytes bounds and verifies decompression on read.
            bodyAttributes = { bodyBr: { B: compressed }, bodyBytes: { N: String(rawBody.byteLength) } };
        }else{
            // The budget is on what actually gets stored, so the plain path is
            // measured too. Without this an oversized body reaches DynamoDB and
            // comes back as a ValidationException, which is not a
            // ConditionalCheckFailedException and so escapes as a store error.
            if(rawBody.byteLength > MAX_STORED_BODY_BYTES) return "too-large";
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
                    expiresAt: { N: String(nowSeconds + ttlSeconds) },
                },
                // The claim has to be BOTH still owned and still live. Owner
                // alone let an owner whose claim had already expired store
                // over it, because DynamoDB's TTL deletion is lazy and the
                // expired item is usually still sitting there. The memory
                // store drops an expired entry on read and answered "lost"
                // for the same call, so the two disagreed, and DynamoDB's
                // answer depended on whether AWS had got round to the sweep.
                ConditionExpression: "ownerToken = :owner AND expiresAt > :now",
                ExpressionAttributeValues: { ":owner": { S: ownerToken }, ":now": { N: String(nowSeconds) } },
            }));
            return "stored";
        } catch (error) {
            if(!isConditionalCheckFailure(error)) throw error;
            return "lost";
        }
    }

    /**
     * Release the claim without storing a response (crash, uncacheable
     * response), so a retry can execute. Conditional on still holding the
     * claim; a lost claim makes this a silent no-op.
     */
    async abandon(scopeKey: string, ownerToken: string): Promise<void> {
        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.DeleteItemCommand({
                TableName: this.tableName,
                Key: this.itemKey(scopeKey),
                ConditionExpression: "ownerToken = :owner",
                ExpressionAttributeValues: { ":owner": { S: ownerToken } },
            }));
        } catch (error) {
            if(!isConditionalCheckFailure(error)) throw error;
        }
    }
}

export default LambderDdbIdempotencyStore;

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { LambderIdempotencyStore, LambderIdempotencyDoneRecord, LambderIdempotencyBeginResult } from "../shared/contracts/LambderIdempotencyStore.js";
import { type LambderCompressionOption } from "../shared/wire/LambderCompressionOption.js";
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
export declare class LambderDdbIdempotencyStore implements LambderIdempotencyStore {
    readonly tableName: string;
    readonly keyPrefix: string;
    private readonly compression;
    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    private readonly ready;
    private readonly now;
    constructor(options: LambderDdbIdempotencyStoreOptions);
    private nowSeconds;
    private itemKey;
    /**
     * A stored item's response headers: the multi-value map the answer
     * replays. Every entry is checked to BE one, because the engine hands
     * what comes back to the response builder, which would ship a number or a
     * bare string as a header value.
     */
    private static readItemHeaders;
    /**
     * A stored item's response body: plain (`body`) or Brotli (`bodyBr` +
     * `bodyBytes`). The stored length is the decompression budget, so it is
     * checked here the way the headers are: a record declaring more than this
     * store ever writes is unusable, not an invitation to allocate it.
     */
    private static readItemBody;
    /** A stored answer as the engine reads it, with every field of the record checked rather than cast. */
    private static answerOf;
    /** The request fingerprint an item keeps; see UNKNOWN_REQUEST_FINGERPRINT for one that keeps none. */
    private static fingerprintOf;
    /**
     * Read the scope without claiming it: the stored response when a
     * completed, unexpired record exists, null otherwise (absent, pending, or
     * expired). Eventually-consistent read: a miss here only means the caller
     * proceeds to begin(), whose read is authoritative.
     */
    peek(scopeKey: string): Promise<LambderIdempotencyDoneRecord | null>;
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
    begin(scopeKey: string, { pendingTtlSeconds, fingerprint }: {
        pendingTtlSeconds: number;
        fingerprint: string;
    }): Promise<LambderIdempotencyBeginResult>;
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
    complete(scopeKey: string, ownerToken: string, { statusCode, headers, body, fingerprint, ttlSeconds }: LambderIdempotencyDoneRecord & {
        ttlSeconds: number;
    }): Promise<"stored" | "too-large" | "lost">;
    /**
     * Release the claim without storing a response (crash, uncacheable
     * response), so a retry can execute. Conditional on still holding the
     * claim AND on its still being pending: a lost claim makes this a silent
     * no-op, and so does a settled record, whose owner token is still the
     * caller's. The engine abandons after a complete() that threw, and one
     * whose response was lost may have landed; deleting its record would
     * hand the retry a free scope, and the operation would run twice.
     */
    abandon(scopeKey: string, ownerToken: string): Promise<void>;
}
export default LambderDdbIdempotencyStore;

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
export interface LambderDdbIdempotencyOptions {
    tableName: string;
    region?: string;
    /** Partition key prefix, keeps records separated from other systems in a shared table. Default: "IDEM". */
    keyPrefix?: string;
    /** Brotli quality (0-11) for stored bodies, like LambderDdbCache. Default: 5. */
    compressionQuality?: number;
    client?: DynamoDBClient;
}
export type LambderIdempotencyDoneRecord = {
    statusCode: number;
    /** Response headers stored with the record (normalized multi-value map). */
    headers: Record<string, string[]>;
    body: string;
};
export type LambderIdempotencyBeginResult = {
    state: "new";
    ownerToken: string;
} | {
    state: "pending";
} | ({
    state: "done";
} & LambderIdempotencyDoneRecord);
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
export declare class LambderDdbIdempotency {
    readonly tableName: string;
    readonly keyPrefix: string;
    private readonly compressionQuality;
    private readonly client;
    constructor(options: LambderDdbIdempotencyOptions);
    private itemKey;
    /** Parse a stored item's response headers. */
    private static readItemHeaders;
    /** A stored item's response body: plain (`body`) or Brotli (`bodyBr` + `bodyBytes`). */
    private static readItemBody;
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
     */
    begin(scopeKey: string, { pendingTtlSeconds }: {
        pendingTtlSeconds: number;
    }): Promise<LambderIdempotencyBeginResult>;
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
    complete(scopeKey: string, ownerToken: string, { statusCode, headers, body, ttlSeconds }: {
        statusCode: number;
        headers: Record<string, string[]>;
        body: string;
        ttlSeconds: number;
    }): Promise<"stored" | "too-large" | "lost">;
    /**
     * Release the claim without storing a response (crash, uncacheable
     * response), so a retry can execute. Conditional on still holding the
     * claim; a lost claim makes this a silent no-op.
     */
    abandon(scopeKey: string, ownerToken: string): Promise<void>;
}
export default LambderDdbIdempotency;

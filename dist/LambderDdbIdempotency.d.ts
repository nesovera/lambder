import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
export interface LambderDdbIdempotencyOptions {
    tableName: string;
    region?: string;
    /** Partition key prefix, keeps records separated from other systems in a shared table. Default: "IDEM". */
    keyPrefix?: string;
    client?: DynamoDBClient;
}
export type LambderIdempotencyBeginResult = {
    state: "new";
    ownerToken: string;
} | {
    state: "pending";
} | {
    state: "done";
    statusCode: number;
    contentType: string | null;
    body: string;
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
 * and loses the scope to a retry can no longer overwrite or delete the
 * retry's claim (both settle calls become silent no-ops instead).
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on
 * `expiresAt`. Items are prefixed `IDEM#` by default, so the table can be
 * shared with LambderDdbRateLimiter (`RL#`) and LambderDdbCache (`CACHE#`)
 * without key collisions.
 */
export declare class LambderDdbIdempotency {
    readonly tableName: string;
    readonly keyPrefix: string;
    private readonly client;
    constructor(options: LambderDdbIdempotencyOptions);
    private itemKey;
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
     * Store the response for replays, overwriting the pending claim. Requires
     * still holding the claim: returns false (storing nothing) when the
     * ownerToken no longer matches, i.e. the claim expired and a retry took
     * the scope over.
     */
    complete(scopeKey: string, ownerToken: string, { statusCode, contentType, body, ttlSeconds }: {
        statusCode: number;
        contentType: string | null;
        body: string;
        ttlSeconds: number;
    }): Promise<boolean>;
    /**
     * Release the claim without storing a response (crash, uncacheable
     * response), so a retry can execute. Conditional on still holding the
     * claim; a lost claim makes this a silent no-op.
     */
    abandon(scopeKey: string, ownerToken: string): Promise<void>;
}
export default LambderDdbIdempotency;

import type { LambderIdempotencyStore, LambderIdempotencyDoneRecord, LambderIdempotencyBeginResult } from "../shared/contracts/LambderIdempotencyStore.js";
type MemoryIdempotencyRecord = {
    state: "pending";
    ownerToken: string;
} | ({
    state: "done";
    ownerToken: string;
} & LambderIdempotencyDoneRecord);
/**
 * Idempotency records held in memory: the same claim, settle and replay
 * semantics as LambderDdbIdempotencyStore (owner tokens, pending expiry, lost
 * claims as silent no-ops), over a LambderExpiringMap in place of the table
 * and its TTL. For tests and for the mock runtime; tests/store-conformance
 * drives this and the DynamoDB store through one set of rules.
 *
 * `maxBodyBytes` stands in for the DynamoDB item budget, so the "too-large"
 * path can be exercised; unbounded by default. `now` is injectable so a test
 * can expire a claim without waiting.
 *
 * `maxEntries` is the map's ceiling, 100,000 by default, and it is the one
 * way this store differs from a table: a process cannot hold records without
 * bound, so past the ceiling the SETTLED records are dropped, soonest expiry
 * first, and a retry whose record was dropped executes again instead of
 * replaying. Pending claims are never dropped for room, because losing one
 * lets two concurrent retries execute at once, which is the thing idempotency
 * exists to prevent; a claim that cannot be made room for is reported as
 * "pending" instead, so the duplicate is refused rather than run.
 */
export declare class LambderMemoryIdempotencyStore implements LambderIdempotencyStore {
    private readonly records;
    private readonly maxBodyBytes;
    private readonly now;
    private ownerCounter;
    /** Set while the store is refusing claims, so a flood reports the saturation once rather than once per request. */
    private claimCeilingReported;
    constructor(options?: {
        maxBodyBytes?: number;
        now?: () => number;
        maxEntries?: number;
    });
    private nowSeconds;
    /** A settled record as the engine reads it: a copy, so a caller writing onto what it got back cannot rewrite the record. */
    private static answerOf;
    peek(scopeKey: string): Promise<LambderIdempotencyDoneRecord | null>;
    begin(scopeKey: string, { pendingTtlSeconds }: {
        pendingTtlSeconds: number;
    }): Promise<LambderIdempotencyBeginResult>;
    complete(scopeKey: string, ownerToken: string, { statusCode, headers, body, ttlSeconds }: LambderIdempotencyDoneRecord & {
        ttlSeconds: number;
    }): Promise<"stored" | "too-large" | "lost">;
    abandon(scopeKey: string, ownerToken: string): Promise<void>;
    /**
     * The record under a scope, for assertions; null when absent or expired.
     * A copy, like every other read here, so an assertion that pokes at what
     * it got back cannot edit the stored record.
     */
    recordOf(scopeKey: string): MemoryIdempotencyRecord | null;
    /** Number of live records held. */
    get size(): number;
    /** Forgets every record. */
    reset(): void;
}
export {};

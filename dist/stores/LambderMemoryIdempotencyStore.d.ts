import type { LambderIdempotencyStore, LambderIdempotencyDoneRecord, LambderIdempotencyBeginResult } from "../shared/contracts/LambderIdempotencyStore.js";
type MemoryIdempotencyRecord = {
    state: "pending";
    ownerToken: string;
    fingerprint: string;
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
 * `maxEntries` (100,000 by default) is the one way this store differs from a
 * table: past the ceiling, SETTLED records are dropped, soonest expiry first,
 * and a retry whose record was dropped executes again instead of replaying.
 * Pending claims are never dropped, since losing one lets two concurrent
 * retries both execute; a claim that finds no room is reported as "pending"
 * instead, so the duplicate is refused rather than run.
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
    begin(scopeKey: string, { pendingTtlSeconds, fingerprint }: {
        pendingTtlSeconds: number;
        fingerprint: string;
    }): Promise<LambderIdempotencyBeginResult>;
    complete(scopeKey: string, ownerToken: string, { statusCode, headers, body, fingerprint, ttlSeconds }: LambderIdempotencyDoneRecord & {
        ttlSeconds: number;
    }): Promise<"stored" | "too-large" | "lost">;
    /** Releases a pending claim for its owner; a settled record stays, as LambderIdempotencyStore requires. */
    abandon(scopeKey: string, ownerToken: string): Promise<void>;
    /**
     * The record under a scope, for assertions; null when absent or expired.
     * A copy, like every read here, so an assertion cannot edit the stored
     * record.
     */
    recordOf(scopeKey: string): MemoryIdempotencyRecord | null;
    /** Number of live records held. */
    get size(): number;
    /** Forgets every record. */
    reset(): void;
}
export {};

import type { LambderOneShotIssueOutcome, LambderOneShotSecretDraft, LambderOneShotSecretRecord, LambderOneShotSecretStore } from "../shared/contracts/LambderOneShotSecretStore.js";
/**
 * One-shot secrets held in memory: the same one-record-per-scope, count-then-
 * compare and consume-once semantics as LambderDdbOneShotSecretStore, over a
 * LambderExpiringMap in place of the table and its TTL. For tests and for an
 * app's development runtime; lambderOneShotSecretStoreConformance drives
 * this and the DynamoDB store through one set of rules.
 *
 * Two maps, as the table holds two items per secret: the scope's current
 * record, and the scope a digest belongs to, which is how a token is found by
 * its value. `now` is injectable so a test can expire a secret without
 * waiting.
 */
export declare class LambderMemoryOneShotSecretStore implements LambderOneShotSecretStore {
    private readonly records;
    private readonly scopesByDigest;
    private idCounter;
    constructor(options?: {
        now?: () => number;
        maxEntries?: number;
    });
    /** A record as the class reads it: a copy, so a caller writing onto what it got back cannot rewrite the record. */
    private static copyOf;
    issue(draft: LambderOneShotSecretDraft, { unlessIssuedAfter }: {
        unlessIssuedAfter?: number;
    }): Promise<LambderOneShotIssueOutcome>;
    findByScope(scope: string): Promise<LambderOneShotSecretRecord | null>;
    findByDigest(digest: string): Promise<LambderOneShotSecretRecord | null>;
    attempt(scope: string, id: string): Promise<LambderOneShotSecretRecord | null>;
    consume(scope: string, id: string): Promise<boolean>;
    retire(scope: string): Promise<void>;
    /** Number of live records held. */
    get size(): number;
    /** Forgets every record. */
    reset(): void;
}

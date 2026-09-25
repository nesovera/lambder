import type { LambderSessionChanges, LambderSessionRecord, LambderSessionStore, LambderSessionUpdateResult } from "../shared/contracts/LambderSessionStore.js";
/**
 * Session records held in memory: a Map in place of the DynamoDB table. For
 * tests and for the mock runtime, where the session model (tokens, expiry,
 * sliding writes, dataRefresh) runs as it does in production over a store
 * that lives for the life of the process or page.
 *
 * Records are copied on the way in and out through JSON, the way a real store
 * serializes them, so a caller mutating a fetched record changes nothing until
 * it is written back, and data DynamoDB would reject is rejected here too.
 * Creates and updates carry the table's conditions: a create refuses an
 * existing record, and an update never brings back a deleted one. A record
 * also leaves at its own expiresAt, as the table's TTL removes it, so a
 * long-lived process does not hold every session it ever issued.
 */
export declare class LambderMemorySessionStore<SessionData = unknown> implements LambderSessionStore<SessionData> {
    /** Nothing here outlives the process. */
    readonly isMemoryOnly = true;
    private readonly records;
    /**
     * `now` is injectable so a test can move past an expiry without waiting.
     * `maxEntries` caps how many live sessions are held; at the ceiling the
     * soonest to expire is evicted, and an evicted session is a logout for
     * whoever held it.
     */
    constructor(options?: {
        now?: () => number;
        maxEntries?: number;
    });
    private static keyOf;
    /**
     * A record the way a real store hands it back: through JSON, so an
     * undefined field is gone and a cyclic value throws here exactly as on the
     * way into DynamoDB. structuredClone would do neither, and a test could
     * then pass over data the production store rejects.
     */
    private static storedCopy;
    get(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null>;
    create(record: LambderSessionRecord<SessionData>): Promise<void>;
    update(sessionKeyHash: string, secretHash: string, changes: LambderSessionChanges<SessionData>, condition?: {
        dataVersion: number;
    }): Promise<LambderSessionUpdateResult>;
    delete(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null>;
    listSecretHashes(sessionKeyHash: string): Promise<string[]>;
    /** Every live record held, for assertions. */
    list(): LambderSessionRecord<SessionData>[];
    /** Number of live records held. */
    get size(): number;
    /** Forgets every record: everyone is signed out. */
    reset(): void;
}

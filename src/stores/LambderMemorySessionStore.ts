import type { LambderSessionRecord, LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import { LambderExpiringMap } from "../shared/util/LambderExpiringMap.js";
import { joinKeyFields } from "../shared/util/LambderKeyFields.js";

/**
 * Session records held in memory: a Map in place of the DynamoDB table. For
 * tests and for the mock runtime, where the session model (tokens, expiry,
 * sliding writes, dataRefresh) runs as it does in production over a store
 * that lives for the life of the process or page.
 *
 * Records are copied on the way in and out through JSON, the way a real store
 * serializes them, so a caller mutating a fetched record changes nothing until
 * it is put back, and data DynamoDB would reject is rejected here too. A
 * record also leaves at its own expiresAt, the way the table's TTL removes
 * it, so a long-lived process does not hold every session it ever issued.
 */
export class LambderMemorySessionStore<SessionData = unknown> implements LambderSessionStore<SessionData> {
    /** Nothing here outlives the process. */
    readonly isMemoryOnly = true;

    private readonly records: LambderExpiringMap<LambderSessionRecord<SessionData>>;

    /**
     * `now` is injectable so a test can move past an expiry without waiting.
     * `maxEntries` caps how many live sessions are held; at the ceiling the
     * soonest to expire is evicted, and an evicted session is a logout for
     * whoever held it.
     */
    constructor(options: { now?: () => number; maxEntries?: number } = {}){
        this.records = new LambderExpiringMap<LambderSessionRecord<SessionData>>(options);
    }

    private static keyOf(sessionKeyHash: string, secretHash: string): string {
        // Escaped rather than joined plainly: both halves are hex today, but a
        // custom LambderSessionCrypto writes whatever it likes into them, and
        // two records sharing one key would be one session silently.
        return joinKeyFields(sessionKeyHash, secretHash);
    }

    /**
     * A record the way a real store hands it back: through JSON, so an
     * undefined field is gone and a cyclic value throws here exactly as it
     * throws on the way into DynamoDB. structuredClone did neither, which made
     * the memory store the more forgiving of the two and let a test pass over
     * data the production store would reject.
     */
    private static storedCopy<TStoredData>(record: LambderSessionRecord<TStoredData>): LambderSessionRecord<TStoredData> {
        return JSON.parse(JSON.stringify(record)) as LambderSessionRecord<TStoredData>;
    }

    async get(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null> {
        const record = this.records.get(LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash));
        return record ? LambderMemorySessionStore.storedCopy(record) : null;
    }

    async put(record: LambderSessionRecord<SessionData>): Promise<void> {
        this.records.set(
            LambderMemorySessionStore.keyOf(record.sessionKeyHash, record.secretHash),
            LambderMemorySessionStore.storedCopy(record),
            record.expiresAt,
        );
    }

    async delete(sessionKeyHash: string, secretHash: string): Promise<void> {
        this.records.delete(LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash));
    }

    async listSecretHashes(sessionKeyHash: string): Promise<string[]> {
        return this.records.values()
            .filter((record) => record.sessionKeyHash === sessionKeyHash)
            .map((record) => record.secretHash);
    }

    async markDataExpired(sessionKeyHash: string, secretHash: string, at: number): Promise<void> {
        const record = this.records.get(LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash));
        if(record) record.dataExpiresAt = at;
    }

    /** Every live record held, for assertions. */
    list(): LambderSessionRecord<SessionData>[] {
        return this.records.values().map((record) => LambderMemorySessionStore.storedCopy(record));
    }

    /** Number of live records held. */
    get size(): number { return this.records.size; }

    /** Forgets every record: everyone is signed out. */
    reset(): void {
        this.records.clear();
    }
}

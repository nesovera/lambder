import { LambderExpiringMap } from "../shared/util/LambderExpiringMap.js";
import { joinKeyFields } from "../shared/util/joinKeyFields.js";
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
export class LambderMemorySessionStore {
    /** Nothing here outlives the process. */
    isMemoryOnly = true;
    records;
    /**
     * `now` is injectable so a test can move past an expiry without waiting.
     * `maxEntries` caps how many live sessions are held; at the ceiling the
     * soonest to expire is evicted, and an evicted session is a logout for
     * whoever held it.
     */
    constructor(options = {}) {
        this.records = new LambderExpiringMap(options);
    }
    static keyOf(sessionKeyHash, secretHash) {
        // Escaped rather than joined plainly: the default crypto writes hex,
        // but a custom LambderSessionCrypto may write anything, and two
        // records sharing one key would silently be one session.
        return joinKeyFields(sessionKeyHash, secretHash);
    }
    /**
     * A record the way a real store hands it back: through JSON, so an
     * undefined field is gone and a cyclic value throws here exactly as on the
     * way into DynamoDB. structuredClone would do neither, and a test could
     * then pass over data the production store rejects.
     */
    static storedCopy(record) {
        return JSON.parse(JSON.stringify(record));
    }
    async get(sessionKeyHash, secretHash) {
        const record = this.records.get(LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash));
        return record ? LambderMemorySessionStore.storedCopy(record) : null;
    }
    async create(record) {
        const key = LambderMemorySessionStore.keyOf(record.sessionKeyHash, record.secretHash);
        if (this.records.get(key))
            throw new Error("LambderMemorySessionStore: a session already exists under these hashes.");
        this.records.set(key, LambderMemorySessionStore.storedCopy(record), record.expiresAt);
    }
    async update(sessionKeyHash, secretHash, changes, condition) {
        const key = LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash);
        const record = this.records.get(key);
        if (!record)
            return "missing";
        if (condition && record.dataVersion !== condition.dataVersion)
            return "stale";
        // A write of the data or its deadline moves the version, whatever
        // value it writes, as the DynamoDB store's ADD does.
        const writesData = "data" in changes || changes.dataExpiresAt !== undefined;
        // Through the same JSON copy a create takes, so an update carries
        // exactly what the table would hold, and the record's own expiry
        // moves with it, the way the table's TTL attribute does.
        const updated = LambderMemorySessionStore.storedCopy({ ...record, ...changes, dataVersion: record.dataVersion + (writesData ? 1 : 0) });
        this.records.set(key, updated, updated.expiresAt);
        return "updated";
    }
    async delete(sessionKeyHash, secretHash) {
        const key = LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash);
        const record = this.records.get(key);
        this.records.delete(key);
        return record ? LambderMemorySessionStore.storedCopy(record) : null;
    }
    async listSecretHashes(sessionKeyHash) {
        return this.records.values()
            .filter((record) => record.sessionKeyHash === sessionKeyHash)
            .map((record) => record.secretHash);
    }
    /** Every live record held, for assertions. */
    list() {
        return this.records.values().map((record) => LambderMemorySessionStore.storedCopy(record));
    }
    /** Number of live records held. */
    get size() { return this.records.size; }
    /** Forgets every record: everyone is signed out. */
    reset() {
        this.records.clear();
    }
}

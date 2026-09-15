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
    static storedCopy(record) {
        return JSON.parse(JSON.stringify(record));
    }
    async get(sessionKeyHash, secretHash) {
        const record = this.records.get(LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash));
        return record ? LambderMemorySessionStore.storedCopy(record) : null;
    }
    async put(record) {
        this.records.set(LambderMemorySessionStore.keyOf(record.sessionKeyHash, record.secretHash), LambderMemorySessionStore.storedCopy(record), record.expiresAt);
    }
    async delete(sessionKeyHash, secretHash) {
        this.records.delete(LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash));
    }
    async listSecretHashes(sessionKeyHash) {
        return this.records.values()
            .filter((record) => record.sessionKeyHash === sessionKeyHash)
            .map((record) => record.secretHash);
    }
    async markDataExpired(sessionKeyHash, secretHash, at) {
        const record = this.records.get(LambderMemorySessionStore.keyOf(sessionKeyHash, secretHash));
        if (record)
            record.dataExpiresAt = at;
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

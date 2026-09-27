import { LambderExpiringMap } from "../shared/util/LambderExpiringMap.js";
/**
 * How long past its expiry a record is kept, so the class can still answer
 * "expired" from it rather than "none", the way a table's lazy TTL leaves an
 * expired item in place for a while.
 */
const EXPIRED_GRACE_SECONDS = 3600;
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
export class LambderMemoryOneShotSecretStore {
    records;
    scopesByDigest;
    idCounter = 0;
    constructor(options = {}) {
        this.records = new LambderExpiringMap({ now: options.now, maxEntries: options.maxEntries });
        this.scopesByDigest = new LambderExpiringMap({ now: options.now, maxEntries: options.maxEntries });
    }
    /** A record as the class reads it: a copy, so a caller writing onto what it got back cannot rewrite the record. */
    static copyOf(record) {
        return { ...record, meta: { ...record.meta } };
    }
    async issue(draft, { unlessIssuedAfter }) {
        const current = this.records.get(draft.scope);
        if (unlessIssuedAfter !== undefined && current && current.issuedAt > unlessIssuedAfter)
            return { issued: false, refused: "cooldown", issuedAt: current.issuedAt };
        // A token's digest is its only address, so another scope's record
        // holding it keeps it; a code's carries its scope, and no other scope
        // can hold it.
        const holder = draft.shape === "token" ? this.scopesByDigest.get(draft.digest) : undefined;
        if (holder !== undefined && holder !== draft.scope && this.records.get(holder)?.digest === draft.digest)
            return { issued: false, refused: "digestTaken" };
        if (current)
            this.scopesByDigest.delete(current.digest);
        this.idCounter += 1;
        const id = `secret-${this.idCounter}`;
        const keepUntil = draft.expiresAt + EXPIRED_GRACE_SECONDS;
        const { shape: _shape, ...record } = draft;
        this.records.set(draft.scope, { ...record, id, attempts: 0, meta: { ...draft.meta } }, keepUntil);
        if (draft.shape === "token")
            this.scopesByDigest.set(draft.digest, draft.scope, keepUntil);
        return { issued: true, id };
    }
    async findByScope(scope) {
        const record = this.records.get(scope);
        return record ? LambderMemoryOneShotSecretStore.copyOf(record) : null;
    }
    async findByDigest(digest) {
        const scope = this.scopesByDigest.get(digest);
        const record = scope === undefined ? undefined : this.records.get(scope);
        // The scope may have been issued a newer secret since this digest was
        // written, in which case this digest is nobody's.
        return record && record.digest === digest ? LambderMemoryOneShotSecretStore.copyOf(record) : null;
    }
    async attempt(scope, id) {
        const record = this.records.get(scope);
        if (!record || record.id !== id)
            return null;
        record.attempts += 1;
        return LambderMemoryOneShotSecretStore.copyOf(record);
    }
    async consume(scope, id) {
        const record = this.records.get(scope);
        if (!record || record.id !== id)
            return false;
        this.records.delete(scope);
        this.scopesByDigest.delete(record.digest);
        return true;
    }
    async retire(scope) {
        const record = this.records.get(scope);
        if (!record)
            return;
        this.records.delete(scope);
        this.scopesByDigest.delete(record.digest);
    }
    /** Number of live records held. */
    get size() { return this.records.size; }
    /** Forgets every record. */
    reset() {
        this.records.clear();
        this.scopesByDigest.clear();
    }
}

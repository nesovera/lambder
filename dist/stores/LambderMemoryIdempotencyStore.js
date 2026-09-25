import { LambderExpiringMap, LambderExpiringMapFullError } from "../shared/util/LambderExpiringMap.js";
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
export class LambderMemoryIdempotencyStore {
    records;
    maxBodyBytes;
    now;
    ownerCounter = 0;
    /** Set while the store is refusing claims, so a flood reports the saturation once rather than once per request. */
    claimCeilingReported = false;
    constructor(options = {}) {
        this.maxBodyBytes = options.maxBodyBytes ?? Number.POSITIVE_INFINITY;
        this.now = options.now ?? (() => Date.now());
        this.records = new LambderExpiringMap({ now: this.now, maxEntries: options.maxEntries });
    }
    nowSeconds() { return Math.floor(this.now() / 1000); }
    /** A settled record as the engine reads it: a copy, so a caller writing onto what it got back cannot rewrite the record. */
    static answerOf(record) {
        return { statusCode: record.statusCode, headers: structuredClone(record.headers), body: record.body, fingerprint: record.fingerprint };
    }
    async peek(scopeKey) {
        const record = this.records.get(scopeKey);
        if (record?.state !== "done")
            return null;
        return LambderMemoryIdempotencyStore.answerOf(record);
    }
    async begin(scopeKey, { pendingTtlSeconds, fingerprint }) {
        const existing = this.records.get(scopeKey);
        if (existing) {
            if (existing.state === "done")
                return { state: "done", ...LambderMemoryIdempotencyStore.answerOf(existing) };
            return { state: "pending", fingerprint: existing.fingerprint };
        }
        this.ownerCounter += 1;
        const ownerToken = `owner-${this.ownerCounter}`;
        try {
            // Not evictable: the claim is all that stands between two
            // concurrent retries and two executions, and the soonest-expiry
            // rule would take it first (a claim lives minutes, a record a day).
            this.records.set(scopeKey, { state: "pending", ownerToken, fingerprint }, this.nowSeconds() + pendingTtlSeconds, { evictable: false });
        }
        catch (error) {
            if (!(error instanceof LambderExpiringMapFullError))
                throw error;
            // Every record held is a live claim, so nothing is safe to take.
            // "pending" means "the claim is not yours": the caller refuses the
            // duplicate, which cannot execute anything twice, and a retry
            // after the flood drains claims normally. It carries the caller's
            // own fingerprint, so the engine answers the in-flight 409 and the
            // client retries under the same key; any other fingerprint would
            // be the key-reused 409, which moves a client's key scope on as
            // though the operation were settled.
            if (!this.claimCeilingReported) {
                this.claimCeilingReported = true;
                console.error("LambderMemoryIdempotencyStore: every record held is a live claim, so new requests are refused as duplicates until one settles. Raise maxEntries or move to LambderDdbIdempotencyStore.");
            }
            return { state: "pending", fingerprint };
        }
        this.claimCeilingReported = false;
        return { state: "new", ownerToken };
    }
    async complete(scopeKey, ownerToken, { statusCode, headers, body, fingerprint, ttlSeconds }) {
        // Size first, ownership second, as LambderDdbIdempotencyStore must:
        // it settles with one conditional write, so whether the body fits is
        // all it can decide before going to the table.
        if (new TextEncoder().encode(body).length > this.maxBodyBytes)
            return "too-large";
        const existing = this.records.get(scopeKey);
        if (!existing || existing.ownerToken !== ownerToken)
            return "lost";
        // Settled records ARE evictable: the claim's job is done, and a record
        // the ceiling drops costs a retry its replay, not its exclusivity.
        // The key is already held, so this write cannot cross the ceiling.
        this.records.set(scopeKey, { state: "done", ownerToken, statusCode, headers: structuredClone(headers), body, fingerprint }, this.nowSeconds() + ttlSeconds);
        return "stored";
    }
    /** Releases a pending claim for its owner; a settled record stays, as LambderIdempotencyStore requires. */
    async abandon(scopeKey, ownerToken) {
        const existing = this.records.get(scopeKey);
        if (existing?.state === "pending" && existing.ownerToken === ownerToken)
            this.records.delete(scopeKey);
    }
    /**
     * The record under a scope, for assertions; null when absent or expired.
     * A copy, like every read here, so an assertion cannot edit the stored
     * record.
     */
    recordOf(scopeKey) {
        const record = this.records.get(scopeKey);
        return record ? structuredClone(record) : null;
    }
    /** Number of live records held. */
    get size() { return this.records.size; }
    /** Forgets every record. */
    reset() {
        this.records.clear();
    }
}

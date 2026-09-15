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
 * `maxEntries` is the map's ceiling, 100,000 by default, and it is the one
 * way this store differs from a table: a process cannot hold records without
 * bound, so past the ceiling the SETTLED records are dropped, soonest expiry
 * first, and a retry whose record was dropped executes again instead of
 * replaying. Pending claims are never dropped for room, because losing one
 * lets two concurrent retries execute at once, which is the thing idempotency
 * exists to prevent; a claim that cannot be made room for is reported as
 * "pending" instead, so the duplicate is refused rather than run.
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
        return { statusCode: record.statusCode, headers: structuredClone(record.headers), body: record.body };
    }
    async peek(scopeKey) {
        const record = this.records.get(scopeKey);
        if (record?.state !== "done")
            return null;
        return LambderMemoryIdempotencyStore.answerOf(record);
    }
    async begin(scopeKey, { pendingTtlSeconds }) {
        const existing = this.records.get(scopeKey);
        if (existing) {
            if (existing.state === "done")
                return { state: "done", ...LambderMemoryIdempotencyStore.answerOf(existing) };
            return { state: "pending" };
        }
        this.ownerCounter += 1;
        const ownerToken = `owner-${this.ownerCounter}`;
        try {
            // Not evictable: the claim is the only thing standing between two
            // concurrent retries and two executions, and it is also the entry
            // the soonest-expiry rule would otherwise take first, since a
            // claim lives for minutes and the record it becomes for a day.
            this.records.set(scopeKey, { state: "pending", ownerToken }, this.nowSeconds() + pendingTtlSeconds, { evictable: false });
        }
        catch (error) {
            if (!(error instanceof LambderExpiringMapFullError))
                throw error;
            // Every record held is a live claim, so there is no room and
            // nothing safe to take. "pending" is the interface's shape for
            // "the claim is not yours": the caller refuses the duplicate,
            // which is the answer that cannot execute anything twice, and a
            // retry once the flood drains claims normally.
            if (!this.claimCeilingReported) {
                this.claimCeilingReported = true;
                console.error("LambderMemoryIdempotencyStore: every record held is a live claim, so new requests are refused as duplicates until one settles. Raise maxEntries or move to LambderDdbIdempotencyStore.");
            }
            return { state: "pending" };
        }
        this.claimCeilingReported = false;
        return { state: "new", ownerToken };
    }
    async complete(scopeKey, ownerToken, { statusCode, headers, body, ttlSeconds }) {
        // Size first, ownership second, the order LambderDdbIdempotencyStore works
        // in: it settles with one conditional write, so the only thing it can
        // decide before going to the table is whether the body fits.
        if (new TextEncoder().encode(body).length > this.maxBodyBytes)
            return "too-large";
        const existing = this.records.get(scopeKey);
        if (!existing || existing.ownerToken !== ownerToken)
            return "lost";
        // Settled records ARE evictable: the claim's job is done, and a record
        // the ceiling drops costs a retry its replay, not its exclusivity.
        // The key is already held, so this write cannot cross the ceiling.
        this.records.set(scopeKey, { state: "done", ownerToken, statusCode, headers: structuredClone(headers), body }, this.nowSeconds() + ttlSeconds);
        return "stored";
    }
    async abandon(scopeKey, ownerToken) {
        const existing = this.records.get(scopeKey);
        if (existing && existing.ownerToken === ownerToken)
            this.records.delete(scopeKey);
    }
    /**
     * The record under a scope, for assertions; null when absent or expired.
     * A copy, like every other read here, so an assertion that pokes at what
     * it got back cannot edit the stored record.
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

/**
 * The idempotency vocabulary every part of Lambder shares: what a stored
 * answer looks like, what claiming a scope reports, and the four methods the
 * idempotency engine asks of a store.
 *
 * Kept apart from the engine, like LambderRateLimiter: a store implements this
 * and nothing else, and importing it from the engine would pull the engine
 * and its refusal machinery into every store's import graph. Dependency-free,
 * so the mock runtime and the browser entry can resolve it.
 */

/** A stored answer: what a completed record replays. */
export type LambderIdempotencyDoneRecord = {
    statusCode: number;
    /** Response headers stored with the record (normalized multi-value map). */
    headers: Record<string, string[]>;
    body: string;
    /**
     * The request the answer belongs to, as a digest of its payload: a key
     * reused for a different request is refused rather than handed this
     * answer. The engine's fingerprints are never empty, so a store that
     * holds a record it cannot tie to a request (one another writer left in
     * its table) reports the empty string, which matches no request and has
     * the key refused as reused.
     */
    fingerprint: string;
};

export type LambderIdempotencyBeginResult =
    | { state: "new"; ownerToken: string }
    | { state: "pending"; fingerprint: string }
    | ({ state: "done" } & LambderIdempotencyDoneRecord);

/**
 * What the idempotency engine asks of a store: one record per scope, claimed
 * atomically, settled by the claim's owner. LambderDdbIdempotencyStore and
 * LambderMemoryIdempotencyStore implement it; an app may bring its own.
 *
 * tests/store-conformance asserts the rules against every implementation.
 * Four are easy to get wrong:
 *
 * A read hands back a COPY of the record, never the stored object, because a
 * caller applies its own headers onto what it gets back.
 *
 * A write takes a copy too: the pipeline keeps writing the call's own headers
 * into the record after complete() returns, so a store that retained it
 * would let one request's Set-Cookie join the stored answer and replay to
 * everybody else. A store that serializes over the wire copies for free; one
 * that keeps the record in the process has to copy it.
 *
 * Size decides before ownership, so an answer too big to store reports
 * "too-large" even when the claim has meanwhile been lost. The engine
 * releases the claim either way and only the reported reason differs, but an
 * implementation with the order inverted would disagree with every other.
 *
 * abandon() releases a PENDING claim and nothing else: a stored record stays,
 * even when the owner that stored it asks. The engine abandons after any
 * complete() that throws, and one whose response was lost may have landed;
 * deleting what it stored would run the operation again on the retry that
 * should have replayed it.
 */
export interface LambderIdempotencyStore {
    /** The stored answer when a completed, unexpired record exists, null otherwise (absent, pending, or expired). */
    peek(scopeKey: string): Promise<LambderIdempotencyDoneRecord | null>;
    /**
     * Claims the scope: "new" with the ownerToken to settle with, "pending"
     * when another request owns it, "done" with the answer to replay. The
     * claim keeps `fingerprint`, and "pending" and "done" report the one the
     * scope holds, so the engine can tell a retry from a different request.
     * A store that refuses the claim with no record to show for it (no room
     * to hold one) reports the caller's own: the engine then answers the
     * in-flight 409, which a client retries under the same key, rather than
     * the key-reused one, which would move its key on.
     */
    begin(scopeKey: string, options: { pendingTtlSeconds: number; fingerprint: string }): Promise<LambderIdempotencyBeginResult>;
    /**
     * Stores the answer over the claim, with the fingerprint of the request
     * it answers: "stored", "too-large" (nothing written; release the claim),
     * or "lost" (the claim expired and a retry took the scope).
     */
    complete(scopeKey: string, ownerToken: string, record: LambderIdempotencyDoneRecord & { ttlSeconds: number }): Promise<"stored" | "too-large" | "lost">;
    /**
     * Releases the owner's claim while it is still pending, so a retry can
     * execute. A lost claim, or one already settled by complete(), makes
     * this a silent no-op.
     */
    abandon(scopeKey: string, ownerToken: string): Promise<void>;
}

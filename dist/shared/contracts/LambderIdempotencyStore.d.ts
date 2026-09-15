/**
 * The idempotency vocabulary every part of Lambder shares: what a stored
 * answer looks like, what claiming a scope reports, and the four methods the
 * idempotency engine asks of a store.
 *
 * Kept apart from the engine for the same reason LambderRateLimiter is:
 * a store implements this and nothing else, and importing it from the engine
 * would pull the engine (and through it the refusal machinery) into every
 * store's import graph. Pure and dependency-free, so the mock runtime and the
 * browser entry can resolve it.
 */
/** A stored answer: what a completed record replays. */
export type LambderIdempotencyDoneRecord = {
    statusCode: number;
    /** Response headers stored with the record (normalized multi-value map). */
    headers: Record<string, string[]>;
    body: string;
};
export type LambderIdempotencyBeginResult = {
    state: "new";
    ownerToken: string;
} | {
    state: "pending";
} | ({
    state: "done";
} & LambderIdempotencyDoneRecord);
/**
 * What the idempotency engine asks of a store: one record per scope, claimed
 * atomically, settled by the claim's owner. LambderDdbIdempotencyStore and
 * LambderMemoryIdempotencyStore implement it; an app may bring its own.
 *
 * The rules an implementation has to keep are the ones tests/store-conformance
 * asserts against every implementation, and the three that are easy to get
 * wrong are worth naming here.
 *
 * A read hands back a COPY of the record, never the stored object, because a
 * caller applies its own headers onto what it gets back.
 *
 * A write takes a copy too: complete() must not keep the caller's record or
 * its headers map, because that object goes on being used after the call
 * returns (the pipeline writes the call's own headers into it on the way
 * out). A store that retained it would let one request's Set-Cookie become
 * part of the stored answer and replay to everybody else. A store that goes
 * over the wire gets this for free, since serializing IS the copy; one that
 * keeps the record in the process has to make it.
 *
 * Size decides before ownership does, so an answer too big to store reports
 * "too-large" even when the claim has meanwhile been lost. The engine
 * releases the claim either way, so the order only shows in which reason it
 * is told, but an implementation that inverted it would disagree with every
 * other one.
 */
export interface LambderIdempotencyStore {
    /** The stored answer when a completed, unexpired record exists, null otherwise (absent, pending, or expired). */
    peek(scopeKey: string): Promise<LambderIdempotencyDoneRecord | null>;
    /** Claims the scope: "new" with the ownerToken to settle with, "pending" when another request owns it, "done" with the answer to replay. */
    begin(scopeKey: string, options: {
        pendingTtlSeconds: number;
    }): Promise<LambderIdempotencyBeginResult>;
    /** Stores the answer over the claim: "stored", "too-large" (nothing written; release the claim), or "lost" (the claim expired and a retry took the scope). */
    complete(scopeKey: string, ownerToken: string, record: LambderIdempotencyDoneRecord & {
        ttlSeconds: number;
    }): Promise<"stored" | "too-large" | "lost">;
    /** Releases the claim without storing; a lost claim makes this a silent no-op. */
    abandon(scopeKey: string, ownerToken: string): Promise<void>;
}

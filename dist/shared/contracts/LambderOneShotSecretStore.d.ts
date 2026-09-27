/**
 * The one-shot secret vocabulary: what a store holds of a secret, and the six
 * methods LambderOneShotSecrets asks of it. Kept apart from the class, like
 * every store interface here: a store implements this and nothing else, and
 * depends on nothing.
 *
 * A record is the digest of a secret and the facts around it, never the
 * secret itself. One record is live per scope: issuing a new one retires
 * whatever the scope held, in the same act. A record stops being live when it
 * is consumed, replaced, or retired; an expired record is still handed back,
 * because the class answers "expired" from it rather than "none", for as long
 * as the store's own housekeeping keeps it.
 *
 * Every race a one-shot secret meets is settled here, once, and the
 * conformance suite `lambder/testing` exports
 * (lambderOneShotSecretStoreConformance) asserts each, against Lambder's
 * stores and against an app's own:
 *
 * - `issue` writes the new record and retires the old in one act, and a
 *   cooldown is a condition on that same write, so of two callers asking at
 *   once exactly one is answered with a secret and the other with the moment
 *   it may ask again.
 * - `issue` claims a token's digest in that same act. A token is found by its
 *   digest alone, so two scopes that drew the same token (a short code typed
 *   by hand, with many out at once) would otherwise share one digest, and the
 *   holder of one would redeem the other's. The claim is refused while
 *   another scope's record holds the digest, and the class draws again.
 * - `attempt` counts the try in the same act that reads the digest, so tries
 *   sent together are all counted; counted afterwards, they would all read
 *   the same count and a ceiling of five would be as many as a caller cared
 *   to send at once.
 * - `consume` is conditional on the record still being the one the caller
 *   read, so of two redemptions of one secret exactly one is accepted.
 *
 * `attempt` and `consume` name a record by its scope and its id together,
 * and a record of another scope is not the one named, whatever its id.
 */
/** What a store holds of one secret: its digest and the facts around it, never the secret. */
export type LambderOneShotSecretRecord = {
    /** The store's own identity for this record, what attempt() and consume() name so a record replaced meanwhile is not the one acted on. */
    id: string;
    /** Which kind of secret, in the app's vocabulary. */
    kind: string;
    /** What the secret proves, in the app's words: an address for a purpose, a recipient, a device. */
    scope: string;
    /** The keyed digest of the secret, as the class computes it. */
    digest: string;
    /** Epoch seconds. */
    issuedAt: number;
    /** Epoch seconds; the store's TTL where it has one. */
    expiresAt: number;
    /** Tries made against the record so far. */
    attempts: number;
    /** What the app asked to have back at redemption: small strings only. */
    meta: Record<string, string>;
};
/**
 * How a secret is redeemed, which is what a store needs to know of it at
 * issue: a code with its scope (its digest carries the scope, so no other
 * scope can hold it), a token by its value alone (so its digest is claimed).
 */
export type LambderOneShotSecretShape = "code" | "token";
/** A record as the class writes it: everything but what the store assigns, and how it is redeemed. */
export type LambderOneShotSecretDraft = Omit<LambderOneShotSecretRecord, "id" | "attempts"> & {
    shape: LambderOneShotSecretShape;
};
export type LambderOneShotIssueOutcome = {
    issued: true;
    id: string;
}
/** Refused by the cooldown: the scope's record was issued after the second named, at `issuedAt`. Nothing was written. */
 | {
    issued: false;
    refused: "cooldown";
    issuedAt: number;
}
/** Refused because another scope's record holds this digest. Nothing was written; the class draws another secret. */
 | {
    issued: false;
    refused: "digestTaken";
};
export interface LambderOneShotSecretStore {
    /**
     * Stores `draft` as the scope's one live record, retiring whatever the
     * scope held, in one act. With `unlessIssuedAfter` (epoch seconds), the
     * write is refused when the scope's current record was issued after that
     * second, and the refusal carries when it was issued; of two callers
     * racing past a cooldown, exactly one is issued.
     *
     * For a token, the same act claims the digest: refused as `digestTaken`,
     * writing nothing, while a record of another scope holds it, so of two
     * scopes racing for one digest exactly one is issued. A store may be
     * stricter than that and refuse a digest no live record holds (one it
     * has not cleaned up yet, or one its history of spent secrets already
     * has, a code's included); the class draws again either way.
     */
    issue(draft: LambderOneShotSecretDraft, options: {
        unlessIssuedAfter?: number;
    }): Promise<LambderOneShotIssueOutcome>;
    /** The scope's current record, expired or not, or null once it is consumed, retired, or gone. */
    findByScope(scope: string): Promise<LambderOneShotSecretRecord | null>;
    /**
     * The current record holding this digest, or null: a digest of a record
     * that was replaced finds nothing. Asked only for a token; a store need
     * not find a code by its digest.
     */
    findByDigest(digest: string): Promise<LambderOneShotSecretRecord | null>;
    /**
     * Counts one try against the record, in the act that reads it: the
     * record with the try already counted, or null when the scope's current
     * record is no longer the one named (consumed, replaced, retired).
     *
     * Only a code is tried against its scope; a token is redeemed by value.
     * A store that holds token kinds alone is never asked, and may keep no
     * count of tries at all.
     */
    attempt(scope: string, id: string): Promise<LambderOneShotSecretRecord | null>;
    /** Ends the record named, so it is found no more; false when it is no longer the scope's current record, another consume included. */
    consume(scope: string, id: string): Promise<boolean>;
    /** Ends the scope's current record, whatever it is. */
    retire(scope: string): Promise<void>;
}

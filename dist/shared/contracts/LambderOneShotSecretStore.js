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
export {};

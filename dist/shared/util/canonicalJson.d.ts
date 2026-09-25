/**
 * JSON with object keys sorted at every level, so two values that are the
 * same data hash the same whatever order their keys were built in. Arrays
 * keep their order: a tuple's positions and an enum's values are part of the
 * data. Undefined entries are dropped, as JSON.stringify would drop them.
 *
 * What the API signature digests a schema's description with, and what the
 * idempotency engine fingerprints a request with: two hashes that must not
 * depend on the order a client or a builder happened to write keys in.
 */
export declare const canonicalJson: (value: unknown) => string;

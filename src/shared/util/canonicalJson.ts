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
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));

const sortKeys = (value: unknown): unknown => {
    if(Array.isArray(value)) return value.map(sortKeys);
    if(value === null || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    // No prototype, so a "__proto__" key (JSON.parse makes it an own key) is
    // kept as data. On a plain object the assignment would set the prototype
    // instead, and two payloads differing only under "__proto__" would share
    // one fingerprint.
    const sorted: Record<string, unknown> = Object.create(null);
    for(const key of Object.keys(source).sort()){
        if(source[key] !== undefined) sorted[key] = sortKeys(source[key]);
    }
    return sorted;
};

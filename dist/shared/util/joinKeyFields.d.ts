/**
 * Joining the fields of a tracker or scope key.
 *
 * The rate limiter and the idempotency engine each join fields with a
 * separator, and at least one field is caller data (a policy's rate-limit
 * key, a posted idempotency key). A plain join lets two field lists produce
 * one string, so two callers would share a counter or one would read
 * another's stored answer. The caller's separator is escaped, not refused: a
 * limit that rejects a legal key is a bug of its own.
 *
 * The join is one-way (a key is looked up or compared, never taken apart),
 * unlike LambderDdbCache's reversible sort-key escape, which listSortKeys
 * must decode to exactly what was written; neither stands in for the other.
 * Both engines share this one implementation so they cannot drift apart.
 */
/**
 * The fields joined into one key, each escaped, so no two distinct field
 * lists can produce the same string.
 */
export declare const joinKeyFields: (...fields: string[]) => string;

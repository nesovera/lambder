/**
 * Joining the fields of a tracker or scope key.
 *
 * Both the rate limiter and the idempotency engine build a key by joining a
 * few fields with a separator, and at least one field in each is caller data:
 * a rate-limit key returned by a policy handler, an idempotency key posted
 * with the request. A plain join lets two different field lists produce one
 * string, so two callers land on one counter or one caller reads another's
 * stored answer.
 *
 * Escaping the caller's use of the separator rather than rejecting or
 * reserving it: the caller chose the character for its own reasons, and a
 * limit that refuses a legal key is a bug of its own.
 *
 * The join is one-way. Nothing here reads a key back apart, because nothing
 * needs to: a key is looked up, counted against or compared, never taken to
 * pieces. The escaping is there so that distinct field lists cannot collide,
 * not so that the fields can be recovered.
 *
 * LambderDdbCache's sort-key encoding looks similar and is deliberately the
 * other thing: a reversible escape, because a cached entry's sort key is
 * handed back to the caller by listSortKeys and therefore has to decode to
 * exactly what was written. Two schemes, two jobs; neither should be reached
 * for in the other's place.
 *
 * Written once because the two engines had drifted, one escaping and one not.
 */

/** One field, with the separator and its own escape character escaped. */
const escapeKeyField = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

/**
 * The fields joined into one key, each escaped, so no two distinct field
 * lists can produce the same string.
 */
export const joinKeyFields = (...fields: string[]): string => fields.map(escapeKeyField).join("|");

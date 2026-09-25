/**
 * Bounding the caller-supplied field of a tracker or scope key.
 *
 * The rate-limit engine and the idempotency engine each build a store key
 * around a field only the caller controls: a custom rate-limit key or a
 * session key, a callerIdentity or a session key. A store has a key limit of
 * its own (a DynamoDB partition key stops at 2048 bytes) and refuses a key
 * past it by throwing, and both engines fail open on a store throw by
 * default: a long enough field (a 3,000-character email, a device token)
 * would turn the rate limit or the idempotency off for that caller, in
 * silence, while the table held the field in plain text. So the field is
 * bounded before any store sees it, in one implementation the two engines
 * share, so they cannot drift apart.
 */
/**
 * The field bounded: `<kind>:<value>` while the value fits, `<kind>:h:<sha256
 * hex>` once it does not. The digest keeps distinct callers on distinct
 * counters and scopes, and a value that fits stays readable in the table.
 */
export declare const boundKeyField: (kind: string, value: string) => Promise<string>;

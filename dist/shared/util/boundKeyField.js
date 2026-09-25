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
import { joinKeyFields } from "./joinKeyFields.js";
import { sha256HexOf } from "./LambderTextDigest.js";
/**
 * The ceiling, in UTF-8 bytes, on the field as it is written into the key;
 * past it, the field is replaced by its digest. Measured escaped, since
 * joinKeyFields doubles every separator and escape character: a field of
 * 1,000 separators is 2,000 bytes in the key. 1024 sits well inside every
 * store's key limit, with the store's prefix and the engine's other fields
 * (API and policy names, a posted idempotency key of at most 200 characters)
 * joined around it.
 */
const MAX_KEY_FIELD_BYTES = 1024;
/**
 * The field bounded: `<kind>:<value>` while the value fits, `<kind>:h:<sha256
 * hex>` once it does not. The digest keeps distinct callers on distinct
 * counters and scopes, and a value that fits stays readable in the table.
 */
export const boundKeyField = async (kind, value) => new TextEncoder().encode(joinKeyFields(value)).length > MAX_KEY_FIELD_BYTES
    ? `${kind}:h:${await sha256HexOf(value)}`
    : `${kind}:${value}`;

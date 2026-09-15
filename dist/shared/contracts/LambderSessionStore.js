/**
 * What a session is at rest, and what the session manager asks of the place
 * it rests in.
 *
 * The manager owns the model (token format, hashing, expiry, sliding
 * writes, dataRefresh, regeneration); a store owns nothing but the five
 * operations below, keyed by the two hashes. LambderDdbSessionStore is the
 * DynamoDB implementation and LambderMemorySessionStore the in-memory one;
 * an app may bring its own (Redis, a database) by implementing this
 * interface. Records written by one store read back through another with
 * the same shape, because the shape is the manager's, not the store's.
 */
export {};

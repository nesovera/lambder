/**
 * What a session is at rest, and what the session manager asks of the place
 * it rests in.
 *
 * The manager owns the model (token format, hashing, expiry, sliding
 * writes, dataRefresh, regeneration); a store owns only the operations
 * below, keyed by the two hashes. LambderDdbSessionStore and
 * LambderMemorySessionStore implement it, and an app may bring its own
 * (Redis, a database). The record shape is the manager's, so records written
 * by one store read back through another.
 */
export {};

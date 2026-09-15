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
/**
 * A session record. The two hashes are the record's identity: the partition
 * is a salted hash of the app's sessionKey (a user id, say) and the sort key
 * is a hash of the bearer secret the client holds. The raw secrets are never
 * stored, so a read of the store yields no usable credentials.
 */
export type LambderSessionRecord<SessionData = unknown> = {
    /** Salted sha256 of the sessionKey: the partition every session of one subject shares. */
    sessionKeyHash: string;
    /** sha256 of the sort-key secret the client's session cookie carries. */
    secretHash: string;
    /** sha256 of the raw CSRF token the client's csrf cookie carries. */
    csrfTokenHash: string;
    /** The app's own key for the subject (a user id), as given to createSession. */
    sessionKey: string;
    data: SessionData;
    /** Epoch seconds. */
    createdAt: number;
    expiresAt: number;
    lastAccessedAt: number;
    ttlInSeconds: number;
    /**
     * When `data` must be renewed via the dataRefresh callback (epoch seconds).
     * Only present when dataRefresh is configured; independent of the
     * session's own expiresAt.
     */
    dataExpiresAt?: number;
};
export interface LambderSessionStore<SessionData = unknown> {
    /**
     * Whether records live only for as long as this process does. The session
     * manager reads it to refuse a non-cryptographic LambderSessionCrypto
     * over a store that outlives the process: hashing that is not hashing is
     * survivable in memory for a development run and never survivable at
     * rest, where the records would be usable credentials.
     */
    readonly isMemoryOnly: boolean;
    /**
     * The record under the two hashes, or null. A failing read throws; the
     * manager wraps it as a LambderSessionReadError.
     *
     * A store MAY hand back a record that is past its expiresAt: a DynamoDB
     * TTL deletes within days rather than at the second, and an implementation
     * over a plain table has nothing that sweeps at all. Expiry is the
     * manager's to enforce, and it does, on every read. A store that drops
     * expired records itself is doing housekeeping, not policy.
     */
    get(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null>;
    /** Writes the record, replacing any under the same hashes. */
    put(record: LambderSessionRecord<SessionData>): Promise<void>;
    delete(sessionKeyHash: string, secretHash: string): Promise<void>;
    /** Every secretHash stored under the partition: the sessions of one subject. */
    listSecretHashes(sessionKeyHash: string): Promise<string[]>;
    /**
     * Stamps dataExpiresAt on one record, only if it still exists: neither
     * resurrects a session deleted in between nor overwrites a concurrent
     * write. A record that no longer exists is skipped silently.
     */
    markDataExpired(sessionKeyHash: string, secretHash: string, at: number): Promise<void>;
}

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
/**
 * A session record. The two hashes are the record's identity: the partition
 * is a salted hash of the app's sessionKey (a user id, say) and the sort key
 * is a hash of the bearer secret the client holds. The raw secrets are never
 * stored, so a read of the store yields no usable credentials.
 */
export type LambderSessionRecord<SessionData = unknown> = {
    /** HMAC-SHA256 of the sessionKey keyed by the salt: the partition every session of one subject shares. */
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
    /**
     * How many writes `data` and `dataExpiresAt` have had: 0 when the record
     * is created, and one more on every update that writes either of them,
     * which the store adds in the same atomic write. A conditioned update
     * names the version it read (see LambderSessionStore.update).
     */
    dataVersion: number;
};
/**
 * The fields of a stored session a write may change: the data and its
 * refresh deadline, and the sliding expiry. A session's identity, its CSRF
 * hash, its subject and its creation are fixed when it is created, and its
 * dataVersion is the store's to advance, never the caller's to set.
 */
export type LambderSessionChanges<SessionData = unknown> = Partial<Pick<LambderSessionRecord<SessionData>, "data" | "dataExpiresAt" | "lastAccessedAt" | "expiresAt">>;
/**
 * What an update found: `"updated"` when it applied, `"missing"` when the
 * record is gone (a logout, a password change, an expiry), and `"stale"`
 * when the record exists but its dataVersion is no longer the one the
 * update was conditioned on, so something else wrote its data or its
 * refresh deadline in between.
 */
export type LambderSessionUpdateResult = "updated" | "missing" | "stale";
export interface LambderSessionStore<SessionData = unknown> {
    /**
     * Whether records live only as long as this process. The session manager
     * reads it to refuse a non-cryptographic LambderSessionCrypto over a store
     * that outlives the process: fake hashing is tolerable in memory for a
     * development run, but at rest the records would be usable credentials.
     */
    readonly isMemoryOnly: boolean;
    /**
     * The record under the two hashes, or null. A failing read throws; the
     * manager wraps it as a LambderSessionReadError.
     *
     * A store MAY hand back a record past its expiresAt: a DynamoDB TTL
     * deletes within days rather than at the second, and a plain table has
     * nothing that sweeps at all. The manager enforces expiry on every read;
     * a store that drops expired records itself is doing housekeeping, not
     * policy.
     */
    get(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null>;
    /** Writes a new record, and throws when one already exists under the two hashes: a session is minted once and never overwritten. */
    create(record: LambderSessionRecord<SessionData>): Promise<void>;
    /**
     * Changes the named fields of an existing record and no others, and only
     * while it exists: an update never brings back a session deleted in
     * between, which is what keeps a logout, "log out everywhere" or a
     * password change from being undone by a write already in flight.
     *
     * An update whose changes carry `data` or `dataExpiresAt` also adds one
     * to the record's dataVersion, in the same atomic write (DynamoDB's
     * `ADD`), even when the value written equals the one stored. With
     * `condition`, the update applies only while the record's dataVersion is
     * still `condition.dataVersion`, and answers "stale" otherwise, so data
     * derived from an earlier read cannot land over a concurrent refresh,
     * data write or expireSessionDataAllByKey. The version is what makes
     * that hold: a deadline compared in whole seconds cannot show a mark
     * that wrote the value already stored, or two marks in one second.
     */
    update(sessionKeyHash: string, secretHash: string, changes: LambderSessionChanges<SessionData>, condition?: {
        dataVersion: number;
    }): Promise<LambderSessionUpdateResult>;
    /**
     * Removes the record and hands back what it held at that moment, or null
     * when there was none: rotation carries the stored record over, not the
     * one a request read earlier, and mints nothing when a logout got there
     * first.
     */
    delete(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null>;
    /** Every secretHash stored under the partition, read consistently: the sessions of one subject, including one created a moment ago. */
    listSecretHashes(sessionKeyHash: string): Promise<string[]>;
}

export type LambderSessionContext<SessionData = any> = {
    [x: string]: any;
    /**
     * sha256 of the raw CSRF token. The raw bearer secrets are never stored:
     * they exist only in the client's cookies (and, at creation, on the
     * LambderCreatedSession result), so a read of the session table yields
     * no usable credentials.
     */
    csrfTokenHash: string;
    sessionKey: string;
    data: SessionData;
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
/**
 * A freshly created (or regenerated) session: the persisted record plus the
 * RAW cookie secrets, which exist only here and in the cookies the caller
 * sets. At rest the record carries hashes of both.
 */
export type LambderCreatedSession<SessionData = any> = {
    session: LambderSessionContext<SessionData>;
    /** Raw bearer token for the session cookie (`pkHash:secret`). */
    sessionToken: string;
    /** Raw CSRF token for the client-readable csrf cookie. */
    csrfToken: string;
};
/**
 * Opt-in freshness for session.data that is derived from external state
 * (roles, permissions, feature flags...). When configured, every session read
 * checks dataExpiresAt and calls `refresh` past it, persisting the result
 * onto the same session record: same tokens, same cookies, the session
 * itself is untouched. The refresh write and the sliding-expiration write
 * share a single DynamoDB put when both are due.
 */
export type LambderSessionDataRefreshConfig<SessionData = any> = {
    /** Seconds session.data stays valid before refresh() runs on read. */
    ttlSeconds: number;
    /**
     * Rebuild session.data from its source of truth. Must be a pure
     * derivation (concurrent reads may run it in parallel; last write wins).
     * Return null to end the session: the record is deleted and the read
     * reports no session. Thrown errors fail the read as a
     * LambderSessionDataRefreshError and leave the session untouched; catch
     * inside and return session.data to explicitly serve stale instead.
     */
    refresh: (session: LambderSessionContext<SessionData>) => Promise<SessionData | null>;
};
/**
 * Wraps errors thrown by the dataRefresh callback so they stay
 * distinguishable from "no session": fetchSessionIfExists() swallows missing
 * or invalid sessions but rethrows this, otherwise a transient failure in
 * the refresh source would masquerade as a logout.
 */
export declare class LambderSessionDataRefreshError extends Error {
    constructor(cause: unknown);
}
/**
 * Wraps DynamoDB failures during a session read so they stay distinguishable
 * from "no session": fetchSessionIfExists() swallows missing or invalid
 * sessions but rethrows this. Without the distinction a transient DynamoDB
 * error would answer sessionExpired, and the caller would then clear the
 * client's session cookies: an infra blip forcing a real logout.
 */
export declare class LambderSessionReadError extends Error {
    constructor(cause: unknown);
}
export default class LambderSessionManager {
    private tableName;
    private sessionSalt;
    private partitionKey;
    private sortKey;
    private ddbDocumentClient;
    private enableSlidingExpiration;
    private slidingWriteIntervalSeconds;
    private dataRefresh;
    constructor({ tableName, tableRegion, partitionKey, sortKey, sessionSalt, enableSlidingExpiration, slidingWriteIntervalSeconds, dataRefresh, }: {
        tableName: string;
        tableRegion: string;
        partitionKey: string;
        sortKey: string;
        sessionSalt: string;
        enableSlidingExpiration?: boolean;
        slidingWriteIntervalSeconds?: number;
        dataRefresh?: LambderSessionDataRefreshConfig;
    });
    private sessionUserKeyHasher;
    /**
     * At-rest hash for the bearer secrets (session sort-key secret, CSRF
     * token). Fast unsalted sha256 is the right construction here: the
     * inputs are 256-bit random values, so there is nothing to brute-force;
     * hashing just ensures a leaked table read yields no usable cookies.
     */
    private hashToken;
    private constantTimeCompare;
    private ddbGetItem;
    private ddbPutItem;
    private ddbDeleteItem;
    private ddbQueryAllByPartitionKey;
    private ddbDeleteAllByPartitionKey;
    createSession(sessionKey: string, data?: any, ttlInSeconds?: number, options?: {
        /** Carries an existing data freshness stamp over (used by regenerateSession). */
        dataExpiresAt?: number;
    }): Promise<LambderCreatedSession>;
    updateSessionData(session: LambderSessionContext, newData?: any): Promise<LambderSessionContext>;
    getSession(sessionToken: string): Promise<LambderSessionContext | null>;
    /**
     * Runs the dataRefresh callback now, regardless of dataExpiresAt, and
     * persists the result onto the same record. Returns the updated session,
     * or null when the callback ended it (the record is deleted). Requires
     * dataRefresh to be configured.
     */
    refreshSessionData(session: LambderSessionContext): Promise<LambderSessionContext | null>;
    isSessionValid(session: any, sessionToken: any, csrfToken: any, skipCsrfTokenCheck?: boolean): boolean;
    deleteSession(session: Record<string, any>): Promise<boolean>;
    deleteSessionAll(session: Record<string, any>): Promise<boolean>;
    /**
     * Deletes every session created for the given sessionKey (e.g. a user
     * id): "log this subject out everywhere", without needing a fetched
     * session record.
     */
    deleteSessionAllByKey(sessionKey: string): Promise<boolean>;
    regenerateSession(session: LambderSessionContext): Promise<LambderCreatedSession>;
}

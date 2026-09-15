import type { LambderSessionCrypto } from "./LambderSessionCrypto.js";
import type { LambderSessionRecord, LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
/**
 * A freshly created (or regenerated) session: the persisted record plus the
 * RAW cookie secrets, which exist only here and in the cookies the caller
 * sets. At rest the record carries hashes of both.
 */
export type LambderCreatedSession<SessionData = any> = {
    session: LambderSessionRecord<SessionData>;
    /** Raw bearer token for the session cookie (`sessionKeyHash:secret`). */
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
 * share a single store write when both are due.
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
    refresh: (session: LambderSessionRecord<SessionData>) => Promise<SessionData | null>;
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
 * Wraps store failures during a session read so they stay distinguishable
 * from "no session": fetchSessionIfExists() swallows missing or invalid
 * sessions but rethrows this. Without the distinction a transient store
 * error would answer sessionExpired, and the caller would then clear the
 * client's session cookies: an infra blip forcing a real logout.
 */
export declare class LambderSessionReadError extends Error {
    constructor(cause: unknown);
}
export type LambderSessionManagerOptions<SessionData = any> = {
    /** Where sessions rest: LambderDdbSessionStore, LambderMemorySessionStore, or your own. */
    store: LambderSessionStore<SessionData>;
    /** Salts the sessionKey hash that partitions the store, so a table read does not reveal which subject a session belongs to. */
    sessionSalt: string;
    enableSlidingExpiration?: boolean;
    /** Min seconds between sliding-expiration writes. Default: max(60, 5% of TTL). */
    slidingWriteIntervalSeconds?: number;
    dataRefresh?: LambderSessionDataRefreshConfig<SessionData>;
    /** Hashing and randomness. Default: WebCrypto. */
    crypto?: LambderSessionCrypto;
};
/**
 * Whether a string has the shape a minted session token has:
 * `sessionKeyHash:secret`, both hex, neither longer than 1024 characters.
 *
 * It lives beside the code that mints and splits that format rather than
 * beside the cookie reader, so the ceiling is a property of the model and
 * anyone handing lookupSession a token they did not mint can ask the same
 * question. The session controller asks it of every candidate cookie before
 * any store read, so a malformed candidate is "no session" and never a read
 * error. Nothing a browser legitimately holds fails it, because the only
 * writer of these cookies is the code that mints them.
 */
export declare const isMintedSessionToken: (token: string) => boolean;
/**
 * The session model: how a session is minted, what its tokens look like,
 * how it is found from a presented token, when it expires, when its data is
 * renewed, and how it is rotated or ended. Storage and cryptography are
 * injected, so the same class runs on Lambda over DynamoDB, in a test over
 * a Map, and in a browser under the mock runtime.
 *
 * Token format: the session cookie carries `sessionKeyHash:secret`, where
 * the hash locates the partition and only the secret's hash is stored as
 * the sort key, so the lookup itself proves possession of the raw secret
 * and a store read yields no usable token. The CSRF token is a second
 * random value the client sends back in the request body; its hash is
 * stored too.
 */
export default class LambderSessionManager<SessionData = any> {
    private readonly store;
    private readonly sessionSalt;
    private readonly enableSlidingExpiration;
    private readonly slidingWriteIntervalSeconds;
    private readonly dataRefresh;
    private readonly crypto;
    constructor({ store, sessionSalt, enableSlidingExpiration, slidingWriteIntervalSeconds, dataRefresh, crypto, }: LambderSessionManagerOptions<SessionData>);
    /**
     * The salted partition hash of a sessionKey: sha256 of the key followed
     * by the salt, with NO separator between them.
     *
     * The missing separator is frozen by the wire guarantee, not chosen
     * again here: every live session in every deployed table was partitioned
     * under this exact string, so inserting a separator would relocate every
     * partition key at once and read to everyone signed in as being logged
     * out. What it costs is worth naming so nobody reintroduces it by
     * accident: without a separator the split between key and salt is not
     * recoverable from the string, so two deployments SHARING one table
     * collide when the difference between their salts can be absorbed into a
     * sessionKey ("ab" + "cd" and "a" + "bcd" hash alike). Two deployments
     * over one table must therefore not stand in a prefix relationship over
     * their salts. Separate tables, or salts that are independent random
     * strings, both rule it out.
     */
    private sessionKeyHashOf;
    /**
     * At-rest hash for the bearer secrets (session sort-key secret, CSRF
     * token). Fast unsalted sha256 is the right construction here: the
     * inputs are 256-bit random values, so there is nothing to brute-force;
     * hashing just ensures a leaked store read yields no usable cookies.
     */
    private hashToken;
    createSession(sessionKey: string, data?: SessionData, ttlInSeconds?: number, options?: {
        /** Carries an existing data freshness stamp over (used by regenerateSession). */
        dataExpiresAt?: number;
    }): Promise<LambderCreatedSession<SessionData>>;
    updateSessionData(session: LambderSessionRecord<SessionData>, newData: SessionData): Promise<LambderSessionRecord<SessionData>>;
    /**
     * The record a token names, read and structurally checked, with nothing
     * renewed. Split out of getSession so a caller weighing several candidate
     * cookies can decide which one is this visitor's BEFORE anything is
     * written on their behalf: renewing slides an expiry and may run the
     * app's dataRefresh callback, and a cookie a sibling host planted must
     * not get either from the victim's traffic.
     */
    lookupSession(sessionToken: string): Promise<LambderSessionRecord<SessionData> | null>;
    /**
     * The renewal half of a session read: the dataRefresh callback once its
     * shelf life has passed, and the sliding-expiration write. Returns null
     * when a refresh says the session is over (a deleted or disabled login),
     * which ends it the same way a missing record does.
     */
    renewSession(session: LambderSessionRecord<SessionData>): Promise<LambderSessionRecord<SessionData> | null>;
    /**
     * Runs the dataRefresh callback now, regardless of dataExpiresAt, and
     * persists the result onto the same record. Returns the updated session,
     * or null when the callback ended it (the record is deleted). Requires
     * dataRefresh to be configured.
     */
    refreshSessionData(session: LambderSessionRecord<SessionData>): Promise<LambderSessionRecord<SessionData> | null>;
    /**
     * Checks a record against the session token presented with it: the
     * partition hash and the bearer secret the cookie carries, plus the
     * structural checks and the expiry. This is the half a route needs, and
     * the half lookupSession has already proved for a record it just found by
     * that token's own hash, so the read path does not ask it again.
     */
    isSessionTokenValid(session: LambderSessionRecord<SessionData> | null, sessionToken: string | null): Promise<boolean>;
    /**
     * Checks a record against the CSRF token the request posted: the other
     * half, asked of an API call and not of a route. Separate methods rather
     * than one with a skip flag, because a boolean at the call site says
     * nothing about which half it turns off, and the two are asked in
     * different places for different reasons.
     */
    isSessionCsrfTokenValid(session: LambderSessionRecord<SessionData> | null, csrfToken: string | null): Promise<boolean>;
    deleteSession(session: LambderSessionRecord<SessionData>): Promise<boolean>;
    /** Deletes every session that shares the record's subject: "log this subject out everywhere". */
    deleteSessionAll(session: LambderSessionRecord<SessionData>): Promise<boolean>;
    /**
     * Deletes every session created for the given sessionKey (e.g. a user
     * id): "log this subject out everywhere", without needing a fetched
     * session record.
     */
    deleteSessionAllByKey(sessionKey: string): Promise<boolean>;
    private deleteAllUnder;
    /**
     * Marks the data of every session of the given sessionKey stale, so each
     * renews via dataRefresh on its next read: "this subject's roles or
     * permissions changed, apply it now", without logging the subject out
     * (deleteSessionAllByKey) and without waiting for the data TTL. Stamps
     * dataExpiresAt only, on records that still exist, so it neither
     * resurrects a session deleted in between nor overwrites a concurrent
     * write. Requires dataRefresh to be configured.
     */
    expireSessionDataAllByKey(sessionKey: string): Promise<boolean>;
    regenerateSession(session: LambderSessionRecord<SessionData>): Promise<LambderCreatedSession<SessionData>>;
}

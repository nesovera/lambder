import type { LambderSessionCrypto } from "./LambderSessionCrypto.js";
import type { LambderSessionRecord, LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
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
 *
 * A refresh result is written only over the data it was computed from: if
 * the record's dataVersion moved in between (another request refreshed or
 * wrote the data, or expireSessionDataAllByKey marked it stale), the result
 * still serves this request but the newer write stands, and a marked record
 * renews again on its next read.
 */
export type LambderSessionDataRefreshConfig<SessionData = any> = {
    /** Seconds session.data stays valid before refresh() runs on read. */
    ttlSeconds: number;
    /**
     * Rebuild session.data from its source of truth. Must be a pure
     * derivation (concurrent reads may run it in parallel; the first result
     * written stands, since each is written only over the data it read).
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
    /** The HMAC key that turns a sessionKey into the store's partition key, so a table read does not reveal which subject a session belongs to. */
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
 * It lives beside the code that mints and splits the format, not the cookie
 * reader, so the ceiling belongs to the model and anyone handing
 * lookupSession a token they did not mint can ask it too. The session
 * controller checks every candidate cookie with it before any store read, so
 * a malformed one is "no session", never a read error. No legitimate cookie
 * fails it, since only the minting code writes them.
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
    /** Replaceable through the backend swap alone; see LAMBDER_BACKEND_SWAP. */
    private store;
    private readonly sessionSalt;
    private readonly enableSlidingExpiration;
    private readonly slidingWriteIntervalSeconds;
    private readonly dataRefresh;
    private readonly crypto;
    constructor({ store, sessionSalt, enableSlidingExpiration, slidingWriteIntervalSeconds, dataRefresh, crypto, }: LambderSessionManagerOptions<SessionData>);
    /** A store this manager's crypto may sit in front of. Asked of every store it is given, the one at creation and a swapped one alike. */
    private assertCryptoFitsStore;
    /**
     * Puts the manager over another store, for `lambder/testing`. The model
     * (salt, tokens, expiry, dataRefresh) stays this manager's own, so a test
     * runs the app's sessions as configured over a store that dies with the
     * process. Sessions held by the store it leaves are simply out of reach.
     */
    [LAMBDER_BACKEND_SWAP](store: LambderSessionStore<SessionData>): void;
    /**
     * The salted partition hash of a sessionKey: HMAC-SHA256 with the salt
     * as the key and the sessionKey as the message.
     *
     * Keyed rather than hashed over the two run together, because a plain
     * concatenation cannot tell where the sessionKey ends and the salt
     * begins: "ab" + "cd" and "a" + "bcd" would hash alike, so two
     * deployments sharing one table could collide whenever the difference
     * between their salts fits into a sessionKey. With the salt as the HMAC
     * key the two inputs never meet in one string, so no choice of salts
     * lets one deployment's subject land in another's partition.
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
        /** The data refresh deadline to start with (regenerateSession starts its data due). */
        dataExpiresAt?: number;
    }): Promise<LambderCreatedSession<SessionData>>;
    /**
     * Writes new session data onto the record, and nothing else: the expiry
     * slides only in renewSession, which also re-issues the cookies, so a
     * data write never moves the record's expiry away from the browser's.
     * Returns the updated record, or null when the session was ended in
     * between (the write does not bring it back).
     *
     * With dataRefresh, the write leaves dataExpiresAt where it is: only the
     * dataRefresh callback's output is stamped fresh. The data an app writes
     * is almost always the session's own with a field changed, still carrying
     * whatever the callback derived last, so a write that pushed the deadline
     * would let an app writing more often than ttlSeconds never refresh at
     * all, and would cancel the due start regenerateSession gives a rotated
     * session. The write is still conditioned on the dataVersion this record
     * was read with. If that moved in between (expireSessionDataAllByKey
     * marked the data stale, or another request refreshed it, possibly
     * applying a revocation already), the data is written and marked due, so
     * a revocation that landed during this request is not undone by data
     * derived before it.
     *
     * The returned record carries the dataVersion this write produced only
     * when a conditioned write applied, which is then exactly one past the
     * version it named. Otherwise it keeps the version it was read with,
     * which the store has already passed, so a later conditioned write from
     * the same request answers "stale" and lands marked due: the safe side.
     */
    updateSessionData(session: LambderSessionRecord<SessionData>, newData: SessionData): Promise<LambderSessionRecord<SessionData> | null>;
    /**
     * The record a token names, read and structurally checked, with nothing
     * renewed. Kept apart from renewSession so a caller weighing several
     * candidate cookies can decide which is this visitor's BEFORE anything is
     * written on their behalf: renewing slides an expiry and may run the
     * app's dataRefresh callback, and a cookie a sibling host planted must
     * get neither from the victim's traffic.
     */
    lookupSession(sessionToken: string): Promise<LambderSessionRecord<SessionData> | null>;
    /**
     * The renewal half of a session read: the dataRefresh callback once its
     * shelf life has passed, and the sliding-expiration write. Returns null
     * when the session is over: a refresh said so (a deleted or disabled
     * login), or the record was deleted while this request read it (a
     * logout, a password change), which a renewal must not undo.
     */
    renewSession(session: LambderSessionRecord<SessionData>): Promise<LambderSessionRecord<SessionData> | null>;
    /**
     * Runs the dataRefresh callback immediately, regardless of
     * dataExpiresAt, and persists the result onto the same record, over the
     * data it was computed from only (see LambderSessionDataRefreshConfig).
     * Returns the refreshed session, or null when the callback ended it (the
     * record is deleted) or the session is gone. The expiry does not slide
     * here; renewSession slides it. Requires dataRefresh to be configured.
     */
    refreshSessionData(session: LambderSessionRecord<SessionData>): Promise<LambderSessionRecord<SessionData> | null>;
    /**
     * Checks a record against the session token presented with it: the
     * partition hash and the bearer secret the cookie carries, plus the
     * structural checks and the expiry. This is the half a route needs; a
     * record lookupSession just found by that token's own hash has already
     * passed it, so the read path does not ask again.
     */
    isSessionTokenValid(session: LambderSessionRecord<SessionData> | null, sessionToken: string | null): Promise<boolean>;
    /**
     * Checks a record against the CSRF token the request posted: the other
     * half, asked of an API call and not of a route. Separate methods rather
     * than one with a skip flag, because a boolean at the call site does not
     * say which half it turns off.
     */
    isSessionCsrfTokenValid(session: LambderSessionRecord<SessionData> | null, csrfToken: string | null): Promise<boolean>;
    /** Deletes the session; false when there was none left to delete. */
    deleteSession(session: LambderSessionRecord<SessionData>): Promise<boolean>;
    /**
     * Deletes every session that shares the record's subject: "log this
     * subject out everywhere". False when a rotation racing it may have left
     * a session behind (see deleteAllUnder).
     */
    deleteSessionAll(session: LambderSessionRecord<SessionData>): Promise<boolean>;
    /**
     * Deletes every session created for the given sessionKey (e.g. a user
     * id): "log this subject out everywhere", without needing a fetched
     * session record. False when a rotation racing it may have left a
     * session behind (see deleteAllUnder).
     */
    deleteSessionAllByKey(sessionKey: string): Promise<boolean>;
    /**
     * Deletes every session of a subject, and answers whether it is sure
     * none is left. A pass that finds a record it listed already gone lists
     * again: a rotation writes its new record before deleting the old one
     * (see regenerateSession), so the old one vanishing between this listing
     * and this delete means a new record may have appeared after the
     * listing. When the last pass the bound allows still finds one gone,
     * such a record may be standing, so the call is logged and answers
     * false: a caller ending a subject's sessions after a password change
     * can run it again.
     */
    private deleteAllUnder;
    /**
     * One write per session of a subject, a bounded number at a time: a
     * subject with hundreds of sessions is not hundreds of round trips in a
     * row, and not hundreds at once either.
     */
    private forEachSessionOf;
    /**
     * Marks the data of every session of the given sessionKey stale, so each
     * renews via dataRefresh on its next read: "this subject's roles or
     * permissions changed, apply that right away", without logging them out
     * (deleteSessionAllByKey) and without waiting for the data TTL. Writes
     * dataExpiresAt only, on records that still exist, so it neither
     * resurrects a session deleted in between nor overwrites a concurrent
     * write. The write moves each record's dataVersion, even when the
     * deadline already reads this second, so a refresh or data write in
     * flight, conditioned on the version it read, answers "stale" rather
     * than landing data derived before the change. Requires dataRefresh to
     * be configured.
     */
    expireSessionDataAllByKey(sessionKey: string): Promise<boolean>;
    /**
     * Replaces the session with a new one under new tokens, carrying over
     * the data as the delete removed it rather than as this request read
     * it, so data another request wrote meanwhile stays. Returns null, and
     * leaves no new session behind, when the record was already gone or
     * over: a logout, "log out everywhere" or a password change that landed
     * during this request stays in force.
     *
     * The new record is written before the old one is deleted. The other
     * way round, a subject-wide delete that listed the subject's sessions
     * between the two would find neither, and the new session would outlive
     * the password change it was racing. Written first, the new record is in
     * that listing, or the old one still is: then either the subject-wide
     * delete removes the old one before this delete does, and this delete
     * takes the new one back out, or this delete removes it first, and the
     * subject-wide delete, finding it gone, lists again (deleteAllUnder).
     *
     * With dataRefresh, the new session's data is due at once: a revocation
     * marked by expireSessionDataAllByKey while the new record was being
     * written may have passed it by, and due, its next read renews the data
     * from the source of truth either way.
     */
    regenerateSession(session: LambderSessionRecord<SessionData>): Promise<LambderCreatedSession<SessionData> | null>;
}

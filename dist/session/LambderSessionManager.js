import { LambderWebCrypto } from "./LambderSessionCrypto.js";
import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
/**
 * Wraps errors thrown by the dataRefresh callback so they stay
 * distinguishable from "no session": fetchSessionIfExists() swallows missing
 * or invalid sessions but rethrows this, otherwise a transient failure in
 * the refresh source would masquerade as a logout.
 */
export class LambderSessionDataRefreshError extends Error {
    constructor(cause) {
        super(`Session dataRefresh failed: ${coerceToError(cause).message}`, { cause });
        this.name = "LambderSessionDataRefreshError";
    }
}
/**
 * Wraps store failures during a session read so they stay distinguishable
 * from "no session": fetchSessionIfExists() swallows missing or invalid
 * sessions but rethrows this. Without the distinction a transient store
 * error would answer sessionExpired, and the caller would then clear the
 * client's session cookies: an infra blip forcing a real logout.
 */
export class LambderSessionReadError extends Error {
    constructor(cause) {
        super(`Session read failed: ${coerceToError(cause).message}`, { cause });
        this.name = "LambderSessionReadError";
    }
}
/**
 * The longest either half of a session token may be. A minted token is two
 * 64-character hex halves, so this is sixteen times the room the default
 * crypto needs, which leaves a custom LambderSessionCrypto free to mint
 * longer hashes or secrets without this file knowing its lengths, and leaves
 * LambderPlainSessionCrypto, which hex-encodes its input rather than hashing
 * it, room for a session key and salt of several hundred characters.
 * Deriving the exact length from the crypto instead would tie the check to
 * whichever crypto is configured today and reject every session minted by
 * the previous one, and LambderSessionCrypto exposes no length to read.
 *
 * The number that matters is the one this is comfortably under: DynamoDB
 * refuses a partition key over 2048 bytes, and a cookie may carry 4000, so
 * without a bound a planted oversized cookie reaches the store as a key it
 * cannot take, the read throws, and a live session beside it answers 500 on
 * every request.
 */
const MAX_SESSION_TOKEN_HALF_CHARS = 1024;
/** Hex in either case: what every LambderSessionCrypto's sha256Hex and randomHex produce, whichever case a custom one picks. */
const SESSION_TOKEN_HALF_PATTERN = /^[0-9a-fA-F]+$/;
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
export const isMintedSessionToken = (token) => {
    const halves = token.split(":");
    if (halves.length !== 2)
        return false;
    return halves.every((half) => half.length > 0 && half.length <= MAX_SESSION_TOKEN_HALF_CHARS && SESSION_TOKEN_HALF_PATTERN.test(half));
};
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
export default class LambderSessionManager {
    store;
    sessionSalt;
    enableSlidingExpiration;
    slidingWriteIntervalSeconds;
    dataRefresh;
    crypto;
    constructor({ store, sessionSalt, enableSlidingExpiration = true, slidingWriteIntervalSeconds, dataRefresh, crypto, }) {
        this.store = store;
        this.sessionSalt = sessionSalt;
        this.enableSlidingExpiration = enableSlidingExpiration;
        this.slidingWriteIntervalSeconds = slidingWriteIntervalSeconds === undefined
            ? null
            : assertPositiveInteger(slidingWriteIntervalSeconds, "session.slidingWriteIntervalSeconds");
        if (dataRefresh)
            assertPositiveInteger(dataRefresh.ttlSeconds, "session.dataRefresh.ttlSeconds");
        this.dataRefresh = dataRefresh ?? null;
        this.crypto = crypto ?? new LambderWebCrypto();
        if (!this.crypto.isCryptographic && !store.isMemoryOnly) {
            throw new Error("Lambder: this session crypto does not hash and does not draw cryptographically random bytes, " +
                "so it may only sit in front of a store that dies with the process. Over a persistent store every " +
                "record would be a usable credential and the sessionSalt would be readable from it.");
        }
        if (typeof sessionSalt !== "string" || sessionSalt.length === 0) {
            throw new Error("Lambder: session sessionSalt is empty. It salts the hash that partitions the store, so it has to be a real, stable secret.");
        }
    }
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
    sessionKeyHashOf(sessionKey) {
        return this.crypto.sha256Hex(`${sessionKey}${this.sessionSalt}`);
    }
    /**
     * At-rest hash for the bearer secrets (session sort-key secret, CSRF
     * token). Fast unsalted sha256 is the right construction here: the
     * inputs are 256-bit random values, so there is nothing to brute-force;
     * hashing just ensures a leaked store read yields no usable cookies.
     */
    hashToken(value) {
        return this.crypto.sha256Hex(value);
    }
    async createSession(sessionKey, data = {}, ttlInSeconds = 30 * 24 * 60 * 60, options) {
        // Checked rather than trusted: the TTL becomes the record's expiresAt
        // and the store's own expiry attribute, so a NaN or a fraction from an
        // unparsed environment variable would write a record nothing ever
        // retires and no read ever accepts.
        assertPositiveInteger(ttlInSeconds, "createSession ttlInSeconds");
        // Refused for the same reason as a NaN TTL: an empty sessionKey
        // writes a record that lookupSession rejects on every read (a session
        // has to name its subject), so the caller would be handed a
        // valid-looking cookie pair for a session nobody can ever sign in
        // with, and every request after it would read as a silent logout.
        if (!sessionKey)
            throw new Error("Lambder: createSession sessionKey is empty. It names the subject the session belongs to and partitions the store, so an empty one writes a record no read accepts.");
        const sessionKeyHash = await this.sessionKeyHashOf(sessionKey);
        // The sort-key SECRET goes to the client; only its hash becomes the
        // store's range key, so the store never contains a usable token.
        const secret = await this.crypto.randomHex(32);
        const sessionToken = `${sessionKeyHash}:${secret}`;
        const csrfToken = await this.crypto.randomHex(32);
        const createdAt = Math.floor(Date.now() / 1000);
        const lastAccessedAt = createdAt;
        const expiresAt = Number(createdAt) + Number(ttlInSeconds);
        const session = {
            sessionKeyHash,
            secretHash: await this.hashToken(secret),
            csrfTokenHash: await this.hashToken(csrfToken),
            sessionKey, data,
            createdAt, lastAccessedAt, expiresAt, ttlInSeconds,
            ...(this.dataRefresh ? { dataExpiresAt: options?.dataExpiresAt ?? (createdAt + this.dataRefresh.ttlSeconds) } : {}),
        };
        await this.store.put(session);
        return { session, sessionToken, csrfToken };
    }
    async updateSessionData(session, newData) {
        if (!session)
            throw new Error("Invalid session");
        session.data = newData;
        session.lastAccessedAt = Math.floor(Date.now() / 1000);
        // Explicitly written data is fresh by definition.
        if (this.dataRefresh) {
            session.dataExpiresAt = session.lastAccessedAt + this.dataRefresh.ttlSeconds;
        }
        // Update expiration if sliding expiration is enabled
        if (this.enableSlidingExpiration) {
            session.expiresAt = session.lastAccessedAt + session.ttlInSeconds;
        }
        await this.store.put(session);
        return session;
    }
    /**
     * The record a token names, read and structurally checked, with nothing
     * renewed. Split out of getSession so a caller weighing several candidate
     * cookies can decide which one is this visitor's BEFORE anything is
     * written on their behalf: renewing slides an expiry and may run the
     * app's dataRefresh callback, and a cookie a sibling host planted must
     * not get either from the victim's traffic.
     */
    async lookupSession(sessionToken) {
        const [sessionKeyHash, secret] = sessionToken.split(":");
        if (!sessionKeyHash || !secret)
            return null;
        const secretHash = await this.hashToken(secret);
        // A store read failure propagates typed: null means "no such
        // session", which callers translate to sessionExpired, and the caller
        // then clears the client's session cookies. A transient infra error
        // must surface as a 500, not force a logout.
        let session;
        try {
            // The lookup itself proves possession of the raw secret: the
            // range key is its hash, so only the true secret finds the item.
            session = await this.store.get(sessionKeyHash, secretHash);
        }
        catch (err) {
            throw new LambderSessionReadError(err);
        }
        if (!session)
            return null;
        // The record has to be the one that was asked for. A correct store
        // answers with the item under the two keys it was given, and this is
        // what a store that does not (a cache keyed loosely, a query that
        // forgot its partition) runs into instead of handing back somebody
        // else's session. The hashes are already in hand, so it costs a
        // comparison and no hashing.
        if (!this.crypto.constantTimeEqual(session.sessionKeyHash ?? "", sessionKeyHash))
            return null;
        if (!this.crypto.constantTimeEqual(session.secretHash ?? "", secretHash))
            return null;
        if (!session.csrfTokenHash)
            return null;
        if (!session.sessionKey)
            return null;
        if (!session.createdAt)
            return null;
        // Expiry is enforced here, on every read, because the store contract
        // allows a record past its expiresAt: a DynamoDB TTL deletes within
        // days rather than at the second, and a store over a plain table
        // sweeps nothing at all.
        if (!session.expiresAt || session.expiresAt < Date.now() / 1000)
            return null;
        return session;
    }
    ;
    /**
     * The renewal half of a session read: the dataRefresh callback once its
     * shelf life has passed, and the sliding-expiration write. Returns null
     * when a refresh says the session is over (a deleted or disabled login),
     * which ends it the same way a missing record does.
     */
    async renewSession(session) {
        const now = Math.floor(Date.now() / 1000);
        let needsWrite = false;
        // Renew session.data once its shelf life has passed (opt-in
        // dataRefresh). Records from before the feature was enabled have no
        // dataExpiresAt, so they renew on first read.
        if (this.dataRefresh && (session.dataExpiresAt ?? 0) <= now) {
            let newData;
            try {
                newData = await this.dataRefresh.refresh(session);
            }
            catch (err) {
                // A failing refresh must fail this read, not masquerade as a
                // missing session or silently serve stale data.
                throw new LambderSessionDataRefreshError(err);
            }
            if (newData === null) {
                await this.deleteSession(session);
                return null;
            }
            session.data = newData;
            session.dataExpiresAt = now + this.dataRefresh.ttlSeconds;
            needsWrite = true;
        }
        // Update last accessed time if sliding expiration is enabled.
        // Throttled: skip the store write when the session was refreshed
        // recently, to avoid a write on every request. A due data renewal
        // above forces the write anyway, so both updates share one put.
        if (this.enableSlidingExpiration) {
            const minInterval = this.slidingWriteIntervalSeconds
                ?? Math.max(60, Math.floor((session.ttlInSeconds || 0) * 0.05));
            if (needsWrite || now - (session.lastAccessedAt || 0) >= minInterval) {
                session.lastAccessedAt = now;
                session.expiresAt = now + session.ttlInSeconds;
                needsWrite = true;
            }
        }
        if (needsWrite) {
            // Wait for the update to ensure it persists before Lambda freezes.
            // A failed put is not fatal: the data served is fresh, and an
            // unpersisted renewal simply runs again on the next read. It is
            // still logged, because a store that fails every renewal write
            // means sliding expiration has quietly stopped working and every
            // session now ends at its creation TTL, which otherwise shows up
            // only as users being signed out sooner than the app promises.
            // The reason only, never the record or the token: a log line is
            // not the place for anything that identifies a session.
            await this.store.put(session).catch((err) => {
                console.error(`Lambder session: the renewal write failed, so this session keeps its stored expiry. ${coerceToError(err).message}`);
            });
        }
        return session;
    }
    ;
    /**
     * Runs the dataRefresh callback now, regardless of dataExpiresAt, and
     * persists the result onto the same record. Returns the updated session,
     * or null when the callback ended it (the record is deleted). Requires
     * dataRefresh to be configured.
     */
    async refreshSessionData(session) {
        if (!this.dataRefresh)
            throw new Error("dataRefresh is not configured. Pass session.dataRefresh at creation to enable.");
        if (!session)
            throw new Error("Invalid session");
        let newData;
        try {
            newData = await this.dataRefresh.refresh(session);
        }
        catch (err) {
            throw new LambderSessionDataRefreshError(err);
        }
        if (newData === null) {
            await this.deleteSession(session);
            return null;
        }
        const now = Math.floor(Date.now() / 1000);
        session.data = newData;
        session.dataExpiresAt = now + this.dataRefresh.ttlSeconds;
        session.lastAccessedAt = now;
        if (this.enableSlidingExpiration) {
            session.expiresAt = now + session.ttlInSeconds;
        }
        await this.store.put(session);
        return session;
    }
    ;
    /**
     * Checks a record against the session token presented with it: the
     * partition hash and the bearer secret the cookie carries, plus the
     * structural checks and the expiry. This is the half a route needs, and
     * the half lookupSession has already proved for a record it just found by
     * that token's own hash, so the read path does not ask it again.
     */
    async isSessionTokenValid(session, sessionToken) {
        if (!session)
            return false;
        if (!sessionToken)
            return false;
        // Presented raw secrets are checked against the stored hashes.
        const [sessionKeyHash, secret] = sessionToken.split(":");
        if (!sessionKeyHash || !secret)
            return false;
        if (!this.crypto.constantTimeEqual(session.sessionKeyHash, sessionKeyHash))
            return false;
        if (!this.crypto.constantTimeEqual(session.secretHash, await this.hashToken(secret)))
            return false;
        if (!session.csrfTokenHash)
            return false;
        if (!session.sessionKey)
            return false;
        if (!session.createdAt)
            return false;
        if (!session.expiresAt || session.expiresAt < Date.now() / 1000)
            return false;
        return true;
    }
    /**
     * Checks a record against the CSRF token the request posted: the other
     * half, asked of an API call and not of a route. Separate methods rather
     * than one with a skip flag, because a boolean at the call site says
     * nothing about which half it turns off, and the two are asked in
     * different places for different reasons.
     */
    async isSessionCsrfTokenValid(session, csrfToken) {
        if (!session?.csrfTokenHash)
            return false;
        if (!csrfToken)
            return false;
        return this.crypto.constantTimeEqual(session.csrfTokenHash, await this.hashToken(csrfToken));
    }
    async deleteSession(session) {
        await this.store.delete(session.sessionKeyHash, session.secretHash);
        return true;
    }
    ;
    /** Deletes every session that shares the record's subject: "log this subject out everywhere". */
    async deleteSessionAll(session) {
        await this.deleteAllUnder(session.sessionKeyHash);
        return true;
    }
    ;
    /**
     * Deletes every session created for the given sessionKey (e.g. a user
     * id): "log this subject out everywhere", without needing a fetched
     * session record.
     */
    async deleteSessionAllByKey(sessionKey) {
        await this.deleteAllUnder(await this.sessionKeyHashOf(sessionKey));
        return true;
    }
    ;
    async deleteAllUnder(sessionKeyHash) {
        for (const secretHash of await this.store.listSecretHashes(sessionKeyHash)) {
            await this.store.delete(sessionKeyHash, secretHash);
        }
    }
    /**
     * Marks the data of every session of the given sessionKey stale, so each
     * renews via dataRefresh on its next read: "this subject's roles or
     * permissions changed, apply it now", without logging the subject out
     * (deleteSessionAllByKey) and without waiting for the data TTL. Stamps
     * dataExpiresAt only, on records that still exist, so it neither
     * resurrects a session deleted in between nor overwrites a concurrent
     * write. Requires dataRefresh to be configured.
     */
    async expireSessionDataAllByKey(sessionKey) {
        if (!this.dataRefresh)
            throw new Error("dataRefresh is not configured. Pass session.dataRefresh at creation to enable.");
        const sessionKeyHash = await this.sessionKeyHashOf(sessionKey);
        const now = Math.floor(Date.now() / 1000);
        for (const secretHash of await this.store.listSecretHashes(sessionKeyHash)) {
            await this.store.markDataExpired(sessionKeyHash, secretHash, now);
        }
        return true;
    }
    ;
    async regenerateSession(session) {
        if (!session)
            throw new Error("Invalid session");
        // Delete old session
        await this.deleteSession(session);
        // Create new session with same sessionKey and data but new tokens.
        // The data freshness stamp carries over: rotating tokens must not
        // extend how long dataRefresh-managed data may stay unrenewed.
        return await this.createSession(session.sessionKey, session.data, session.ttlInSeconds, session.dataExpiresAt !== undefined ? { dataExpiresAt: session.dataExpiresAt } : undefined);
    }
}
;

import { LambderWebCrypto } from "./LambderSessionCrypto.js";
import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { canonicalJson } from "../shared/util/canonicalJson.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
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
 * 64-character hex halves; sixteen times that leaves a custom
 * LambderSessionCrypto free to mint longer hashes or secrets, and leaves
 * LambderPlainSessionCrypto (which hex-encodes rather than hashes) room for a
 * session key and salt of several hundred characters. The bound is not
 * derived from the crypto: LambderSessionCrypto exposes no length, and tying
 * it to the configured crypto would reject every session a previously
 * configured one minted.
 *
 * What matters is staying under DynamoDB's 2048-byte partition key limit. A
 * cookie may carry 4000, so without a bound a planted oversized cookie
 * reaches the store as a key it cannot take, the read throws, and a live
 * session beside it answers 500 on every request.
 */
const MAX_SESSION_TOKEN_HALF_CHARS = 1024;
/** How many store writes one "every session of a subject" operation runs at once. */
const SUBJECT_WRITE_CONCURRENCY = 16;
/**
 * How many times deleting every session of a subject lists them in all,
 * when each pass finds a listed record already gone (see deleteAllUnder).
 * Each further pass needs a rotation to complete inside the previous pass's
 * gap between listing and deleting; the bound keeps a client rotating in a
 * tight loop from holding the call open, and a call that reaches it answers
 * false.
 */
const SUBJECT_DELETE_MAX_PASSES = 4;
/** Hex in either case: what every LambderSessionCrypto's hmacSha256Hex (the first half) and randomHex (the second) produce, whichever case a custom one picks. */
const SESSION_TOKEN_HALF_PATTERN = /^[0-9a-fA-F]+$/;
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
    /** Replaceable through the backend swap alone; see LAMBDER_BACKEND_SWAP. */
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
        this.assertCryptoFitsStore(store);
        if (typeof sessionSalt !== "string" || sessionSalt.length === 0) {
            throw new Error("Lambder: session sessionSalt is empty. It keys the hash that partitions the store, so it has to be a real, stable secret.");
        }
    }
    /** A store this manager's crypto may sit in front of. Asked of every store it is given, the one at creation and a swapped one alike. */
    assertCryptoFitsStore(store) {
        if (!this.crypto.isCryptographic && !store.isMemoryOnly) {
            throw new Error("Lambder: this session crypto does not hash and does not draw cryptographically random bytes, " +
                "so it may only sit in front of a store that dies with the process. Over a persistent store every " +
                "record would be a usable credential and the sessionSalt would be readable from it.");
        }
    }
    /**
     * Puts the manager over another store, for `lambder/testing`. The model
     * (salt, tokens, expiry, dataRefresh) stays this manager's own, so a test
     * runs the app's sessions as configured over a store that dies with the
     * process. Sessions held by the store it leaves are simply out of reach.
     */
    [LAMBDER_BACKEND_SWAP](store) {
        this.assertCryptoFitsStore(store);
        this.store = store;
    }
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
    sessionKeyHashOf(sessionKey) {
        return this.crypto.hmacSha256Hex(this.sessionSalt, sessionKey);
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
        // Refused like a NaN TTL: lookupSession rejects a record with no
        // sessionKey on every read (a session has to name its subject), so
        // the caller would get a valid-looking cookie pair for a session
        // nobody can use, and every later request would read as a silent
        // logout.
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
            dataVersion: 0,
        };
        await this.store.create(session);
        return { session, sessionToken, csrfToken };
    }
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
    async updateSessionData(session, newData) {
        if (!session)
            throw new Error("Invalid session");
        const { sessionKeyHash, secretHash } = session;
        if (!this.dataRefresh) {
            const result = await this.store.update(sessionKeyHash, secretHash, { data: newData });
            return result === "missing" ? null : { ...session, data: newData };
        }
        const result = await this.store.update(sessionKeyHash, secretHash, { data: newData }, { dataVersion: session.dataVersion });
        if (result === "updated")
            return { ...session, data: newData, dataVersion: session.dataVersion + 1 };
        if (result === "missing")
            return null;
        // The data or its deadline was written in between: a revocation was
        // marked, or another request refreshed the data, possibly applying
        // that revocation already. The app's data lands, and is marked due,
        // so the next read runs it through dataRefresh again rather than
        // serving what this request derived before the change.
        const now = Math.floor(Date.now() / 1000);
        if (await this.store.update(sessionKeyHash, secretHash, { data: newData, dataExpiresAt: now }) === "missing")
            return null;
        return { ...session, data: newData, dataExpiresAt: now };
    }
    /**
     * The record a token names, read and structurally checked, with nothing
     * renewed. Kept apart from renewSession so a caller weighing several
     * candidate cookies can decide which is this visitor's BEFORE anything is
     * written on their behalf: renewing slides an expiry and may run the
     * app's dataRefresh callback, and a cookie a sibling host planted must
     * get neither from the victim's traffic.
     */
    async lookupSession(sessionToken) {
        const [sessionKeyHash, secret] = sessionToken.split(":");
        if (!sessionKeyHash || !secret)
            return null;
        const secretHash = await this.hashToken(secret);
        // A store read failure propagates typed: null means "no such
        // session", which callers answer as sessionExpired, clearing the
        // client's session cookies. A transient infra error must surface as a
        // 500, not force a logout.
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
        // The record has to be the one asked for. A correct store answers
        // with the item under the two keys it was given; a store that does
        // not (a loosely keyed cache, a query missing its partition) stops
        // here instead of handing back somebody else's session. The hashes
        // are in hand, so this costs a comparison and no hashing.
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
        // Every conditioned write names it and renewal adds to it, so a store
        // that dropped it would turn each into a NaN version no write matches.
        if (typeof session.dataVersion !== "number")
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
     * when the session is over: a refresh said so (a deleted or disabled
     * login), or the record was deleted while this request read it (a
     * logout, a password change), which a renewal must not undo.
     */
    async renewSession(session) {
        const now = Math.floor(Date.now() / 1000);
        const refreshed = {};
        const slid = {};
        // Renew session.data once its shelf life has passed (opt-in
        // dataRefresh). A record created while dataRefresh was off has no
        // dataExpiresAt, so it renews on its first read.
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
            refreshed.data = newData;
            refreshed.dataExpiresAt = now + this.dataRefresh.ttlSeconds;
        }
        // Sliding expiration, throttled: no store write while lastAccessedAt
        // is recent, to avoid a write on every request. A due data renewal
        // above forces the write, so both updates share one write.
        if (this.enableSlidingExpiration) {
            const minInterval = this.slidingWriteIntervalSeconds
                ?? Math.max(60, Math.floor((session.ttlInSeconds || 0) * 0.05));
            if (refreshed.data !== undefined || now - (session.lastAccessedAt || 0) >= minInterval) {
                slid.lastAccessedAt = now;
                slid.expiresAt = now + session.ttlInSeconds;
            }
        }
        const renewed = { ...session, ...refreshed, ...slid };
        if (refreshed.data === undefined && slid.expiresAt === undefined)
            return renewed;
        // Awaited, so it persists before Lambda freezes. A failing write is
        // not fatal: the refreshed data is served, the expiry stays where the
        // cookies have it, and an unpersisted renewal runs again on the next
        // read. It is logged because a store failing
        // every renewal write silently ends every session at its creation
        // TTL, visible otherwise only as users signed out too soon. The log
        // carries the reason only, never anything identifying the session.
        try {
            const result = await this.store.update(session.sessionKeyHash, session.secretHash, { ...refreshed, ...slid }, refreshed.data !== undefined ? { dataVersion: session.dataVersion } : undefined);
            if (result === "missing")
                return null;
            // Refreshed data that landed moved the version exactly once past
            // the one the write named (see updateSessionData); a slide alone
            // leaves it.
            if (result === "updated")
                return refreshed.data !== undefined ? { ...renewed, dataVersion: session.dataVersion + 1 } : renewed;
            // Written over by a newer write, or marked stale, while the
            // refresh ran: that write stands, and the expiry still slides.
            if (slid.expiresAt !== undefined && await this.store.update(session.sessionKeyHash, session.secretHash, slid) === "missing")
                return null;
        }
        catch (err) {
            console.error(`Lambder session: the renewal write failed, so this session keeps its stored expiry. ${coerceToError(err).message}`);
            return { ...session, ...refreshed };
        }
        return renewed;
    }
    ;
    /**
     * Runs the dataRefresh callback immediately, regardless of
     * dataExpiresAt, and persists the result onto the same record, over the
     * data it was computed from only (see LambderSessionDataRefreshConfig).
     * Returns the refreshed session, or null when the callback ended it (the
     * record is deleted) or the session is gone. The expiry does not slide
     * here; renewSession slides it. Requires dataRefresh to be configured.
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
        const changes = { data: newData, dataExpiresAt: Math.floor(Date.now() / 1000) + this.dataRefresh.ttlSeconds };
        const result = await this.store.update(session.sessionKeyHash, session.secretHash, changes, { dataVersion: session.dataVersion });
        if (result === "missing")
            return null;
        // "stale": served, not written, and the record keeps the version it
        // was read with (see updateSessionData).
        return { ...session, ...changes, ...(result === "updated" ? { dataVersion: session.dataVersion + 1 } : {}) };
    }
    ;
    /**
     * Checks a record against the session token presented with it: the
     * partition hash and the bearer secret the cookie carries, plus the
     * structural checks and the expiry. This is the half a route needs; a
     * record lookupSession just found by that token's own hash has already
     * passed it, so the read path does not ask again.
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
     * than one with a skip flag, because a boolean at the call site does not
     * say which half it turns off.
     */
    async isSessionCsrfTokenValid(session, csrfToken) {
        if (!session?.csrfTokenHash)
            return false;
        if (!csrfToken)
            return false;
        return this.crypto.constantTimeEqual(session.csrfTokenHash, await this.hashToken(csrfToken));
    }
    /** Deletes the session; false when there was none left to delete. */
    async deleteSession(session) {
        return (await this.store.delete(session.sessionKeyHash, session.secretHash)) !== null;
    }
    ;
    /**
     * Deletes every session that shares the record's subject: "log this
     * subject out everywhere". False when a rotation racing it may have left
     * a session behind (see deleteAllUnder).
     */
    async deleteSessionAll(session) {
        return await this.deleteAllUnder(session.sessionKeyHash);
    }
    ;
    /**
     * Deletes every session created for the given sessionKey (e.g. a user
     * id): "log this subject out everywhere", without needing a fetched
     * session record. False when a rotation racing it may have left a
     * session behind (see deleteAllUnder).
     */
    async deleteSessionAllByKey(sessionKey) {
        return await this.deleteAllUnder(await this.sessionKeyHashOf(sessionKey));
    }
    ;
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
    async deleteAllUnder(sessionKeyHash) {
        for (let pass = 0; pass < SUBJECT_DELETE_MAX_PASSES; pass++) {
            let foundGone = false;
            await this.forEachSessionOf(sessionKeyHash, async (secretHash) => {
                if (await this.store.delete(sessionKeyHash, secretHash) === null)
                    foundGone = true;
            });
            if (!foundGone)
                return true;
        }
        // The count only, never the subject: a log line is no place for who it was.
        console.error(`Lambder session: deleting every session of a subject found a listed session already gone on each of its ${SUBJECT_DELETE_MAX_PASSES} passes, so a rotation racing it may have left a session behind. It answered false; run it again to be sure.`);
        return false;
    }
    /**
     * One write per session of a subject, a bounded number at a time: a
     * subject with hundreds of sessions is not hundreds of round trips in a
     * row, and not hundreds at once either.
     */
    async forEachSessionOf(sessionKeyHash, write) {
        const secretHashes = await this.store.listSecretHashes(sessionKeyHash);
        for (let start = 0; start < secretHashes.length; start += SUBJECT_WRITE_CONCURRENCY) {
            await Promise.all(secretHashes.slice(start, start + SUBJECT_WRITE_CONCURRENCY).map(write));
        }
    }
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
    async expireSessionDataAllByKey(sessionKey) {
        if (!this.dataRefresh)
            throw new Error("dataRefresh is not configured. Pass session.dataRefresh at creation to enable.");
        const sessionKeyHash = await this.sessionKeyHashOf(sessionKey);
        const now = Math.floor(Date.now() / 1000);
        // An update, so a session deleted in between stays deleted.
        await this.forEachSessionOf(sessionKeyHash, (secretHash) => this.store.update(sessionKeyHash, secretHash, { dataExpiresAt: now }));
        return true;
    }
    ;
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
    async regenerateSession(session) {
        if (!session)
            throw new Error("Invalid session");
        const now = Math.floor(Date.now() / 1000);
        const created = await this.createSession(session.sessionKey, session.data, session.ttlInSeconds, this.dataRefresh ? { dataExpiresAt: now } : undefined);
        const replacement = created.session;
        const removed = await this.store.delete(session.sessionKeyHash, session.secretHash);
        if (!removed || removed.expiresAt <= now) {
            await this.store.delete(replacement.sessionKeyHash, replacement.secretHash);
            return null;
        }
        if (canonicalJson(removed.data) === canonicalJson(session.data))
            return created;
        // Another request wrote the data after this one read it. The write
        // moves the replacement's dataVersion one past the one it was created
        // with, and the record handed back says so: a data write later in
        // this request names the version the store holds rather than answer
        // stale. A mark landing in between still makes it stale, the safe
        // side (see updateSessionData).
        if (await this.store.update(replacement.sessionKeyHash, replacement.secretHash, { data: removed.data }) === "missing")
            return null;
        return { ...created, session: { ...replacement, data: removed.data, dataVersion: replacement.dataVersion + 1 } };
    }
}
;

import { resolveCookieDomain, serializeCookie, serializeClearCookie } from "../shared/wire/LambderCookie.js";
import { isMintedSessionToken } from "./LambderSessionManager.js";
/**
 * No session for this request: the cookies named none, the single session
 * they named did not pair with the posted CSRF token, they cannot be
 * resolved to one session (LambderSessionAmbiguousError, the one case with a
 * type of its own), or the session was ended while the request held it (a
 * logout or a password change elsewhere, or the dataRefresh callback).
 *
 * Typed so fetchSessionIfExists can tell "no session here" from "something
 * broke", and so can every place that answers a request which needed a
 * session and has none (the API pipeline, a route or a hook on the server):
 * each tests for this class, and the ambiguous case with it. Everything else
 * (a TypeError from a custom store, a bug in a dataRefresh callback)
 * propagates as a crash: answering sessionExpired for a defect makes the
 * client clear its cookies and turns a bug into a logout.
 */
export class LambderSessionNotFoundError extends Error {
    constructor(message = "Session not found") {
        super(message);
        this.name = "LambderSessionNotFoundError";
    }
}
/**
 * The request's session cookies cannot be resolved to one session, so none of
 * them is used and every scope this host can write is cleared. A request with
 * no usable session, so it is a LambderSessionNotFoundError and is answered
 * as one wherever that is (a 401 or the session-expired route answer, the
 * sessionExpired envelope on an API call). The subclass keeps it apart for
 * whoever wants to tell: this case carries the clearing Set-Cookie headers
 * that heal the state, and it is the one worth finding in a log.
 */
export class LambderSessionAmbiguousError extends LambderSessionNotFoundError {
    constructor(message = "Session ambiguous") {
        super(message);
        this.name = "LambderSessionAmbiguousError";
    }
}
/** The tokens are hex, so the cookie carries them unencoded, in the format browsers already hold. */
const rawCookieValue = (value) => value;
/**
 * A `__Host-` cookie is the browser's own answer to a sibling subdomain
 * planting a session cookie at a parent domain: it refuses one that carries a
 * Domain, so no other host can write it. `__Secure-` is the weaker sibling,
 * accepted only on a Secure cookie. Both fail silently: a browser discards a
 * prefixed cookie with an attribute the prefix forbids, and the app looks
 * like it has no sessions rather than like it is misconfigured. So the
 * combinations are rejected at creation.
 *
 * Session policy, so it lives beside the controller that writes the cookies
 * rather than in the pipeline that calls it.
 */
export const assertSessionCookiePrefixes = (sessions) => {
    const keys = [sessions.tokenCookieKey, sessions.csrfCookieKey];
    const hostPrefixed = keys.filter((key) => key.startsWith("__Host-"));
    const securePrefixed = keys.filter((key) => key.startsWith("__Secure-"));
    if (sessions.cookieOptions.secure === false) {
        // Both prefixes require Secure, so one check covers them; the
        // messages stay separate so each names its own prefix.
        if (hostPrefixed.length > 0) {
            throw new Error(`Lambder: session cookie ${hostPrefixed.join(" and ")} uses the __Host- prefix, which a browser accepts only on a Secure cookie. ` +
                "Drop session.cookie.secure: false, or drop the prefix; keeping both means the browser discards the cookie silently and no session is ever read.");
        }
        if (securePrefixed.length > 0) {
            throw new Error(`Lambder: session cookie ${securePrefixed.join(" and ")} uses the __Secure- prefix, which a browser accepts only on a Secure cookie. ` +
                "Drop session.cookie.secure: false, or drop the prefix; keeping both means the browser discards the cookie silently and no session is ever read.");
        }
    }
    if (hostPrefixed.length === 0)
        return;
    if (sessions.cookieOptions.domain !== undefined) {
        throw new Error(`Lambder: session cookie ${hostPrefixed.join(" and ")} uses the __Host- prefix, which a browser accepts only without a Domain. ` +
            "Drop session.cookie.domain, or drop the prefix; keeping both means the browser discards the cookie and no session is ever read.");
    }
    if (sessions.cookieOptions.path !== undefined && sessions.cookieOptions.path !== "/") {
        throw new Error(`Lambder: session cookie ${hostPrefixed.join(" and ")} uses the __Host- prefix, which a browser accepts only at Path=/. ` +
            `Drop session.cookie.path, or drop the prefix.`);
    }
};
/**
 * How many copies of the session cookie one request may carry before the
 * request is treated as ambiguous. A name legitimately arrives at a few
 * scopes (a Domain change mid-migration leaves a host-only twin), and no
 * browser has a reason to send more. Beyond this the request is refused
 * rather than trimmed: dropping extras would let anyone who can plant cookies
 * at a parent domain push the visitor's own copy out of the read and log them
 * out silently, with no eviction emitted, so it would never heal. Nothing is
 * read from the store on that path.
 */
const MAX_SESSION_TOKEN_CANDIDATES = 4;
/**
 * Sessions as one request sees them: reads the session the request's
 * cookies name onto the context, and writes the cookies a created, rotated
 * or ended session needs into the context's response headers. Server and
 * mock handlers reach it as ctx.sessionController (the server's also through
 * lambder.getSessionController(ctx)); it needs only the call context and
 * request info, so one class serves both.
 */
export default class LambderSessionController {
    manager;
    tokenCookieKey;
    csrfCookieKey;
    cookieOptions;
    ctx;
    request;
    constructor({ manager, tokenCookieKey, csrfCookieKey, cookieOptions, ctx, request }) {
        this.manager = manager;
        this.tokenCookieKey = tokenCookieKey;
        this.csrfCookieKey = csrfCookieKey;
        this.cookieOptions = cookieOptions ?? {};
        this.ctx = ctx;
        this.request = request;
    }
    ;
    /** The configured scope with the domain resolved for this request, or the host-only scope. */
    cookieScope(hostOnly = false) {
        const { domain, path, sameSite, secure } = this.cookieOptions;
        return { domain: hostOnly ? undefined : resolveCookieDomain(domain, this.request.host), path, sameSite, secure };
    }
    ;
    /**
     * Both cookies at one expiry, with the raw secrets, which exist only on
     * the LambderCreatedSession result, in these cookies and in requests that
     * carry them back; the record stores hashes. `csrfToken` is null when this
     * request does not know the raw CSRF value, and then only the session
     * cookie is written: a CSRF cookie that does not pair with the session
     * would break the session it is refreshing.
     */
    writeSessionCookies(expiresAt, sessionToken, csrfToken) {
        const scope = this.cookieScope();
        const expires = new Date(expiresAt * 1000);
        // Max-Age beside Expires: a browser that knows Max-Age counts from
        // receipt rather than from a date, so a device whose clock runs ahead
        // does not drop a short-lived session early.
        const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
        this.ctx.responseHeaders.add("Set-Cookie", serializeCookie(this.tokenCookieKey, sessionToken, { ...scope, expires, maxAge, httpOnly: true, encode: rawCookieValue }));
        if (csrfToken !== null)
            this.ctx.responseHeaders.add("Set-Cookie", serializeCookie(this.csrfCookieKey, csrfToken, { ...scope, expires, maxAge, encode: rawCookieValue }));
    }
    ;
    setSessionCookies(created) {
        this.writeSessionCookies(created.session.expiresAt, created.sessionToken, created.csrfToken);
    }
    ;
    /**
     * The deleting pair for one scope. A deletion only reaches a cookie with
     * the same Domain and Path, so the pair is emitted per scope; the two
     * callers differ only in which scopes they walk.
     */
    addClearCookiePair(scope) {
        this.ctx.responseHeaders.add("Set-Cookie", serializeClearCookie(this.tokenCookieKey, { ...scope, httpOnly: true }));
        this.ctx.responseHeaders.add("Set-Cookie", serializeClearCookie(this.csrfCookieKey, scope));
    }
    ;
    clearSessionCookies(hostOnly = false) {
        this.addClearCookiePair(this.cookieScope(hostOnly));
    }
    ;
    /**
     * Every Domain this host is allowed to write the session cookies at: the
     * host-only scope, the configured one, and each parent domain of the
     * request host. A deletion matches only a cookie with the same Domain, so
     * evicting a copy the app never set needs all of them. A browser ignores
     * a Domain it will not accept, so a registry-owned suffix can be offered
     * without checking a public-suffix list.
     */
    cookieClearDomains() {
        const hostname = (this.request.host.split(":")[0] ?? "").toLowerCase();
        const labels = hostname.split(".").filter(Boolean);
        const scopes = [];
        // Two labels is the shortest a browser will take; one is a registry
        // suffix and is rejected wherever it is offered.
        for (let i = 0; i + 2 <= labels.length; i++) {
            scopes.push(labels.slice(i).join("."));
        }
        const configured = resolveCookieDomain(this.cookieOptions.domain, this.request.host);
        if (configured)
            scopes.push(configured);
        // A leading dot is ignored when matching, so ".example.com" and
        // "example.com" name one cookie and only one deletion is needed.
        const named = new Set(scopes.map((domain) => domain.replace(/^\./, "")));
        return [undefined, ...named];
    }
    ;
    /**
     * Clears the session cookies at every scope this host can reach, not just
     * the configured one. Used when a request carries more than one live
     * session: the copy that has to go may sit at a parent domain where a
     * sibling host planted it, and clearing only the configured scope would
     * evict the visitor's own cookie and leave the planted one as the sole
     * survivor, completing the takeover instead of stopping it.
     */
    clearSessionCookiesEverywhere() {
        const base = this.cookieScope(true);
        for (const domain of this.cookieClearDomains()) {
            this.addClearCookiePair({ ...base, domain });
        }
    }
    ;
    /**
     * Refuses a request whose session cookies cannot be resolved to one
     * session, clearing every scope this host can write (see
     * clearSessionCookiesEverywhere for why not just the configured one).
     *
     * Path is the one dimension this cannot sweep: the request info carries
     * no path, and a deletion matches only a cookie at the same Path, so a
     * copy planted at a deeper path stays out of reach. A `__Host-` cookie
     * name is the structural answer, since the prefix forbids Domain and
     * pins Path to "/"; see docs/sessions.md.
     */
    refuseAmbiguousSession(what) {
        console.warn(`Lambder session: ${what}, from ${this.request.host}. `
            + "Refusing all of them and clearing every scope this host can write: only one of them can be this visitor's, and picking one would sign them into the other. "
            + "A cookie set at a parent domain is the usual cause, whether from a sibling site or an old deployment scope.");
        this.clearSessionCookiesEverywhere();
        throw new LambderSessionAmbiguousError();
    }
    ;
    /**
     * Both session cookie names read in one pass: every well-formed value
     * under the token name, and every value under the CSRF name.
     *
     * The CSRF cookie is counted, not just checked against a token, because
     * it is plantable like the session cookie and the browser picks between
     * copies silently: the client reads it with js-cookie's Cookies.get, which
     * returns the FIRST copy in document.cookie, and browsers order a longer
     * Path first. A sibling host that plants a CSRF cookie at a parent domain
     * with a deeper Path decides which token every call posts, and the count
     * is the only thing that shows it.
     */
    scanSessionCookies() {
        const wellFormed = (this.request.cookies[this.tokenCookieKey] ?? []).filter(isMintedSessionToken);
        // Deduplicated: one value arriving twice (a proxy that appends rather
        // than merges Cookie, the same value set at two scopes) is one
        // session, not an ambiguity. Not truncated: a count past the cap is
        // itself the answer (see MAX_SESSION_TOKEN_CANDIDATES).
        return {
            sessionTokens: [...new Set(wellFormed)],
            csrfTokens: [...new Set(this.request.cookies[this.csrfCookieKey] ?? [])],
        };
    }
    ;
    /** An API call must also carry a CSRF token; a route only needs the cookie. */
    areRequestSessionTokensValid(sessionTokens) {
        if (sessionTokens.length === 0)
            return false;
        if (this.request.csrfToken !== null)
            return this.request.csrfToken.length > 0;
        return true;
    }
    ;
    async createSession(sessionKey, data, ttlInSeconds) {
        return (await this.issueSession(sessionKey, data, ttlInSeconds)).session;
    }
    ;
    /**
     * createSession, handing back the raw tokens beside the session, for a
     * test or mock runtime that plants the cookies somewhere other than this
     * call's response (a cookie jar).
     */
    async issueSession(sessionKey, data, ttlInSeconds) {
        const created = await this.manager.createSession(sessionKey, data, ttlInSeconds);
        this.setSessionCookies(created);
        this.ctx.session = created.session;
        return created;
    }
    ;
    async regenerateSession() {
        return (await this.reissueSession()).session;
    }
    ;
    /**
     * regenerateSession, handing back the raw tokens beside the session as
     * issueSession does. Rotation mints a new CSRF token, and a client that
     * holds its token rather than reading document.cookie (a native app, an
     * invoke caller) needs the new one to keep calling.
     */
    async reissueSession() {
        if (!this.ctx.session)
            throw new LambderSessionNotFoundError();
        const created = await this.manager.regenerateSession(this.ctx.session);
        if (!created)
            this.endWithNoSession();
        this.setSessionCookies(created);
        this.ctx.session = created.session;
        return created;
    }
    ;
    async fetchSession() {
        const { sessionTokens: candidates, csrfTokens } = this.scanSessionCookies();
        if (!this.areRequestSessionTokensValid(candidates)) {
            throw new LambderSessionNotFoundError("Session tokens are invalid");
        }
        if (candidates.length > MAX_SESSION_TOKEN_CANDIDATES) {
            this.refuseAmbiguousSession(`more than ${MAX_SESSION_TOKEN_CANDIDATES} "${this.tokenCookieKey}" cookies arrived, at different scopes`);
        }
        // After the cap check: this says the store is about to be read once
        // per copy, and over the cap nothing is read.
        if (candidates.length > 1) {
            console.warn(`Lambder session: ${candidates.length} "${this.tokenCookieKey}" cookies arrived from ${this.request.host}; the browser holds the cookie at several scopes. Reading each.`);
        }
        // How many sessions the browser holds is a question about the cookies
        // alone, so it is asked without the CSRF pairing. With the pairing
        // folded in the answer would always be "one": a sibling subdomain
        // plants its own CSRF cookie beside its planted session, only one
        // CSRF token is posted, and no two sessions share a csrfTokenHash, so
        // the ambiguity this check exists to catch would be invisible. The
        // pairing is checked once, below, against the single resolved session.
        //
        // One live session plus stale copies is the ordinary case (a cookie
        // whose Domain or Path changed), and the live one wins. Two LIVE
        // sessions under one name is not: a sibling subdomain can write a
        // cookie at a parent domain that the browser sends alongside the real
        // one, and taking either could sign this visitor into an account that
        // is not theirs. There is no telling which they meant, so neither is
        // used.
        const live = [];
        for (const sessionToken of candidates) {
            // lookupSession finds the record BY the hash of this token's
            // secret and checks structure and expiry, so possession is proved
            // here; re-checking the token would hash the same secret twice.
            const candidate = await this.manager.lookupSession(sessionToken);
            if (!candidate)
                continue;
            live.push({ token: sessionToken, session: candidate });
            // A second live copy is already the whole answer.
            if (live.length > 1)
                break;
        }
        if (live.length > 1) {
            this.refuseAmbiguousSession(`more than one live "${this.tokenCookieKey}" cookie arrived, at different scopes`);
        }
        const found = live[0];
        if (!found)
            this.endWithNoSession();
        // The pairing check, once, against the resolved session. An API call
        // that did not post the matching CSRF token has no session here.
        if (this.request.csrfToken !== null && !(await this.manager.isSessionCsrfTokenValid(found.session, this.request.csrfToken))) {
            // A live session cookie with a posted CSRF token that pairs with
            // nothing is the CSRF half of the planted-cookie shape, and it
            // cannot heal on its own: the client posts the FIRST CSRF cookie
            // in document.cookie, a longer Path sorts first, so a planted copy
            // keeps winning through logout, the next sign-in and every call
            // after. A plain no-session answer emits no Set-Cookie, and the
            // client can only clear scopes it knows, not the ones a sibling
            // host planted at. So the everywhere-clear runs instead.
            //
            // Only when the request carried CSRF cookies: an invoke caller
            // posts the value in the envelope with no CSRF cookie, and its
            // wrong token is an ordinary no-session. And only when the cookies
            // are the suspect: a single CSRF cookie equal to the posted token
            // that does not pair is a stale pair the visitor can clear.
            if (csrfTokens.length > 1) {
                this.refuseAmbiguousSession(`more than one "${this.csrfCookieKey}" cookie arrived, at different scopes, and the one posted pairs with no session`);
            }
            if (csrfTokens.length === 1 && !csrfTokens.includes(this.request.csrfToken)) {
                this.refuseAmbiguousSession(`the posted CSRF token matches no "${this.csrfCookieKey}" cookie this request carried, while the session cookie named a live session`);
            }
            throw new LambderSessionNotFoundError();
        }
        // Renewed only once this session is known to be the caller's: a
        // slide or a dataRefresh is a write on their behalf.
        const expiresBefore = found.session.expiresAt;
        const session = await this.manager.renewSession(found.session);
        // Ended while this request read it (a logout, a password change), or
        // by its own dataRefresh: no session either way.
        if (!session)
            this.endWithNoSession();
        // The other copies are stale. This response can evict the host-only
        // twin of a Domain= cookie; a copy at a parent domain this host
        // cannot name is out of reach and expires on its own.
        //
        // Which copy is stale is an assumption: the request carries no scope,
        // so the twin being deleted may be the very cookie this read resolved
        // (a visitor who signed in before the app configured a domain). So the
        // eviction always ships with the replacement at the configured scope,
        // and the visitor stays signed in either way. It also lets a domain
        // migration converge on the first request rather than the first slide.
        const evictsHostOnlyTwin = candidates.length > 1 && !!this.cookieScope().domain;
        if (evictsHostOnlyTwin)
            this.clearSessionCookies(true);
        // A sliding write moved the record's expiry, so the cookies move with
        // it. Otherwise the browser keeps the creation-time Expires and signs
        // out an active visitor at createdAt + ttl, the very deadline sliding
        // expiration exists to push back. Throttled with the write, so an
        // active session re-issues its cookies at most that often.
        if (evictsHostOnlyTwin || session.expiresAt !== expiresBefore)
            await this.slideSessionCookies(session, found.token, csrfTokens);
        this.ctx.session = session;
        return session;
    }
    ;
    /**
     * Re-issues both cookies at this session's expiry: after a sliding write
     * moved it, and beside the host-only eviction, which would otherwise
     * delete a cookie without replacing it.
     *
     * On an API call the raw CSRF value is the posted one, which the pairing
     * check just matched. A route posts none, so the single arriving CSRF
     * cookie stands in, but only once it is known to pair: re-issuing an
     * unpaired value would overwrite the visitor's real CSRF cookie with a
     * planted one at the app's own scope, the takeover the scan exists to
     * prevent. Where neither is available the session cookie slides alone;
     * it is the half that decides whether the session survives.
     */
    async slideSessionCookies(session, sessionToken, csrfTokens) {
        const posted = this.request.csrfToken;
        if (posted !== null) {
            this.writeSessionCookies(session.expiresAt, sessionToken, posted);
            return;
        }
        const only = csrfTokens.length === 1 ? csrfTokens[0] : null;
        const paired = only !== null && await this.manager.isSessionCsrfTokenValid(session, only);
        this.writeSessionCookies(session.expiresAt, sessionToken, paired ? only : null);
    }
    ;
    /**
     * "No session" for a request whose session cookie names none, or whose
     * session ended while it held it: the context holds none.
     *
     * The cookies are left alone. A deletion matches a cookie by name, not by
     * value, so clearing here would also delete a session another response
     * has just set: a poll sent with the old cookie, answering after a login,
     * a rotation or a password change, would sign the person straight out of
     * the new session. It also keeps the client's own check working, which
     * clears the CSRF cookie only while it still holds the token the call
     * sent. A dead cookie costs a store read per request until it expires.
     */
    endWithNoSession() {
        this.ctx.session = null;
        throw new LambderSessionNotFoundError();
    }
    ;
    async fetchSessionIfExists() {
        try {
            return await this.fetchSession();
        }
        catch (err) {
            // Only a "no session" exit becomes null, the ambiguous one
            // included. A failing dataRefresh, a store read failure and
            // anything unexpected propagate: answering sessionExpired for a
            // defect makes the client clear its cookies, so a crash would
            // present as a logout with nothing in the log.
            if (err instanceof LambderSessionNotFoundError)
                return null;
            throw err;
        }
    }
    ;
    /**
     * Writes new data onto the current session. Throws
     * LambderSessionNotFoundError when the session was ended while this
     * request held it: the write does not bring it back, and an API call
     * answers sessionExpired.
     */
    async updateSessionData(newData) {
        if (!this.ctx.session)
            throw new LambderSessionNotFoundError();
        const updated = await this.manager.updateSessionData(this.ctx.session, newData);
        if (!updated)
            this.endWithNoSession();
        this.ctx.session = updated;
        return updated;
    }
    ;
    /**
     * Force-runs the dataRefresh callback now (see the session option of
     * create) and persists the result onto the current session. Throws
     * LambderSessionNotFoundError when the session is over, because the
     * callback ended it (the record is deleted) or because it was ended while
     * this request held it: the same "no session" a read gives for either,
     * with the cookies left alone (see endWithNoSession), and what an API
     * call answers as sessionExpired.
     */
    async refreshSessionData() {
        if (!this.ctx.session)
            throw new LambderSessionNotFoundError();
        const refreshed = await this.manager.refreshSessionData(this.ctx.session);
        if (!refreshed)
            this.endWithNoSession();
        this.ctx.session = refreshed;
        return refreshed;
    }
    ;
    /**
     * Deletes every session of the given sessionKey (e.g. a user id): "log
     * this subject out everywhere". Unlike endSessionAll it needs no fetched
     * session and touches no cookies, so it works on any subject.
     */
    async deleteSessionAllByKey(sessionKey) {
        await this.manager.deleteSessionAllByKey(sessionKey);
    }
    ;
    /**
     * Marks the data of every session of the given sessionKey stale, so each
     * renews via dataRefresh on its next read: the way to apply a change to
     * a subject's roles or permissions immediately, without logging them
     * out. Needs no fetched session; requires dataRefresh.
     */
    async expireSessionDataAllByKey(sessionKey) {
        await this.manager.expireSessionDataAllByKey(sessionKey);
    }
    ;
    async endSession() {
        if (!this.ctx.session)
            throw new LambderSessionNotFoundError();
        await this.manager.deleteSession(this.ctx.session);
        this.clearSessionCookies();
        this.ctx.session = null;
    }
    ;
    async endSessionAll() {
        if (!this.ctx.session)
            throw new LambderSessionNotFoundError();
        await this.manager.deleteSessionAll(this.ctx.session);
        this.clearSessionCookies();
        this.ctx.session = null;
    }
    ;
}
;

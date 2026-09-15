import { resolveCookieDomain, serializeCookie, serializeClearCookie } from "../shared/wire/LambderCookie.js";
import { isMintedSessionToken } from "./LambderSessionManager.js";
/**
 * No session for this request: the cookies named none, or the single session
 * they named did not pair with the posted CSRF token.
 *
 * Typed rather than a bare Error because fetchSessionIfExists has to tell
 * "there is no session here" apart from "something broke". Everything else,
 * a TypeError from a custom store, a bug in an app's dataRefresh callback,
 * propagates and becomes a crash: answering sessionExpired for a defect makes
 * the client clear its cookies and turns somebody's bug into a logout.
 */
export class LambderSessionNotFoundError extends Error {
    constructor(message = "Session not found") {
        super(message);
        this.name = "LambderSessionNotFoundError";
    }
}
/**
 * The request's session cookies cannot be resolved to one session, so none of
 * them is used and every scope this host can write is cleared. Also a "no
 * session" answer to the caller, and deliberately a different type: this one
 * carries the clearing Set-Cookie headers that heal the state, and it is the
 * one worth finding in a log.
 */
export class LambderSessionAmbiguousError extends Error {
    constructor(message = "Session ambiguous") {
        super(message);
        this.name = "LambderSessionAmbiguousError";
    }
}
/** The tokens are hex, so the cookie carries them as they are (the format existing browsers hold). */
const rawCookieValue = (value) => value;
/**
 * A `__Host-` cookie is the browser's own answer to a sibling subdomain
 * planting a session cookie at a parent domain: it refuses one that carries a
 * Domain, so no other host can write it. `__Secure-` is the weaker sibling,
 * accepted only on a Secure cookie. Both protections fail silently, though: a
 * browser handed a prefixed name with an attribute the prefix forbids simply
 * discards the cookie, and the app looks like it has no sessions at all
 * rather than like it is misconfigured. So the combinations are rejected at
 * creation instead.
 *
 * Session policy, so it lives beside the controller that writes the cookies
 * rather than in the pipeline that happens to call it.
 */
export const assertSessionCookiePrefixes = (sessions) => {
    const keys = [sessions.tokenCookieKey, sessions.csrfCookieKey];
    const hostPrefixed = keys.filter((key) => key.startsWith("__Host-"));
    const securePrefixed = keys.filter((key) => key.startsWith("__Secure-"));
    if (sessions.cookieOptions.secure === false) {
        // Both prefixes require Secure, so this one check covers them
        // together; the messages stay separate because the fix differs.
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
 * scopes at once (a Domain change mid-migration leaves a host-only twin),
 * and no browser has a reason to send more. Beyond this the request is
 * refused rather than trimmed: dropping the extras would let anyone who can
 * plant cookies at a parent domain push the visitor's own copy out of the
 * read and log them out silently, with no eviction emitted, so it would
 * never heal. Nothing is read from the store on that path.
 */
const MAX_SESSION_TOKEN_CANDIDATES = 4;
/**
 * Sessions as one request sees them: reads the session the request's
 * cookies name onto the context, and writes the cookies a created,
 * rotated or ended session needs into the context's response headers.
 * Server handlers reach it through lambder.getSessionController(ctx); mock
 * handlers through ctx.sessions. It works on the call context and the
 * request info alone, so it is one class for both.
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
     * Both cookies at one expiry, with the raw secrets. They exist only on the
     * LambderCreatedSession result, in these cookies and in the request that
     * carried them back; the record stores hashes. `csrfToken` is null where
     * the raw CSRF value is not known to this request, in which case only the
     * session cookie is written: writing a CSRF cookie whose value does not
     * pair with the session would break the very session it is refreshing.
     */
    writeSessionCookies(expiresAt, sessionToken, csrfToken) {
        const scope = this.cookieScope();
        const expires = new Date(expiresAt * 1000);
        this.ctx.responseHeaders.add("Set-Cookie", serializeCookie(this.tokenCookieKey, sessionToken, { ...scope, expires, httpOnly: true, encode: rawCookieValue }));
        if (csrfToken !== null)
            this.ctx.responseHeaders.add("Set-Cookie", serializeCookie(this.csrfCookieKey, csrfToken, { ...scope, expires, encode: rawCookieValue }));
    }
    ;
    setSessionCookies(created) {
        this.writeSessionCookies(created.session.expiresAt, created.sessionToken, created.csrfToken);
    }
    ;
    /**
     * The deleting pair for one scope. Written once because a deletion only
     * reaches a cookie carrying the same Domain and Path, so the pair is
     * emitted per scope and the two callers differ in nothing but which
     * scopes they walk.
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
     * request host. A deletion matches only a cookie carrying the same
     * Domain, so evicting a copy the app itself never set needs all of them.
     * A browser ignores a Domain it will not accept, which is why a suffix
     * the registry owns can be offered without checking a public-suffix list.
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
     * Clears the session cookies at every scope this host can reach, rather
     * than at the one the app configured. Used when a request carries more
     * than one live session: the copy that has to go may sit at a parent
     * domain a sibling host planted it at, and clearing the configured scope
     * alone would evict this visitor's own cookie and leave the planted one
     * as the only survivor, which completes the takeover instead of stopping
     * it.
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
     * session, clearing every scope this host can write. Clearing only the
     * configured scope would be worse than picking one: a deletion matches
     * only a cookie carrying the same Domain, so it would evict the visitor's
     * own copy and leave a planted one as the sole survivor.
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
     * The CSRF cookie is counted here rather than looked at only when a token
     * is checked against it, because it is plantable exactly like the session
     * cookie and the browser picks between copies without telling anyone: the
     * client reads its CSRF token with js-cookie's Cookies.get, which returns
     * the FIRST copy in document.cookie, and a browser orders a longer Path
     * first. So a sibling host that plants one CSRF cookie at a parent domain
     * with a deeper Path decides which token every call posts, and the count
     * is the only thing that shows it.
     */
    scanSessionCookies() {
        const wellFormed = (this.request.cookies[this.tokenCookieKey] ?? []).filter(isMintedSessionToken);
        // Deduplicated: one value arriving twice (a proxy that appends rather
        // than merges Cookie, the same value set at two scopes) is one
        // session, and counting it twice would read as an ambiguity. Not
        // truncated: the count past the cap is the caller's answer, not
        // something to trim away (see MAX_SESSION_TOKEN_CANDIDATES).
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
     * createSession, handing back the raw tokens beside the session: what a
     * test or a mock runtime needs to plant the cookies somewhere else (a
     * cookie jar) than this call's response.
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
     * regenerateSession, handing back the raw tokens beside the session, the
     * way issueSession does for a new one. Rotating the session mints a new
     * CSRF token, and a client that holds its token rather than reading
     * document.cookie (a native app, an invoke caller) needs the new one to
     * keep calling.
     */
    async reissueSession() {
        if (!this.ctx.session)
            throw new LambderSessionNotFoundError();
        const created = await this.manager.regenerateSession(this.ctx.session);
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
        // After the cap check, because this line says the store is about to
        // be read once per copy and over the cap nothing is read at all.
        if (candidates.length > 1) {
            console.warn(`Lambder session: ${candidates.length} "${this.tokenCookieKey}" cookies arrived from ${this.request.host}; the browser holds the cookie at several scopes. Reading each.`);
        }
        // How many sessions the browser is holding is a question about the
        // cookies alone, so it is asked without the CSRF pairing. Folding the
        // pairing in here would answer a different question and always answer
        // it "one": a sibling subdomain plants its own CSRF cookie beside the
        // session it planted, only one CSRF token is ever posted, and no two
        // sessions share a csrfTokenHash, so exactly one candidate would
        // survive the pairing and the ambiguity this check exists to catch
        // would be invisible. The pairing is asked once, below, of whichever
        // single session the cookies resolved to.
        //
        // One live session and some stale copies is the ordinary case (a
        // cookie whose Domain or Path changed), and the live one wins. Two
        // LIVE sessions under one name is not ordinary: any sibling subdomain
        // can write a cookie at a parent domain that the browser then sends
        // alongside the real one, and taking either would sign this visitor
        // into an account that may not be theirs. There is no way to tell
        // which copy they meant, so neither is used.
        const live = [];
        for (const sessionToken of candidates) {
            // lookupSession finds the record BY the hash of this token's own
            // secret and checks the structure and the expiry on the way, so
            // possession is already proved here and re-checking the token
            // against the record would only hash the same secret twice.
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
            throw new LambderSessionNotFoundError();
        // The pairing check, once, against the one session the cookies
        // resolved to. An API call that did not post the matching CSRF token
        // has no session here.
        if (this.request.csrfToken !== null && !(await this.manager.isSessionCsrfTokenValid(found.session, this.request.csrfToken))) {
            // A session cookie that resolves while the posted CSRF token
            // belongs to nothing is the CSRF half of the planted-cookie
            // shape, and it is unhealable on its own: the client reads the
            // FIRST CSRF cookie in document.cookie, a longer Path sorts
            // first, so the planted copy keeps winning through the logout,
            // through the next sign-in, and through every call after it. The
            // ordinary answer (no session) emits no Set-Cookie at all, and
            // the client can only clear the scopes it knows, which are not
            // the ones a sibling host planted at. So the everywhere-clear
            // runs instead, and the state heals.
            //
            // Only when the request actually carried CSRF cookies: an invoke
            // caller posts the CSRF value in the envelope and sends no CSRF
            // cookie at all, and its wrong token is an ordinary no-session.
            // And only when the cookies are the suspect: one CSRF cookie that
            // is the token posted, not pairing, is a stale pair the visitor
            // can clear themselves.
            if (csrfTokens.length > 1) {
                this.refuseAmbiguousSession(`more than one "${this.csrfCookieKey}" cookie arrived, at different scopes, and the one posted pairs with no session`);
            }
            if (csrfTokens.length === 1 && !csrfTokens.includes(this.request.csrfToken)) {
                this.refuseAmbiguousSession(`the posted CSRF token matches no "${this.csrfCookieKey}" cookie this request carried, while the session cookie named a live session`);
            }
            throw new LambderSessionNotFoundError();
        }
        // Renewed only now that this session is known to be the caller's:
        // a slide or a dataRefresh is a write on their behalf.
        const expiresBefore = found.session.expiresAt;
        const session = await this.manager.renewSession(found.session);
        if (!session)
            throw new LambderSessionNotFoundError();
        // The other copies are stale. This response can evict the
        // host-only twin of a Domain= cookie; a copy at a parent domain
        // this host cannot name is out of reach and expires on its own.
        //
        // Which copy is the stale one is an assumption, not a fact: the
        // request carries no scope, so the twin being deleted may be the live
        // cookie this very read resolved, held by a visitor who signed in
        // before the app configured a domain. So the eviction always ships
        // with the replacement, at the configured scope, and the visitor
        // stays signed in either way. It also lets a domain migration
        // converge on the first request rather than on the first slide.
        const evictsHostOnlyTwin = candidates.length > 1 && !!this.cookieScope().domain;
        if (evictsHostOnlyTwin)
            this.clearSessionCookies(true);
        // A sliding write moved the record's expiry, so the cookies have to
        // move with it. Without this the browser keeps the Expires it was
        // given at creation and drops both cookies at createdAt + ttl, so a
        // visitor who never stops using the app is signed out anyway, on the
        // one deadline sliding expiration exists to push back. Throttled by
        // the same interval as the write, so an active session re-issues its
        // cookies at most that often and not on every request.
        if (evictsHostOnlyTwin || session.expiresAt !== expiresBefore)
            await this.slideSessionCookies(session, found.token, csrfTokens);
        this.ctx.session = session;
        return session;
    }
    ;
    /**
     * Re-issues both cookies at this session's expiry: after a sliding write
     * moved it, and beside the host-only eviction above, which would
     * otherwise delete a cookie without replacing it.
     *
     * The raw CSRF value is the posted one on an API call, which the pairing
     * check above has just matched against this session. A route posts none,
     * so the single arriving CSRF cookie stands in, and only once it is known
     * to pair: re-issuing an unpaired value would overwrite this visitor's
     * real CSRF cookie with a planted one, at the app's own scope, which is
     * the takeover the scan exists to prevent. Where neither is available the
     * session cookie slides alone, which is the half that decides whether the
     * session survives.
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
    async fetchSessionIfExists() {
        try {
            return await this.fetchSession();
        }
        catch (err) {
            // Only the two "no session" exits become null. A failing
            // dataRefresh callback, a store read failure, and anything
            // unexpected (a TypeError from a custom store, a bug in this
            // layer) propagate: answering sessionExpired for a defect makes
            // the client clear its cookies, so a crash would present as a
            // logout and the log would say nothing happened.
            if (err instanceof LambderSessionNotFoundError)
                return null;
            if (err instanceof LambderSessionAmbiguousError)
                return null;
            throw err;
        }
    }
    ;
    async updateSessionData(newData) {
        if (!this.ctx.session)
            throw new LambderSessionNotFoundError();
        this.ctx.session = await this.manager.updateSessionData(this.ctx.session, newData);
        return this.ctx.session;
    }
    ;
    /**
     * Force-runs the dataRefresh callback now (see the session option of create) and
     * persists the result onto the current session. Returns the updated
     * session, or null when the callback ended it: the record is deleted and
     * the session cookies are cleared.
     */
    async refreshSessionData() {
        if (!this.ctx.session)
            throw new LambderSessionNotFoundError();
        const refreshed = await this.manager.refreshSessionData(this.ctx.session);
        if (!refreshed) {
            this.clearSessionCookies();
            this.ctx.session = null;
            return null;
        }
        this.ctx.session = refreshed;
        return this.ctx.session;
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

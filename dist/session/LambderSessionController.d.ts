import { type LambderCookieOptions } from "../shared/wire/LambderCookie.js";
import type { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import type { LambderCreatedSession } from "./LambderSessionManager.js";
/**
 * The part of a call this controller touches: the session it reads and
 * writes, and the headers it puts Set-Cookie on. Declared here so the session
 * layer sits under the API core rather than beside it: the pipeline and both
 * adapters pass their full call context, which is structurally this plus
 * fields the controller never reads.
 */
export type LambderSessionCallSurface<TSessionData = any> = {
    session: LambderSessionRecord<TSessionData> | null;
    responseHeaders: LambderAnswerHeaders;
};
/**
 * Scope of the session cookies. `domain` is e.g. ".example.com" to share
 * sessions across subdomains, or a function of the request hostname when
 * one deployment serves several apex domains (return undefined for a
 * host-only cookie). Changing `domain` or `path` on a live deployment is a
 * migration: browsers keep the cookie under the old scope beside the new
 * one, and both arrive on every request. fetchSession scans every copy for
 * the one live session and evicts the stale host-only twin; a copy at a
 * parent domain this host cannot name lives until its own Expires.
 */
export type LambderSessionCookieOptions = Pick<LambderCookieOptions, "domain" | "path" | "sameSite" | "secure">;
/**
 * What the controller reads off the request: the host (cookie domain
 * resolution), every value of every cookie, and the CSRF token the caller
 * posted, or null when the request is not an API call (a route), in which
 * case no CSRF check applies.
 */
export type LambderSessionRequestInfo = {
    host: string;
    cookies: Record<string, string[]>;
    csrfToken: string | null;
};
export type LambderSessionControllerOptions<TSessionData> = {
    manager: LambderSessionManager<TSessionData>;
    /**
     * Name of the session cookie. Required rather than defaulted here: the
     * defaults (shared/wire/LambderSessionCookieNames.ts) are applied once,
     * where the app's session options are read. A second copy here could
     * drift and have a controller read a cookie name the app never writes.
     */
    tokenCookieKey: string;
    /** Name of the CSRF cookie, required on the same terms as tokenCookieKey. */
    csrfCookieKey: string;
    cookieOptions?: LambderSessionCookieOptions;
    /** The call context the session is read onto and whose responseHeaders receive the cookies. */
    ctx: LambderSessionCallSurface<TSessionData>;
    request: LambderSessionRequestInfo;
};
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
export declare class LambderSessionNotFoundError extends Error {
    constructor(message?: string);
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
export declare class LambderSessionAmbiguousError extends LambderSessionNotFoundError {
    constructor(message?: string);
}
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
export declare const assertSessionCookiePrefixes: (sessions: {
    tokenCookieKey: string;
    csrfCookieKey: string;
    cookieOptions: LambderSessionCookieOptions;
}) => void;
/**
 * Sessions as one request sees them: reads the session the request's
 * cookies name onto the context, and writes the cookies a created, rotated
 * or ended session needs into the context's response headers. Server and
 * mock handlers reach it as ctx.sessionController (the server's also through
 * lambder.getSessionController(ctx)); it needs only the call context and
 * request info, so one class serves both.
 */
export default class LambderSessionController<TSessionData = any> {
    readonly manager: LambderSessionManager<TSessionData>;
    readonly tokenCookieKey: string;
    readonly csrfCookieKey: string;
    readonly cookieOptions: LambderSessionCookieOptions;
    private readonly ctx;
    private readonly request;
    constructor({ manager, tokenCookieKey, csrfCookieKey, cookieOptions, ctx, request }: LambderSessionControllerOptions<TSessionData>);
    /** The configured scope with the domain resolved for this request, or the host-only scope. */
    private cookieScope;
    /**
     * Both cookies at one expiry, with the raw secrets, which exist only on
     * the LambderCreatedSession result, in these cookies and in requests that
     * carry them back; the record stores hashes. `csrfToken` is null when this
     * request does not know the raw CSRF value, and then only the session
     * cookie is written: a CSRF cookie that does not pair with the session
     * would break the session it is refreshing.
     */
    private writeSessionCookies;
    private setSessionCookies;
    /**
     * The deleting pair for one scope. A deletion only reaches a cookie with
     * the same Domain and Path, so the pair is emitted per scope; the two
     * callers differ only in which scopes they walk.
     */
    private addClearCookiePair;
    private clearSessionCookies;
    /**
     * Every Domain this host is allowed to write the session cookies at: the
     * host-only scope, the configured one, and each parent domain of the
     * request host. A deletion matches only a cookie with the same Domain, so
     * evicting a copy the app never set needs all of them. A browser ignores
     * a Domain it will not accept, so a registry-owned suffix can be offered
     * without checking a public-suffix list.
     */
    private cookieClearDomains;
    /**
     * Clears the session cookies at every scope this host can reach, not just
     * the configured one. Used when a request carries more than one live
     * session: the copy that has to go may sit at a parent domain where a
     * sibling host planted it, and clearing only the configured scope would
     * evict the visitor's own cookie and leave the planted one as the sole
     * survivor, completing the takeover instead of stopping it.
     */
    private clearSessionCookiesEverywhere;
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
    private refuseAmbiguousSession;
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
    private scanSessionCookies;
    /** An API call must also carry a CSRF token; a route only needs the cookie. */
    private areRequestSessionTokensValid;
    createSession(sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderSessionRecord<TSessionData>>;
    /**
     * createSession, handing back the raw tokens beside the session, for a
     * test or mock runtime that plants the cookies somewhere other than this
     * call's response (a cookie jar).
     */
    issueSession(sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderCreatedSession<TSessionData>>;
    regenerateSession(): Promise<LambderSessionRecord<TSessionData>>;
    /**
     * regenerateSession, handing back the raw tokens beside the session as
     * issueSession does. Rotation mints a new CSRF token, and a client that
     * holds its token rather than reading document.cookie (a native app, an
     * invoke caller) needs the new one to keep calling.
     */
    reissueSession(): Promise<LambderCreatedSession<TSessionData>>;
    fetchSession(): Promise<LambderSessionRecord<TSessionData>>;
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
    private slideSessionCookies;
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
    private endWithNoSession;
    fetchSessionIfExists(): Promise<LambderSessionRecord<TSessionData> | null>;
    /**
     * Writes new data onto the current session. Throws
     * LambderSessionNotFoundError when the session was ended while this
     * request held it: the write does not bring it back, and an API call
     * answers sessionExpired.
     */
    updateSessionData(newData: TSessionData): Promise<LambderSessionRecord<TSessionData>>;
    /**
     * Force-runs the dataRefresh callback now (see the session option of
     * create) and persists the result onto the current session. Throws
     * LambderSessionNotFoundError when the session is over, because the
     * callback ended it (the record is deleted) or because it was ended while
     * this request held it: the same "no session" a read gives for either,
     * with the cookies left alone (see endWithNoSession), and what an API
     * call answers as sessionExpired.
     */
    refreshSessionData(): Promise<LambderSessionRecord<TSessionData>>;
    /**
     * Deletes every session of the given sessionKey (e.g. a user id): "log
     * this subject out everywhere". Unlike endSessionAll it needs no fetched
     * session and touches no cookies, so it works on any subject.
     */
    deleteSessionAllByKey(sessionKey: string): Promise<void>;
    /**
     * Marks the data of every session of the given sessionKey stale, so each
     * renews via dataRefresh on its next read: the way to apply a change to
     * a subject's roles or permissions immediately, without logging them
     * out. Needs no fetched session; requires dataRefresh.
     */
    expireSessionDataAllByKey(sessionKey: string): Promise<void>;
    endSession(): Promise<void>;
    endSessionAll(): Promise<void>;
}

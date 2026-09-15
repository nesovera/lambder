import { type LambderCookieOptions } from "../shared/wire/LambderCookie.js";
import type { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import type { LambderCreatedSession } from "./LambderSessionManager.js";
/**
 * The part of a call this controller touches: the session it reads and
 * writes, and the headers it puts Set-Cookie on. Declaring it here is what
 * keeps the session layer under the API core rather than beside it: the
 * pipeline and both adapters pass their own full call context, which is
 * structurally this plus the fields the controller never reads.
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
 * one, and both arrive on every request. fetchSession tolerates that by
 * scanning every copy for the one live session and evicting the stale
 * host-only twin; a copy at a parent domain this host cannot name outlives
 * its own Expires.
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
     * defaults live in shared/wire/LambderSessionCookieNames.ts and are applied
     * once, where the app's session options are read, so a second copy of
     * them in this constructor would be a second place for them to drift and
     * would let a controller read a cookie name the app never writes.
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
 * No session for this request: the cookies named none, or the single session
 * they named did not pair with the posted CSRF token.
 *
 * Typed rather than a bare Error because fetchSessionIfExists has to tell
 * "there is no session here" apart from "something broke". Everything else,
 * a TypeError from a custom store, a bug in an app's dataRefresh callback,
 * propagates and becomes a crash: answering sessionExpired for a defect makes
 * the client clear its cookies and turns somebody's bug into a logout.
 */
export declare class LambderSessionNotFoundError extends Error {
    constructor(message?: string);
}
/**
 * The request's session cookies cannot be resolved to one session, so none of
 * them is used and every scope this host can write is cleared. Also a "no
 * session" answer to the caller, and deliberately a different type: this one
 * carries the clearing Set-Cookie headers that heal the state, and it is the
 * one worth finding in a log.
 */
export declare class LambderSessionAmbiguousError extends Error {
    constructor(message?: string);
}
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
export declare const assertSessionCookiePrefixes: (sessions: {
    tokenCookieKey: string;
    csrfCookieKey: string;
    cookieOptions: LambderSessionCookieOptions;
}) => void;
/**
 * Sessions as one request sees them: reads the session the request's
 * cookies name onto the context, and writes the cookies a created,
 * rotated or ended session needs into the context's response headers.
 * Server handlers reach it through lambder.getSessionController(ctx); mock
 * handlers through ctx.sessions. It works on the call context and the
 * request info alone, so it is one class for both.
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
     * Both cookies at one expiry, with the raw secrets. They exist only on the
     * LambderCreatedSession result, in these cookies and in the request that
     * carried them back; the record stores hashes. `csrfToken` is null where
     * the raw CSRF value is not known to this request, in which case only the
     * session cookie is written: writing a CSRF cookie whose value does not
     * pair with the session would break the very session it is refreshing.
     */
    private writeSessionCookies;
    private setSessionCookies;
    /**
     * The deleting pair for one scope. Written once because a deletion only
     * reaches a cookie carrying the same Domain and Path, so the pair is
     * emitted per scope and the two callers differ in nothing but which
     * scopes they walk.
     */
    private addClearCookiePair;
    private clearSessionCookies;
    /**
     * Every Domain this host is allowed to write the session cookies at: the
     * host-only scope, the configured one, and each parent domain of the
     * request host. A deletion matches only a cookie carrying the same
     * Domain, so evicting a copy the app itself never set needs all of them.
     * A browser ignores a Domain it will not accept, which is why a suffix
     * the registry owns can be offered without checking a public-suffix list.
     */
    private cookieClearDomains;
    /**
     * Clears the session cookies at every scope this host can reach, rather
     * than at the one the app configured. Used when a request carries more
     * than one live session: the copy that has to go may sit at a parent
     * domain a sibling host planted it at, and clearing the configured scope
     * alone would evict this visitor's own cookie and leave the planted one
     * as the only survivor, which completes the takeover instead of stopping
     * it.
     */
    private clearSessionCookiesEverywhere;
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
    private refuseAmbiguousSession;
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
    private scanSessionCookies;
    /** An API call must also carry a CSRF token; a route only needs the cookie. */
    private areRequestSessionTokensValid;
    createSession(sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderSessionRecord<TSessionData>>;
    /**
     * createSession, handing back the raw tokens beside the session: what a
     * test or a mock runtime needs to plant the cookies somewhere else (a
     * cookie jar) than this call's response.
     */
    issueSession(sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderCreatedSession<TSessionData>>;
    regenerateSession(): Promise<LambderSessionRecord<TSessionData>>;
    /**
     * regenerateSession, handing back the raw tokens beside the session, the
     * way issueSession does for a new one. Rotating the session mints a new
     * CSRF token, and a client that holds its token rather than reading
     * document.cookie (a native app, an invoke caller) needs the new one to
     * keep calling.
     */
    reissueSession(): Promise<LambderCreatedSession<TSessionData>>;
    fetchSession(): Promise<LambderSessionRecord<TSessionData>>;
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
    private slideSessionCookies;
    fetchSessionIfExists(): Promise<LambderSessionRecord<TSessionData> | null>;
    updateSessionData(newData: TSessionData): Promise<LambderSessionRecord<TSessionData>>;
    /**
     * Force-runs the dataRefresh callback now (see the session option of create) and
     * persists the result onto the current session. Returns the updated
     * session, or null when the callback ended it: the record is deleted and
     * the session cookies are cleared.
     */
    refreshSessionData(): Promise<LambderSessionRecord<TSessionData> | null>;
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

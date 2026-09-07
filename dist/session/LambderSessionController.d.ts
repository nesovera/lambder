import { LambderRenderContext, LambderSessionRenderContext } from "../core/LambderContext.js";
import { type LambderCookieOptions } from "../core/LambderCookie.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import { type LambderSessionContext } from "./LambderSessionManager.js";
/**
 * Scope of the session cookies. `domain` is e.g. ".example.com" to share
 * sessions across subdomains, or a function of the request hostname when
 * one deployment serves several apex domains (return undefined for a
 * host-only cookie). Changing `domain` or `path` on a live deployment is a
 * migration: browsers keep the cookie under the old scope beside the new
 * one, and both arrive on every request. fetchSession tolerates that by
 * trying every copy and evicting the stale host-only twin; a copy at a
 * parent domain this host cannot name outlives its own Expires.
 */
export type LambderSessionCookieOptions = Pick<LambderCookieOptions, "domain" | "path" | "sameSite" | "secure">;
export default class LambderSessionController<TSessionData = any> {
    lambderSessionManager: LambderSessionManager;
    sessionTokenCookieKey: string;
    sessionCsrfCookieKey: string;
    cookieOptions: LambderSessionCookieOptions;
    ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>;
    constructor({ lambderSessionManager, sessionTokenCookieKey, sessionCsrfCookieKey, cookieOptions, ctx, }: {
        lambderSessionManager: LambderSessionManager;
        sessionTokenCookieKey: string;
        sessionCsrfCookieKey: string;
        cookieOptions?: LambderSessionCookieOptions;
        ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>;
    });
    /** The configured scope with the domain resolved for this request, or the host-only scope. */
    private cookieScope;
    /** Raw secrets exist only on the LambderCreatedSession result and in these cookies; the record stores hashes. */
    private setSessionCookies;
    private clearSessionCookies;
    /**
     * Every well-formed value the request carried under the session cookie
     * name. More than one means the browser holds the cookie at several
     * scopes, and the order says nothing about which copy is current.
     */
    private sessionTokenCandidates;
    private areRequestSessionTokensValid;
    createSession(sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderSessionContext<TSessionData>>;
    regenerateSession(): Promise<LambderSessionContext<TSessionData>>;
    fetchSession(): Promise<LambderSessionContext<TSessionData>>;
    fetchSessionIfExists(): Promise<LambderSessionContext<TSessionData> | null>;
    /** Checks the record against a presented token (the request's first session cookie by default) and, on API calls, the posted CSRF token. */
    isSessionValid(session: any, sessionToken?: string | undefined): boolean;
    updateSessionData(newData: any): Promise<LambderSessionContext>;
    /**
     * Force-runs the dataRefresh callback now (see the session option of create) and
     * persists the result onto the current session. Returns the updated
     * session, or null when the callback ended it: the record is deleted and
     * the session cookies are cleared.
     */
    refreshSessionData(): Promise<LambderSessionContext<TSessionData> | null>;
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

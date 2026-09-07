import { LambderRenderContext, LambderSessionRenderContext } from "../core/LambderContext.js";
import { resolveCookieDomain, serializeCookie, serializeClearCookie, type LambderCookieOptions } from "../core/LambderCookie.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import { LambderSessionDataRefreshError, LambderSessionReadError, type LambderCreatedSession, type LambderSessionContext } from "./LambderSessionManager.js";

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

/** The tokens are hex, so the cookie carries them as they are (the format existing browsers hold). */
const rawValue = (value: string): string => value;

export default class LambderSessionController<TSessionData = any> {
    lambderSessionManager: LambderSessionManager;
    sessionTokenCookieKey: string;
    sessionCsrfCookieKey: string;
    cookieOptions: LambderSessionCookieOptions;
    ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>; // Internal context with mutable session property

    constructor(
        { 
            lambderSessionManager,
            sessionTokenCookieKey,
            sessionCsrfCookieKey,
            cookieOptions,
            ctx,
        }: {
            lambderSessionManager: LambderSessionManager,
            sessionTokenCookieKey: string,
            sessionCsrfCookieKey: string,
            cookieOptions?: LambderSessionCookieOptions,
            ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>,
        }
    ){
        this.lambderSessionManager = lambderSessionManager;
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
        this.cookieOptions = cookieOptions ?? {};
        this.ctx = ctx;
    };

    /** The configured scope with the domain resolved for this request, or the host-only scope. */
    private cookieScope(hostOnly = false): LambderCookieOptions {
        const { domain, path, sameSite, secure } = this.cookieOptions;
        return { domain: hostOnly ? undefined : resolveCookieDomain(domain, this.ctx.host), path, sameSite, secure };
    };

    /** Raw secrets exist only on the LambderCreatedSession result and in these cookies; the record stores hashes. */
    private setSessionCookies(created: LambderCreatedSession<TSessionData>): void {
        const scope = this.cookieScope();
        const expires = new Date(created.session.expiresAt * 1000);
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: serializeCookie(this.sessionTokenCookieKey, created.sessionToken, { ...scope, expires, httpOnly: true, encode: rawValue }) });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: serializeCookie(this.sessionCsrfCookieKey, created.csrfToken, { ...scope, expires, encode: rawValue }) });
    };

    private clearSessionCookies(hostOnly = false): void {
        const scope = this.cookieScope(hostOnly);
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: serializeClearCookie(this.sessionTokenCookieKey, { ...scope, httpOnly: true }) });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: serializeClearCookie(this.sessionCsrfCookieKey, scope) });
    };

    /**
     * Every well-formed value the request carried under the session cookie
     * name. More than one means the browser holds the cookie at several
     * scopes, and the order says nothing about which copy is current.
     */
    private sessionTokenCandidates(): string[] {
        return (this.ctx.cookieList?.[this.sessionTokenCookieKey] ?? []).filter((token) => token.split(":").length === 2);
    };

    private areRequestSessionTokensValid(): boolean {
        const isSessionTokenValid = this.sessionTokenCandidates().length > 0;

        if(this.ctx._otherInternal.isApiCall){
            const csrfToken = this.ctx.post?.token;
            const isCsrfTokenValid = typeof csrfToken === "string" && csrfToken.length > 0
            return isSessionTokenValid && isCsrfTokenValid;
        }else{
            return isSessionTokenValid;
        }
    };

    async createSession (sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderSessionContext<TSessionData>> {
        const created = await this.lambderSessionManager.createSession(sessionKey, data, ttlInSeconds);
        this.setSessionCookies(created);
        this.ctx.session = created.session;
        return this.ctx.session;
    };

    async regenerateSession (): Promise<LambderSessionContext<TSessionData>> {
        if(!this.ctx.session) throw new Error("Session not found.");
        const created = await this.lambderSessionManager.regenerateSession(this.ctx.session);
        this.setSessionCookies(created);
        this.ctx.session = created.session;
        return this.ctx.session;
    };

    async fetchSession (): Promise<LambderSessionContext<TSessionData>>{
        if(!this.areRequestSessionTokensValid()){ throw new Error("Session tokens are invalid"); }

        const candidates = this.sessionTokenCandidates();
        if(candidates.length > 1){
            console.warn(`Lambder session: ${candidates.length} "${this.sessionTokenCookieKey}" cookies arrived from ${this.ctx.host}; the browser holds the cookie at several scopes and a stale copy may shadow the live one. Trying each.`);
        }
        for(const sessionToken of candidates){
            const session = await this.lambderSessionManager.getSession(sessionToken);
            if(!session || !this.isSessionValid(session, sessionToken)) continue;
            // The other copies are stale. This response can evict the
            // host-only twin of a Domain= cookie; a copy at a parent domain
            // this host cannot name is out of reach and expires on its own.
            if(candidates.length > 1 && this.cookieScope().domain) this.clearSessionCookies(true);
            this.ctx.session = session;
            return session;
        }
        throw new Error("Session not found");
    };

    async fetchSessionIfExists (): Promise<LambderSessionContext<TSessionData>|null> {
        try {
            return await this.fetchSession();
        }catch(err){
            // Missing or invalid sessions become null, but a failing
            // dataRefresh callback or a DynamoDB read failure must not
            // masquerade as a logout.
            if(err instanceof LambderSessionDataRefreshError) throw err;
            if(err instanceof LambderSessionReadError) throw err;
            return null;
        }
    };

    /** Checks the record against a presented token (the request's first session cookie by default) and, on API calls, the posted CSRF token. */
    isSessionValid(session: any, sessionToken: string | undefined = this.ctx.cookie?.[this.sessionTokenCookieKey]): boolean {
        if(this.ctx._otherInternal.isApiCall){
            const csrfToken = this.ctx.post?.token;
            return this.lambderSessionManager.isSessionValid(session, sessionToken, csrfToken);
        }else{
            return this.lambderSessionManager.isSessionValid(session, sessionToken, null, true);
        }
    };

    async updateSessionData (newData: any): Promise<LambderSessionContext> {
        if(!this.ctx.session) throw new Error("Session not found.");
        this.ctx.session = await this.lambderSessionManager.updateSessionData(this.ctx.session, newData);
        return this.ctx.session;
    };

    /**
     * Force-runs the dataRefresh callback now (see the session option of create) and
     * persists the result onto the current session. Returns the updated
     * session, or null when the callback ended it: the record is deleted and
     * the session cookies are cleared.
     */
    async refreshSessionData (): Promise<LambderSessionContext<TSessionData>|null> {
        if(!this.ctx.session) throw new Error("Session not found.");
        const refreshed = await this.lambderSessionManager.refreshSessionData(this.ctx.session);
        if(!refreshed){
            this.clearSessionCookies();
            (this.ctx as any).session = null;
            return null;
        }
        this.ctx.session = refreshed;
        return this.ctx.session;
    };

    /**
     * Deletes every session of the given sessionKey (e.g. a user id): "log
     * this subject out everywhere". Unlike endSessionAll it needs no fetched
     * session and touches no cookies, so it works on any subject.
     */
    async deleteSessionAllByKey (sessionKey: string): Promise<void> {
        await this.lambderSessionManager.deleteSessionAllByKey(sessionKey);
    };

    /**
     * Marks the data of every session of the given sessionKey stale, so each
     * renews via dataRefresh on its next read: the way to apply a change to
     * a subject's roles or permissions immediately, without logging them
     * out. Needs no fetched session; requires dataRefresh.
     */
    async expireSessionDataAllByKey (sessionKey: string): Promise<void> {
        await this.lambderSessionManager.expireSessionDataAllByKey(sessionKey);
    };

    async endSession (){
        if(!this.ctx.session) throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSession(this.ctx.session);
        this.clearSessionCookies();
        (this.ctx as any).session = null;
    };

    async endSessionAll (){
        if(!this.ctx.session) throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSessionAll(this.ctx.session);
        this.clearSessionCookies();
        (this.ctx as any).session = null;
    };
};

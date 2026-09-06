import { LambderRenderContext, LambderSessionRenderContext } from "../core/LambderContext.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import { LambderSessionDataRefreshError, LambderSessionReadError, type LambderCreatedSession, type LambderSessionContext } from "./LambderSessionManager.js";

export type LambderSessionCookieOptions = {
    /**
     * e.g. ".example.com" to share sessions across subdomains. Pass a function to
     * derive it from the request hostname when one deployment serves several
     * apex domains; return undefined for a host-only cookie.
     */
    domain?: string | ((hostname: string) => string | undefined | null);
    path?: string;
    sameSite?: "Strict" | "Lax" | "None";
    secure?: boolean;
};

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

    private buildCookie(key: string, value: string, expiresAtMs: number, httpOnly: boolean): string {
        const { domain, path = "/", sameSite = "Lax", secure = true } = this.cookieOptions;
        // Host header can carry a port; browsers match the Domain attribute on hostname only.
        const hostname = (this.ctx.host || "").split(":")[0];
        const resolvedDomain = typeof domain === "function" ? domain(hostname) : domain;
        const parts = [
            `${key}=${value}`,
            `Expires=${new Date(expiresAtMs).toUTCString()}`,
            `Path=${path}`,
            ...(resolvedDomain ? [`Domain=${resolvedDomain}`] : []),
            ...(httpOnly ? ["HttpOnly"] : []),
            `SameSite=${sameSite}`,
            ...(secure ? ["Secure"] : []),
        ];
        return parts.join("; ");
    };

    /** Raw secrets exist only on the LambderCreatedSession result and in these cookies; the record stores hashes. */
    private setSessionCookies(created: LambderCreatedSession<TSessionData>): void {
        const expiresAtMs = created.session.expiresAt * 1000;
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionTokenCookieKey, created.sessionToken, expiresAtMs, true) });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionCsrfCookieKey, created.csrfToken, expiresAtMs, false) });
    };

    private clearSessionCookies(): void {
        const expired = Date.now() - 100000;
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionTokenCookieKey, "0", expired, true) });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionCsrfCookieKey, "0", expired, false) });
    };

    private areRequestSessionTokensValid(): boolean {
        const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
        const isSessionTokenValid = !!sessionToken && sessionToken.split(":").length === 2;

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

        const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
        if(!sessionToken) throw new Error("Session token not found");
        
        const session = await this.lambderSessionManager.getSession(sessionToken);
        if(!session) throw new Error("Session not found");
        
        if(!this.isSessionValid(session)) throw new Error("Invalid session");
        this.ctx.session = session;
        return session;
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

    isSessionValid(session: any): boolean {
        if(this.ctx._otherInternal.isApiCall){
            const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
            const csrfToken = this.ctx.post?.token;
            return this.lambderSessionManager.isSessionValid(session, sessionToken, csrfToken);
        }else{
            const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
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
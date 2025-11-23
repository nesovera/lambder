import { LambderRenderContext, LambderSessionRenderContext } from "./LambderContext.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import type { LambderSessionContext } from "./LambderSessionManager.js";

export default class LambderSessionController<TSessionData = any> {
    lambderSessionManager: LambderSessionManager;
    sessionTokenCookieKey: string;
    sessionCsrfCookieKey: string;
    ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>; // Internal context with mutable session property

    constructor(
        { 
            lambderSessionManager,
            sessionTokenCookieKey,
            sessionCsrfCookieKey,
            ctx,
        }: {
            lambderSessionManager: LambderSessionManager,
            sessionTokenCookieKey: string,
            sessionCsrfCookieKey: string,
            ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>,
        }
    ){
        this.lambderSessionManager = lambderSessionManager;
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
        this.ctx = ctx;
    };

    private areRequestSessionTokensValid(): boolean {
        const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
        const isSessionTokenValid = sessionToken && sessionToken?.split(":")?.length === 2;

        if(this.ctx._otherInternal.isApiCall){
            const csrfToken = this.ctx.post?.token;
            const isCsrfTokenValid = typeof csrfToken === "string" && csrfToken.length > 0
            return isSessionTokenValid && isCsrfTokenValid;
        }else{
            return isSessionTokenValid;
        }
    };

    async createSession (sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderSessionContext<TSessionData>> {
        const session = await this.lambderSessionManager.createSession(sessionKey, data, ttlInSeconds);
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionTokenCookieKey}=${session.sessionToken}; Expires=${new Date(session.expiresAt * 1000).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure` });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionCsrfCookieKey}=${session.csrfToken}; Expires=${new Date(session.expiresAt * 1000).toUTCString()}; Path=/; SameSite=Lax; Secure` });
        this.ctx.session = session;
        return this.ctx.session;
    };

    async regenerateSession (): Promise<LambderSessionContext<TSessionData>> {
        if(!this.ctx.session) throw new Error("Session not found.");
        const newSession = await this.lambderSessionManager.regenerateSession(this.ctx.session);
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionTokenCookieKey}=${newSession.sessionToken}; Expires=${new Date(newSession.expiresAt * 1000).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure` });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionCsrfCookieKey}=${newSession.csrfToken}; Expires=${new Date(newSession.expiresAt * 1000).toUTCString()}; Path=/; SameSite=Lax; Secure` });
        this.ctx.session = newSession;
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

    async fetchSessionIfExists (): Promise<LambderSessionContext|null> {
        try {
            return await this.fetchSession();
        }catch(err){
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

    async endSession (){
        if(!this.ctx.session) throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSession(this.ctx.session);
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionTokenCookieKey}=0; Expires=${new Date(Date.now() - 100000).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure` });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionCsrfCookieKey}=0; Expires=${new Date(Date.now() - 100000).toUTCString()}; Path=/; SameSite=Lax; Secure` });
        (this.ctx as any).session = null;
    };

    async endSessionAll (){
        if(!this.ctx.session) throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSessionAll(this.ctx.session);
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionTokenCookieKey}=0; Expires=${new Date(Date.now() - 100000).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure` });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionCsrfCookieKey}=0; Expires=${new Date(Date.now() - 100000).toUTCString()}; Path=/; SameSite=Lax; Secure` });
        (this.ctx as any).session = null;
    };
};
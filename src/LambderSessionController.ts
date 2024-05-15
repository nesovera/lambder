import { LambderRenderContext } from "./Lambder.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import type { LambderSessionContext } from "./LambderSessionManager.js";

export default class LambderSessionController {
    lambderSessionManager: LambderSessionManager;
    sessionTokenCookieKey: string;
    ctx: LambderRenderContext;

    constructor(
        { 
            lambderSessionManager,
            sessionTokenCookieKey,
            ctx,
        }: {
            lambderSessionManager: LambderSessionManager,
            sessionTokenCookieKey: string,
            ctx: LambderRenderContext,
        }
    ){
        this.ctx = ctx;
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.lambderSessionManager = lambderSessionManager;
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

    async createSession (sessionKey: string, data?: any, ttlInSeconds?: number): Promise<LambderSessionContext> {
        this.ctx.session = await this.lambderSessionManager.createSession(sessionKey, data, ttlInSeconds);
        return this.ctx.session;
    };

    async fetchSession (): Promise<LambderSessionContext>{
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
        this.ctx.session = null
    };

    async endSessionAll (){
        if(!this.ctx.session) throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSessionAll(this.ctx.session);
        this.ctx.session = null
    };
};
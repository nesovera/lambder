import { LambderRenderContext, LambderSessionRenderContext } from "./LambderContext.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import type { LambderSessionContext } from "./LambderSessionManager.js";
export type LambderSessionCookieOptions = {
    /** e.g. ".example.com" to share sessions across subdomains. */
    domain?: string;
    path?: string;
    sameSite?: "Strict" | "Lax" | "None";
    secure?: boolean;
};
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
    private buildCookie;
    private setSessionCookies;
    private clearSessionCookies;
    private areRequestSessionTokensValid;
    createSession(sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderSessionContext<TSessionData>>;
    regenerateSession(): Promise<LambderSessionContext<TSessionData>>;
    fetchSession(): Promise<LambderSessionContext<TSessionData>>;
    fetchSessionIfExists(): Promise<LambderSessionContext | null>;
    isSessionValid(session: any): boolean;
    updateSessionData(newData: any): Promise<LambderSessionContext>;
    endSession(): Promise<void>;
    endSessionAll(): Promise<void>;
}

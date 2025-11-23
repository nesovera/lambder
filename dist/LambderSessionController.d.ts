import { LambderRenderContext, LambderSessionRenderContext } from "./Lambder.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import type { LambderSessionContext } from "./LambderSessionManager.js";
export default class LambderSessionController<TSessionData = any> {
    lambderSessionManager: LambderSessionManager;
    sessionTokenCookieKey: string;
    sessionCsrfCookieKey: string;
    ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>;
    constructor({ lambderSessionManager, sessionTokenCookieKey, sessionCsrfCookieKey, ctx, }: {
        lambderSessionManager: LambderSessionManager;
        sessionTokenCookieKey: string;
        sessionCsrfCookieKey: string;
        ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>;
    });
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

import { LambderRenderContext } from "./Lambder.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import type { LambderSessionContext } from "./LambderSessionManager.js";
export default class LambderSessionController {
    lambderSessionManager: LambderSessionManager;
    sessionTokenCookieKey: string;
    sessionCsrfCookieKey: string;
    ctx: LambderRenderContext<any>;
    constructor({ lambderSessionManager, sessionTokenCookieKey, sessionCsrfCookieKey, ctx, }: {
        lambderSessionManager: LambderSessionManager;
        sessionTokenCookieKey: string;
        sessionCsrfCookieKey: string;
        ctx: LambderRenderContext<any>;
    });
    private areRequestSessionTokensValid;
    createSession(sessionKey: string, data?: any, ttlInSeconds?: number): Promise<LambderSessionContext>;
    regenerateSession(): Promise<LambderSessionContext>;
    fetchSession(): Promise<LambderSessionContext>;
    fetchSessionIfExists(): Promise<LambderSessionContext | null>;
    isSessionValid(session: any): boolean;
    updateSessionData(newData: any): Promise<LambderSessionContext>;
    endSession(): Promise<void>;
    endSessionAll(): Promise<void>;
}

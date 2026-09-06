import { LambderRenderContext, LambderSessionRenderContext } from "../core/LambderContext.js";
import type LambderSessionManager from "./LambderSessionManager.js";
import { type LambderSessionContext } from "./LambderSessionManager.js";
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
    ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>;
    constructor({ lambderSessionManager, sessionTokenCookieKey, sessionCsrfCookieKey, cookieOptions, ctx, }: {
        lambderSessionManager: LambderSessionManager;
        sessionTokenCookieKey: string;
        sessionCsrfCookieKey: string;
        cookieOptions?: LambderSessionCookieOptions;
        ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>;
    });
    private buildCookie;
    /** Raw secrets exist only on the LambderCreatedSession result and in these cookies; the record stores hashes. */
    private setSessionCookies;
    private clearSessionCookies;
    private areRequestSessionTokensValid;
    createSession(sessionKey: string, data?: TSessionData, ttlInSeconds?: number): Promise<LambderSessionContext<TSessionData>>;
    regenerateSession(): Promise<LambderSessionContext<TSessionData>>;
    fetchSession(): Promise<LambderSessionContext<TSessionData>>;
    fetchSessionIfExists(): Promise<LambderSessionContext<TSessionData> | null>;
    isSessionValid(session: any): boolean;
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
    endSession(): Promise<void>;
    endSessionAll(): Promise<void>;
}

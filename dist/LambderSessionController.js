export default class LambderSessionController {
    lambderSessionManager;
    sessionTokenCookieKey;
    sessionCsrfCookieKey;
    cookieOptions;
    ctx; // Internal context with mutable session property
    constructor({ lambderSessionManager, sessionTokenCookieKey, sessionCsrfCookieKey, cookieOptions, ctx, }) {
        this.lambderSessionManager = lambderSessionManager;
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
        this.cookieOptions = cookieOptions ?? {};
        this.ctx = ctx;
    }
    ;
    buildCookie(key, value, expiresAtMs, httpOnly) {
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
    }
    ;
    setSessionCookies(session) {
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionTokenCookieKey, session.sessionToken, session.expiresAt * 1000, true) });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionCsrfCookieKey, session.csrfToken, session.expiresAt * 1000, false) });
    }
    ;
    clearSessionCookies() {
        const expired = Date.now() - 100000;
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionTokenCookieKey, "0", expired, true) });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionCsrfCookieKey, "0", expired, false) });
    }
    ;
    areRequestSessionTokensValid() {
        const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
        const isSessionTokenValid = !!sessionToken && sessionToken.split(":").length === 2;
        if (this.ctx._otherInternal.isApiCall) {
            const csrfToken = this.ctx.post?.token;
            const isCsrfTokenValid = typeof csrfToken === "string" && csrfToken.length > 0;
            return isSessionTokenValid && isCsrfTokenValid;
        }
        else {
            return isSessionTokenValid;
        }
    }
    ;
    async createSession(sessionKey, data, ttlInSeconds) {
        const session = await this.lambderSessionManager.createSession(sessionKey, data, ttlInSeconds);
        this.setSessionCookies(session);
        this.ctx.session = session;
        return this.ctx.session;
    }
    ;
    async regenerateSession() {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        const newSession = await this.lambderSessionManager.regenerateSession(this.ctx.session);
        this.setSessionCookies(newSession);
        this.ctx.session = newSession;
        return this.ctx.session;
    }
    ;
    async fetchSession() {
        if (!this.areRequestSessionTokensValid()) {
            throw new Error("Session tokens are invalid");
        }
        const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
        if (!sessionToken)
            throw new Error("Session token not found");
        const session = await this.lambderSessionManager.getSession(sessionToken);
        if (!session)
            throw new Error("Session not found");
        if (!this.isSessionValid(session))
            throw new Error("Invalid session");
        this.ctx.session = session;
        return session;
    }
    ;
    async fetchSessionIfExists() {
        try {
            return await this.fetchSession();
        }
        catch (err) {
            return null;
        }
    }
    ;
    isSessionValid(session) {
        if (this.ctx._otherInternal.isApiCall) {
            const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
            const csrfToken = this.ctx.post?.token;
            return this.lambderSessionManager.isSessionValid(session, sessionToken, csrfToken);
        }
        else {
            const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
            return this.lambderSessionManager.isSessionValid(session, sessionToken, null, true);
        }
    }
    ;
    async updateSessionData(newData) {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        this.ctx.session = await this.lambderSessionManager.updateSessionData(this.ctx.session, newData);
        return this.ctx.session;
    }
    ;
    async endSession() {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSession(this.ctx.session);
        this.clearSessionCookies();
        this.ctx.session = null;
    }
    ;
    async endSessionAll() {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSessionAll(this.ctx.session);
        this.clearSessionCookies();
        this.ctx.session = null;
    }
    ;
}
;

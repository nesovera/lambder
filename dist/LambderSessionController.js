export default class LambderSessionController {
    lambderSessionManager;
    sessionTokenCookieKey;
    sessionCsrfCookieKey;
    ctx; // Internal context with mutable session property
    constructor({ lambderSessionManager, sessionTokenCookieKey, sessionCsrfCookieKey, ctx, }) {
        this.lambderSessionManager = lambderSessionManager;
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
        this.ctx = ctx;
    }
    ;
    areRequestSessionTokensValid() {
        const sessionToken = this.ctx.cookie?.[this.sessionTokenCookieKey];
        const isSessionTokenValid = sessionToken && sessionToken?.split(":")?.length === 2;
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
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionTokenCookieKey}=${session.sessionToken}; Expires=${new Date(session.expiresAt * 1000).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure` });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionCsrfCookieKey}=${session.csrfToken}; Expires=${new Date(session.expiresAt * 1000).toUTCString()}; Path=/; SameSite=Lax; Secure` });
        this.ctx.session = session;
        return this.ctx.session;
    }
    ;
    async regenerateSession() {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        const newSession = await this.lambderSessionManager.regenerateSession(this.ctx.session);
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionTokenCookieKey}=${newSession.sessionToken}; Expires=${new Date(newSession.expiresAt * 1000).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure` });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionCsrfCookieKey}=${newSession.csrfToken}; Expires=${new Date(newSession.expiresAt * 1000).toUTCString()}; Path=/; SameSite=Lax; Secure` });
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
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionTokenCookieKey}=0; Expires=${new Date(Date.now() - 100000).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure` });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionCsrfCookieKey}=0; Expires=${new Date(Date.now() - 100000).toUTCString()}; Path=/; SameSite=Lax; Secure` });
        this.ctx.session = null;
    }
    ;
    async endSessionAll() {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSessionAll(this.ctx.session);
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionTokenCookieKey}=0; Expires=${new Date(Date.now() - 100000).toUTCString()}; Path=/; HttpOnly; SameSite=Lax; Secure` });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: `${this.sessionCsrfCookieKey}=0; Expires=${new Date(Date.now() - 100000).toUTCString()}; Path=/; SameSite=Lax; Secure` });
        this.ctx.session = null;
    }
    ;
}
;

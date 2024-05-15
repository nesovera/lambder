export default class LambderSessionController {
    lambderSessionManager;
    sessionTokenCookieKey;
    ctx;
    constructor({ lambderSessionManager, sessionTokenCookieKey, ctx, }) {
        this.ctx = ctx;
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.lambderSessionManager = lambderSessionManager;
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
        this.ctx.session = await this.lambderSessionManager.createSession(sessionKey, data, ttlInSeconds);
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
        this.ctx.session = null;
    }
    ;
    async endSessionAll() {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        await this.lambderSessionManager.deleteSessionAll(this.ctx.session);
        this.ctx.session = null;
    }
    ;
}
;

import { LambderSessionDataRefreshError, LambderSessionReadError } from "./LambderSessionManager.js";
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
    /** Raw secrets exist only on the LambderCreatedSession result and in these cookies; the record stores hashes. */
    setSessionCookies(created) {
        const expiresAtMs = created.session.expiresAt * 1000;
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionTokenCookieKey, created.sessionToken, expiresAtMs, true) });
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key: "Set-Cookie", value: this.buildCookie(this.sessionCsrfCookieKey, created.csrfToken, expiresAtMs, false) });
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
        const created = await this.lambderSessionManager.createSession(sessionKey, data, ttlInSeconds);
        this.setSessionCookies(created);
        this.ctx.session = created.session;
        return this.ctx.session;
    }
    ;
    async regenerateSession() {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        const created = await this.lambderSessionManager.regenerateSession(this.ctx.session);
        this.setSessionCookies(created);
        this.ctx.session = created.session;
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
            // Missing or invalid sessions become null, but a failing
            // dataRefresh callback or a DynamoDB read failure must not
            // masquerade as a logout.
            if (err instanceof LambderSessionDataRefreshError)
                throw err;
            if (err instanceof LambderSessionReadError)
                throw err;
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
    /**
     * Force-runs the dataRefresh callback now (see the session option of create) and
     * persists the result onto the current session. Returns the updated
     * session, or null when the callback ended it: the record is deleted and
     * the session cookies are cleared.
     */
    async refreshSessionData() {
        if (!this.ctx.session)
            throw new Error("Session not found.");
        const refreshed = await this.lambderSessionManager.refreshSessionData(this.ctx.session);
        if (!refreshed) {
            this.clearSessionCookies();
            this.ctx.session = null;
            return null;
        }
        this.ctx.session = refreshed;
        return this.ctx.session;
    }
    ;
    /**
     * Deletes every session of the given sessionKey (e.g. a user id): "log
     * this subject out everywhere". Unlike endSessionAll it needs no fetched
     * session and touches no cookies, so it works on any subject.
     */
    async deleteSessionAllByKey(sessionKey) {
        await this.lambderSessionManager.deleteSessionAllByKey(sessionKey);
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

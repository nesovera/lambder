import Cookies from 'js-cookie';
export default class LambderCaller {
    isCorsEnabled;
    apiPath;
    apiVersion;
    timeoutMs;
    fetchTrackerList = [];
    isLoading = false;
    versionExpiredHandler;
    sessionExpiredHandler;
    messageHandler;
    errorMessageHandler;
    notAuthorizedHandler;
    errorHandler;
    apiInputValidationErrorHandler;
    fetchStartedHandler;
    fetchEndedHandler;
    sessionTokenCookieKey = "LMDRSESSIONTKID";
    sessionCsrfCookieKey = "LMDRSESSIONCSTK";
    sessionCookieDomain;
    constructor({ apiPath, apiVersion, isCorsEnabled = false, timeoutMs, versionExpiredHandler, sessionExpiredHandler, messageHandler, errorMessageHandler, notAuthorizedHandler, errorHandler, fetchStartedHandler, fetchEndedHandler, apiInputValidationErrorHandler, sessionCookieDomain, }) {
        this.apiPath = apiPath ?? "/api";
        this.apiVersion = apiVersion;
        this.isCorsEnabled = isCorsEnabled;
        this.timeoutMs = timeoutMs;
        this.sessionCookieDomain = sessionCookieDomain;
        this.versionExpiredHandler = versionExpiredHandler;
        this.sessionExpiredHandler = sessionExpiredHandler;
        this.messageHandler = messageHandler;
        this.errorMessageHandler = errorMessageHandler;
        this.notAuthorizedHandler = notAuthorizedHandler;
        this.errorHandler = errorHandler;
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;
        this.fetchStartedHandler = fetchStartedHandler;
        this.fetchEndedHandler = fetchEndedHandler;
    }
    ;
    setSessionCookieKey(sessionTokenCookieKey, sessionCsrfCookieKey) {
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
    }
    /**
     * A self-rotating idempotency key for a component or form that performs
     * the same logical operation repeatedly. `current` is the key for the
     * operation in progress: send it with every attempt (first try, retry
     * after a failure, double-tap) so the server collapses them. Call
     * `rotate()` after a confirmed success so the next operation is a new
     * intent with its own key.
     *
     * ```typescript
     * const submitKey = LambderCaller.createIdempotencyKeyScope();
     * await caller.api("order.create", payload, { idempotencyKey: submitKey.current });
     * submitKey.rotate();
     * ```
     */
    static createIdempotencyKeyScope() {
        let key = LambderCaller.createIdempotencyKey();
        return {
            get current() { return key; },
            rotate() { key = LambderCaller.createIdempotencyKey(); return key; },
        };
    }
    /**
     * Generate an idempotency key for one logical operation. Create it when
     * the operation begins (a form opens, a draft starts), send the same key
     * on every attempt of that operation, and generate a new one after a
     * confirmed success. Uses crypto.randomUUID when available and falls back
     * to a v4 UUID from getRandomValues, because randomUUID only exists in
     * secure contexts (plain-http LAN device testing lacks it).
     */
    static createIdempotencyKey() {
        const cryptoObj = globalThis.crypto;
        if (cryptoObj?.randomUUID)
            return cryptoObj.randomUUID();
        const bytes = new Uint8Array(16);
        if (cryptoObj?.getRandomValues) {
            cryptoObj.getRandomValues(bytes);
        }
        else {
            for (let i = 0; i < 16; i += 1) {
                bytes[i] = Math.floor(Math.random() * 256);
            }
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    clearSessionCookies() {
        const domainOption = this.sessionCookieDomain;
        const hostname = typeof window !== "undefined" ? window.location.hostname : "";
        const resolvedDomain = typeof domainOption === "function" ? domainOption(hostname) : domainOption;
        for (const key of [this.sessionTokenCookieKey, this.sessionCsrfCookieKey]) {
            // Host-only and domain-scoped cookies are distinct entries; clear both.
            Cookies.remove(key);
            if (resolvedDomain)
                Cookies.remove(key, { domain: resolvedDomain, path: "/" });
        }
    }
    /** One call, one outcome. Never throws; every failure path resolves to { ok: false }. */
    async dispatch(apiName, payload, options) {
        // Per-call overrides win over the constructor handlers.
        const versionExpiredHandler = options?.versionExpiredHandler ?? this.versionExpiredHandler;
        const sessionExpiredHandler = options?.sessionExpiredHandler ?? this.sessionExpiredHandler;
        const messageHandler = options?.messageHandler ?? this.messageHandler;
        const errorMessageHandler = options?.errorMessageHandler ?? this.errorMessageHandler;
        const notAuthorizedHandler = options?.notAuthorizedHandler ?? this.notAuthorizedHandler;
        const errorHandler = options?.errorHandler ?? this.errorHandler;
        const apiInputValidationErrorHandler = options?.apiInputValidationErrorHandler ?? this.apiInputValidationErrorHandler;
        const fetchStartedHandler = options?.fetchStartedHandler ?? this.fetchStartedHandler;
        const fetchEndedHandler = options?.fetchEndedHandler ?? this.fetchEndedHandler;
        const headers = options?.headers;
        const fetchTracker = { apiName, done: false, fetchEndCalled: false };
        const fetchEnded = async (fetchResult) => {
            fetchTracker.done = true;
            if (fetchTracker.fetchEndCalled || !fetchEndedHandler)
                return;
            fetchTracker.fetchEndCalled = true;
            await fetchEndedHandler({
                fetchParams: { apiName, payload, headers },
                fetchResult,
                activeFetchList: this.fetchTrackerList.filter(v => !v.done),
            });
        };
        let errorHandlerCalled = false;
        const reportError = async (err) => {
            if (errorHandlerCalled || !errorHandler)
                return;
            errorHandlerCalled = true;
            await errorHandler(err);
        };
        // Timeout / abort wiring: the timeout gets its own controller chained
        // to any external signal, so either source aborts the fetch.
        const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
        const externalSignal = options?.signal;
        let timedOut = false;
        let signal = externalSignal;
        let timeoutId;
        if (timeoutMs !== undefined) {
            const controller = new AbortController();
            if (externalSignal) {
                if (externalSignal.aborted) {
                    controller.abort(externalSignal.reason);
                }
                else {
                    externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
                }
            }
            timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
            signal = controller.signal;
        }
        try {
            this.fetchTrackerList.push(fetchTracker);
            if (fetchStartedHandler)
                await fetchStartedHandler({
                    fetchParams: { apiName, payload, headers, },
                    activeFetchList: this.fetchTrackerList.filter(v => !v.done)
                });
            const version = this.apiVersion;
            const token = Cookies.get(this.sessionCsrfCookieKey) || "";
            const siteHost = window.location.hostname;
            let res;
            try {
                res = await fetch(this.apiPath, {
                    method: 'POST', cache: 'no-cache',
                    // Cross-origin API hosts need CORS mode and included credentials.
                    mode: this.isCorsEnabled ? 'cors' : 'same-origin',
                    credentials: this.isCorsEnabled ? 'include' : 'same-origin',
                    redirect: 'follow', referrerPolicy: 'origin',
                    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
                    body: JSON.stringify({
                        apiName, version, token, siteHost, payload,
                        ...(options?.guardInputs !== undefined ? { guardInputs: options.guardInputs } : {}),
                        ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
                    }),
                    ...(signal ? { signal } : {}),
                });
            }
            catch (err) {
                const wrappedError = err instanceof Error ? err : new Error("Request failed", { cause: err });
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
                return { ok: false, reason: timedOut ? 'timeout' : 'network', error: wrappedError };
            }
            if (res.status >= 500) {
                // Lambder's own 500 fallback is a JSON envelope, but custom
                // error handlers may answer text/HTML: parse defensively.
                let errorMessage;
                try {
                    const bodyText = await res.text();
                    try {
                        errorMessage = JSON.parse(bodyText)?.errorMessage;
                    }
                    catch { /* not an envelope */ }
                }
                catch { /* body unavailable */ }
                const wrappedError = new Error("Request failed: " + res.status + " - " + res.statusText);
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
                return { ok: false, reason: 'server', status: res.status, errorMessage, error: wrappedError };
            }
            if (res.status === 422) {
                // A 422 without Lambder's validation body (e.g. a proxy's
                // error page) is a server failure, not a validation result.
                let zodError;
                try {
                    zodError = (await res.json())?.zodError;
                }
                catch { /* not JSON */ }
                if (zodError === undefined) {
                    const wrappedError = new Error("Request failed: 422 without a validation body");
                    await fetchEnded(wrappedError);
                    await reportError(wrappedError);
                    return { ok: false, reason: 'server', status: res.status, error: wrappedError };
                }
                await fetchEnded(null);
                if (apiInputValidationErrorHandler) {
                    await apiInputValidationErrorHandler(zodError);
                }
                else {
                    await reportError(new Error("API Input Validation Error", { cause: zodError }));
                }
                return { ok: false, reason: 'validation', status: res.status, zodError };
            }
            let data;
            try {
                data = await res.json();
                if (data === null || typeof data !== "object")
                    throw new Error("Response is not an object");
            }
            catch (err) {
                // A non-envelope body (e.g. an HTML error page) is a server failure.
                const wrappedError = new Error("Request failed: response is not a valid API envelope (status " + res.status + ")", { cause: err });
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
                return { ok: false, reason: 'server', status: res.status, error: wrappedError };
            }
            await fetchEnded(data);
            if (data.logList?.length) {
                for (const record of data.logList) {
                    console.log("[lambder]", record);
                }
            }
            if (data.versionExpired) {
                if (versionExpiredHandler) {
                    await versionExpiredHandler();
                }
                else {
                    await reportError(new Error("Version Expired; Please refresh;"));
                }
                return { ok: false, reason: 'versionExpired', status: res.status, errorMessage: data.errorMessage, response: data };
            }
            if (data.sessionExpired) {
                this.clearSessionCookies();
                if (sessionExpiredHandler) {
                    await sessionExpiredHandler();
                }
                else {
                    await reportError(new Error("Session Expired; Please log in again;"));
                }
                return { ok: false, reason: 'sessionExpired', status: res.status, errorMessage: data.errorMessage, response: data };
            }
            if (data.notAuthorized) {
                if (notAuthorizedHandler) {
                    await notAuthorizedHandler();
                }
                else {
                    await reportError(new Error("Not Authorized;"));
                }
                return { ok: false, reason: 'notAuthorized', status: res.status, errorMessage: data.errorMessage, response: data };
            }
            if (data.message && messageHandler) {
                await messageHandler(data.message);
            }
            if (data.errorMessage) {
                if (errorMessageHandler) {
                    await errorMessageHandler(data.errorMessage);
                }
                return { ok: false, reason: 'errorMessage', status: res.status, errorMessage: data.errorMessage, response: data };
            }
            return { ok: true, payload: data.payload, response: data };
        }
        catch (err) {
            // Escape hatch for anything above (typically an app handler throwing):
            // dispatch never throws, so api()/apiOutcome() call sites never do.
            const wrappedError = err instanceof Error ? err : new Error("Error: ", { cause: err });
            try {
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
            }
            catch { /* an app handler threw again; never propagate */ }
            return { ok: false, reason: 'unknown', error: wrappedError };
        }
        finally {
            fetchTracker.done = true;
            if (timeoutId !== undefined)
                clearTimeout(timeoutId);
        }
    }
    ;
    /**
     * Full-fidelity call: resolves to a discriminated LambderApiOutcome
     * instead of collapsing every failure to null. Never throws.
     */
    async apiOutcome(apiName, payload, ...rest) {
        return await this.dispatch(apiName, payload, rest[0]);
    }
    ;
    /** Payload on success, null/undefined otherwise (indistinguishable from a null payload; prefer apiOutcome() when that matters). */
    async api(apiName, payload, ...rest) {
        const outcome = await this.dispatch(apiName, payload, rest[0]);
        if (outcome.ok)
            return outcome.response?.payload;
        return outcome.reason === 'errorMessage' ? outcome.response?.payload : undefined;
    }
}

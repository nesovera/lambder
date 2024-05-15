import Cookies from 'js-cookie';
export default class LambderCaller {
    isCorsEnabled;
    apiPath;
    apiVersion;
    fetchTrackerList = [];
    isLoading = false;
    versionExpiredHandler;
    sessionExpiredHandler;
    messageHandler;
    errorMessageHandler;
    notAuthorizedHandler;
    errorHandler;
    fetchStartedHandler;
    fetchEndedHandler;
    sessionTokenCookieKey = "LMDRSESSIONTKID";
    sessionCsrfCookieKey = "LMDRSESSIONCSTK";
    constructor({ apiPath, apiVersion, isCorsEnabled = false, versionExpiredHandler, sessionExpiredHandler, messageHandler, errorMessageHandler, notAuthorizedHandler, errorHandler, fetchStartedHandler, fetchEndedHandler, }) {
        this.apiPath = apiPath ?? "/api";
        this.apiVersion = apiVersion;
        this.isCorsEnabled = isCorsEnabled;
        this.versionExpiredHandler = versionExpiredHandler;
        this.sessionExpiredHandler = sessionExpiredHandler;
        this.messageHandler = messageHandler;
        this.errorMessageHandler = errorMessageHandler;
        this.notAuthorizedHandler = notAuthorizedHandler;
        this.errorHandler = errorHandler;
        this.fetchStartedHandler = fetchStartedHandler;
        this.fetchEndedHandler = fetchEndedHandler;
    }
    ;
    setSessionCookieKey(sessionTokenCookieKey, sessionCsrfCookieKey) {
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
    }
    async apiRaw(apiName, payload, options) {
        const headers = options?.headers;
        const fetchTracker = { apiName, done: false, fetchEndCalled: false };
        try {
            this.fetchTrackerList.push(fetchTracker);
            if (this.fetchStartedHandler)
                await this.fetchStartedHandler({
                    fetchParams: { apiName, payload, headers, },
                    activeFetchList: this.fetchTrackerList.filter(v => !v.done)
                });
            const version = this.apiVersion;
            const token = Cookies.get(this.sessionCsrfCookieKey) || "";
            const siteHost = window.location.hostname;
            let data = await fetch(this.apiPath, {
                method: 'POST', mode: 'same-origin', cache: 'no-cache',
                credentials: 'same-origin', redirect: 'follow', referrerPolicy: 'origin',
                headers: { 'Content-Type': 'application/json', ...(headers || {}) },
                body: JSON.stringify({ apiName, version, token, siteHost, payload, }),
            }).then(res => {
                if (res.status >= 500)
                    throw new Error("Request failed: " + res.status + " - " + res.statusText);
                return res.json();
            });
            fetchTracker.done = true;
            if (this.fetchEndedHandler) {
                fetchTracker.fetchEndCalled = true;
                await this.fetchEndedHandler({
                    fetchParams: { apiName, payload, headers },
                    fetchResult: data,
                    activeFetchList: this.fetchTrackerList.filter(v => !v.done),
                });
            }
            if (data && data.versionExpired) {
                if (this.versionExpiredHandler) {
                    await this.versionExpiredHandler();
                }
                else if (this.errorHandler) {
                    await this.errorHandler(new Error("Version Expired; Please refresh;"));
                }
                return null;
            }
            if (data && data.sessionExpired) {
                Cookies.set(this.sessionTokenCookieKey, '', { expires: -1 });
                Cookies.set(this.sessionCsrfCookieKey, '', { expires: -1 });
                if (this.sessionExpiredHandler) {
                    await this.sessionExpiredHandler();
                }
                else if (this.errorHandler) {
                    await this.errorHandler(new Error("Version Expired; Please refresh;"));
                }
                return null;
            }
            if (data && data.notAuthorized) {
                if (this.notAuthorizedHandler) {
                    await this.notAuthorizedHandler();
                }
                else if (this.errorHandler) {
                    await this.errorHandler(new Error("Version Expired; Please refresh;"));
                }
                return null;
            }
            if (data && data.message && this.messageHandler) {
                await this.messageHandler(data.message);
            }
            if (data && data.errorMessage && this.errorMessageHandler) {
                await this.errorMessageHandler(data.errorMessage);
            }
            return data;
        }
        catch (err) {
            const wrappedError = err instanceof Error ? err : new Error("Error: " + String(err));
            fetchTracker.done = true;
            if (!fetchTracker.fetchEndCalled && this.fetchEndedHandler) {
                await this.fetchEndedHandler({
                    fetchParams: { apiName, payload, headers, },
                    fetchResult: wrappedError,
                    activeFetchList: this.fetchTrackerList.filter(v => !v.done)
                });
            }
            if (this.errorHandler) {
                this.errorHandler(wrappedError);
            }
            return null;
        }
    }
    ;
    // Use the same type for api but adjust the return type
    async api(...params) {
        const result = await this.apiRaw(...params);
        return result?.payload;
    }
}

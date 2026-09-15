/**
 * The one mapping from an HTTP answer to an API outcome.
 *
 * LambderCaller (a browser, over fetch) and LambderInvokeCaller (a server,
 * over a direct Lambda invoke) receive the same envelope and must read it
 * the same way: which status is a crash, which is a rejected input, in what
 * order the envelope flags are honoured, what a non-envelope body means.
 * Both hand their answer to resolveApiOutcome and act on the result; the
 * side effects each has (handlers, cookie clearing, error reporting) stay
 * with the caller that owns them. Pure and dependency-free, so the browser
 * entry resolves it.
 */
/**
 * Reads one HTTP answer into an outcome. A 5xx is a server failure that keeps
 * the envelope when the server sent one (Lambder's own 500 body carries
 * errorMessage, and a global error handler may add crash and logList); a
 * 422 is a validation failure only with Lambder's validation body; anything
 * else must be a JSON envelope, whose flags are honoured in a fixed order.
 */
export const resolveApiOutcome = async (answer) => {
    const status = answer.status;
    if (status >= 500) {
        // Lambder's own 500 fallback is a JSON envelope, but custom error
        // handlers may answer text/HTML: parse defensively.
        let envelope;
        try {
            const bodyText = await answer.text();
            try {
                const parsed = JSON.parse(bodyText);
                if (parsed !== null && typeof parsed === "object")
                    envelope = parsed;
            }
            catch { /* not an envelope */ }
        }
        catch { /* body unavailable */ }
        return {
            ok: false, reason: 'server', status,
            errorMessage: envelope?.errorMessage,
            logList: envelope?.logList,
            ...(envelope ? { response: envelope } : {}),
            error: new Error("Request failed: " + status + " - " + (answer.statusText ?? "")),
        };
    }
    if (status === 422) {
        // A 422 without Lambder's validation body (e.g. a proxy's error page)
        // is a server failure, not a validation result.
        // The validation body carries the call's logList as every other
        // answer does, so it is read here rather than left on the wire.
        let body;
        try {
            body = await answer.json();
        }
        catch { /* not JSON */ }
        const zodError = body?.zodError;
        if (zodError === undefined) {
            return { ok: false, reason: 'server', status, error: new Error("Request failed: 422 without a validation body") };
        }
        return { ok: false, reason: 'validation', status, zodError, logList: body?.logList };
    }
    // Retry-After (delta-seconds) rides every refusal that knows its reset
    // time, e.g. a rate limit; absent or unreadable is undefined.
    const retryAfterValue = Number(answer.header("retry-after") ?? NaN);
    const retryAfter = Number.isFinite(retryAfterValue) && retryAfterValue >= 0 ? { retryAfterSeconds: retryAfterValue } : {};
    let data;
    try {
        data = await answer.json();
        if (data === null || typeof data !== "object")
            throw new Error("Response is not an object");
    }
    catch (err) {
        // A non-envelope body (e.g. an HTML error page) is a server failure.
        return { ok: false, reason: 'server', status, error: new Error("Request failed: response is not a valid API envelope (status " + status + ")", { cause: err }) };
    }
    if (data.versionExpired)
        return { ok: false, reason: 'versionExpired', status, errorMessage: data.errorMessage, response: data, logList: data.logList, ...retryAfter };
    if (data.sessionExpired)
        return { ok: false, reason: 'sessionExpired', status, errorMessage: data.errorMessage, response: data, logList: data.logList, ...retryAfter };
    if (data.notAuthorized)
        return { ok: false, reason: 'notAuthorized', status, errorMessage: data.errorMessage, response: data, logList: data.logList, ...retryAfter };
    // Presence, not truthiness: the writer keeps an errorMessage an app spelled
    // out as the empty string, so a refusal that says nothing is still a
    // refusal. Tested for truth here, it shipped back as a success.
    if (data.errorMessage !== undefined)
        return { ok: false, reason: 'errorMessage', status, errorMessage: data.errorMessage, response: data, logList: data.logList, ...retryAfter };
    return { ok: true, payload: data.payload, response: data, logList: data.logList };
};

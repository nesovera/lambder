/**
 * The one mapping from an HTTP answer to an API outcome.
 *
 * LambderCaller (a browser, over fetch) and LambderInvokeCaller (a server,
 * over a Lambda invoke) receive the same envelope and must read it
 * the same way: which status is a crash, which is a rejected input, in what
 * order the envelope flags are honoured, what a non-envelope body means.
 * Both hand their answer to resolveApiOutcome and act on the result; their
 * side effects (handlers, cookie clearing, error reporting) stay with them.
 * Pure and dependency-free, so the browser entry can include it.
 */
import { refusalMessageOf } from "./LambderApiRefusal.js";
import { isObjectPayload } from "./LambderObjectPayload.js";
/**
 * Whether a parsed body is Lambder's envelope, which always carries
 * apiVersion (null when the server set none). An object without it is
 * somebody else's answer: API Gateway's own errors ({"message": ...} on a
 * 413, a throttle, a WAF or missing-route 403, an authorizer 401, a 502 from
 * a crashed function), a proxy's, a load balancer's.
 */
const isApiEnvelope = (value) => value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "apiVersion");
/**
 * Reads one HTTP answer into an outcome. A 5xx is a server failure that keeps
 * the envelope when the server sent one (Lambder's own 500 body carries
 * refusal, and a global error handler may add crash and logList); a
 * 422 is a validation failure only with Lambder's validation body; anything
 * else must be a JSON envelope, whose flags are honoured in a fixed order.
 * A failure read off any answer but a 422 carries the answer's Retry-After
 * as retryAfterSeconds.
 *
 * A success is a 2xx envelope with no flag and no refusal whose payload
 * is an object or an array: what only a handler's parsed output is. Anything
 * else that says nothing is wrong (a null or primitive payload a hand-built
 * body, a proxy or an old stored answer carries) is a server failure, so a
 * success's payload is always the contract's output and never falsy.
 *
 * TMessage is the endpoint's refusal message type: the reader cannot check
 * a code against declarations it does not have, and relies on the server,
 * which never sends a code the endpoint did not declare.
 */
export const resolveApiOutcome = async (answer) => {
    const status = answer.status;
    const refusalOf = (envelope) => envelope?.refusal !== undefined ? { refusal: refusalMessageOf(envelope.refusal) } : {};
    // Retry-After (delta-seconds) rides every refusal that knows its reset
    // time, e.g. a rate limit, and a 503 that says when to come back; absent
    // or unreadable is undefined.
    const retryAfterValue = Number(answer.header("retry-after") ?? NaN);
    const retryAfter = Number.isFinite(retryAfterValue) && retryAfterValue >= 0 ? { retryAfterSeconds: retryAfterValue } : {};
    if (status >= 500) {
        // Lambder's own 500 fallback is a JSON envelope, but custom error
        // handlers may answer text or HTML, and a gateway in front answers
        // JSON of its own: parse defensively, and keep only the envelope, so
        // a foreign body's fields never read as the app's message or crash.
        let envelope;
        try {
            const bodyText = await answer.text();
            try {
                const parsed = JSON.parse(bodyText);
                if (isApiEnvelope(parsed))
                    envelope = parsed;
            }
            catch { /* not JSON */ }
        }
        catch { /* body unavailable */ }
        return {
            ok: false, reason: 'server', status,
            ...refusalOf(envelope),
            logList: envelope?.logList,
            ...(envelope ? { response: envelope } : {}),
            error: new Error("Request failed: " + status + " - " + (answer.statusText ?? "")),
            ...retryAfter,
        };
    }
    if (status === 422) {
        // A 422 without Lambder's validation body (e.g. a proxy's error page)
        // is a server failure, not a validation result. The validation body
        // carries the call's logList like every other answer, so it is read.
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
    let data;
    try {
        data = await answer.json();
        if (data === null || typeof data !== "object")
            throw new Error("Response is not an object");
    }
    catch (err) {
        // A non-envelope body (e.g. an HTML error page) is a server failure.
        return { ok: false, reason: 'server', status, error: new Error("Request failed: response is not a valid API envelope (status " + status + ")", { cause: err }), ...retryAfter };
    }
    // Read as envelopes, a gateway's own JSON errors would resolve as
    // successes with no payload, so a refused save would look saved.
    if (!isApiEnvelope(data)) {
        const gatewayMessage = typeof data.message === "string" ? `: ${data.message}` : "";
        return { ok: false, reason: 'server', status, error: new Error(`Request failed: ${status} - the answer is not a Lambder envelope${gatewayMessage}`), ...retryAfter };
    }
    const asRefusal = data;
    if (data.versionExpired)
        return { ok: false, reason: 'versionExpired', status, ...refusalOf(data), response: asRefusal, logList: data.logList, ...retryAfter };
    if (data.sessionExpired)
        return { ok: false, reason: 'sessionExpired', status, ...refusalOf(data), response: asRefusal, logList: data.logList, ...retryAfter };
    if (data.notAuthorized)
        return { ok: false, reason: 'notAuthorized', status, ...refusalOf(data), response: asRefusal, logList: data.logList, ...retryAfter };
    // Presence, not truthiness: the writer keeps a refusal an app set
    // to the empty string, and a refusal that says nothing is still a
    // refusal, not a success.
    if (data.refusal !== undefined)
        return { ok: false, reason: 'refusal', status, refusal: refusalMessageOf(data.refusal), response: asRefusal, logList: data.logList, ...retryAfter };
    // An envelope that says nothing is wrong is still not a success when the
    // status says otherwise, nor when its payload is not what a handler
    // answers. Neither is a refusal either, so neither carries the body as
    // one: the error says what it was.
    if (status < 200 || status >= 300) {
        return { ok: false, reason: 'server', status, logList: data.logList, error: new Error(`Request failed: ${status} - ${answer.statusText ?? ""}`), ...retryAfter };
    }
    if (!isObjectPayload(data.payload)) {
        return { ok: false, reason: 'server', status, logList: data.logList, error: new Error("Request failed: the answer's payload is not an object or an array, so no handler of this API wrote it") };
    }
    return { ok: true, payload: data.payload, response: data, logList: data.logList };
};

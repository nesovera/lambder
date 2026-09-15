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

import type { z } from "zod";
import type { LambderApiEnvelopeBody } from "./LambderApiContract.js";
import type { LambderAppRefusalMessage } from "./LambderApiRefusal.js";

/**
 * The 422 body's `zodError` as it survives JSON: a ZodError's name and
 * message, and its issues spelled out. Not a ZodError instance (it has no
 * methods on this side of the wire), which is why it is not typed as one.
 */
export type LambderValidationError = { name: string; message: string; issues: z.core.$ZodIssue[] };

export type LambderApiFailureReason =
    | 'network'          // the request never got an answer: offline, DNS, CORS, an external abort, a rejected invoke
    | 'timeout'          // aborted by the configured timeoutMs
    | 'server'           // HTTP 5xx, or a response body that is not the API envelope
    | 'validation'       // HTTP 422: the server rejected the input schema
    | 'versionExpired'   // envelope flag: client version behind the server
    | 'sessionExpired'   // envelope flag: session gone (cookies cleared)
    | 'notAuthorized'    // envelope flag: authenticated but not allowed
    | 'errorMessage'     // structured refusal on the envelope's errorMessage field
    | 'unknown';         // unexpected internal failure (e.g. an app handler threw)

/** A call that produced an answer the server means as a result. */
export type LambderApiSuccessOutcome<T> = {
    ok: true;
    payload: T | null | undefined;
    response: LambderApiEnvelopeBody<T>;
    /** The answer's logList, when it carried one. See LambderApiFailureFields.logList: the field is on every arm so a caller surfaces logs once. */
    logList?: unknown[];
};

/** What every failure carries, whatever went wrong. */
type LambderApiFailureFields = {
    ok: false;
    /** HTTP status, when a response was received. */
    status?: number;
    /** Envelope errorMessage, when the server provided one. */
    errorMessage?: LambderAppRefusalMessage | string;
    /** Seconds to wait before retrying, from the response's Retry-After header (rate-limit refusals send it). */
    retryAfterSeconds?: number;
    /**
     * The answer's logList, when it carried one: the envelope's on a success
     * or an envelope refusal, the parsed 500 body's on a server failure, and
     * the validation body's on a 422 (the server writes it there too). It is
     * on every arm so that a caller surfaces logs in ONE place, right after
     * reading the answer, instead of once per outcome it happens to handle:
     * the browser caller surfaced them after its early returns and so never
     * printed the logs of the answer whose logs matter most, a 500.
     */
    logList?: unknown[];
};

/**
 * No result came back to read: the request never completed, it was given up
 * on, the server failed, or something inside the caller threw. Always carries
 * the Error, so a reader that narrowed this far never has to check for it.
 * A 5xx also carries `response` when the server answered with Lambder's own
 * envelope, which is how a crash detail and a logList arrive with it.
 */
export type LambderApiCallFailure<T> = LambderApiFailureFields & {
    reason: 'network' | 'timeout' | 'server' | 'unknown';
    error: Error;
    response?: LambderApiEnvelopeBody<T>;
};

/** HTTP 422: the server rejected the input against the API's schema. Always carries the issues. */
export type LambderApiValidationFailure = LambderApiFailureFields & {
    reason: 'validation';
    zodError: LambderValidationError;
};

/** The server answered, and the envelope itself says the call is refused. Always carries that envelope. */
export type LambderApiEnvelopeFailure<T> = LambderApiFailureFields & {
    reason: 'versionExpired' | 'sessionExpired' | 'notAuthorized' | 'errorMessage';
    response: LambderApiEnvelopeBody<T>;
};

/**
 * Discriminated result of an API call: `ok: true` carries the payload, every
 * failure carries a machine-readable reason, so "the server returned null"
 * and "the request failed" are never conflated.
 *
 * The failure side is discriminated by `reason` rather than being one arm of
 * optional fields, so narrowing to a reason narrows to what that reason
 * actually carries: `zodError` after `reason === 'validation'`, `response`
 * after an envelope reason, `error` after the rest. Read as one wide arm, the
 * framework's own reader needed three non-null assertions to say what the
 * union already knew.
 */
export type LambderApiOutcome<T> =
    | LambderApiSuccessOutcome<T>
    | LambderApiCallFailure<T>
    | LambderApiValidationFailure
    | LambderApiEnvelopeFailure<T>;

/**
 * What reading one HTTP answer can produce. Narrower than LambderApiOutcome
 * by the three reasons no answer can carry: `network` and `timeout` belong to
 * the caller's own abort, and `unknown` to something throwing around the
 * call. So a caller that has handled `server` and `validation` holds a
 * success or an envelope refusal, both of which carry the envelope.
 */
export type LambderApiAnswerOutcome<T> =
    | LambderApiSuccessOutcome<T>
    | (LambderApiCallFailure<T> & { reason: 'server' })
    | LambderApiValidationFailure
    | LambderApiEnvelopeFailure<T>;

/**
 * What the mapping needs from an HTTP answer, whichever transport produced it.
 *
 * Exactly one of `json()` and `text()` is read per answer, never both: a
 * transport backed by a real Response body may only be read once, and the
 * mapping is written to that rule (a 5xx reads text and parses it itself, so
 * that a non-envelope body is still reportable).
 */
export type LambderApiHttpAnswer = {
    status: number;
    statusText?: string;
    /** Case-insensitive header lookup; null or undefined when absent. */
    header: (name: string) => string | null | undefined;
    /** The body parsed as JSON; rejects when it is not JSON. */
    json: () => Promise<unknown>;
    /** The body as text. */
    text: () => Promise<string>;
    /** The answer's Set-Cookie header values, for a transport that can see them (a cookie jar consumes them); absent in a browser. */
    setCookies?: string[];
};

/**
 * Reads one HTTP answer into an outcome. A 5xx is a server failure that keeps
 * the envelope when the server sent one (Lambder's own 500 body carries
 * errorMessage, and a global error handler may add crash and logList); a
 * 422 is a validation failure only with Lambder's validation body; anything
 * else must be a JSON envelope, whose flags are honoured in a fixed order.
 */
export const resolveApiOutcome = async <T>(answer: LambderApiHttpAnswer): Promise<LambderApiAnswerOutcome<T>> => {
    const status = answer.status;

    if(status >= 500){
        // Lambder's own 500 fallback is a JSON envelope, but custom error
        // handlers may answer text/HTML: parse defensively.
        let envelope: LambderApiEnvelopeBody<T> | undefined;
        try {
            const bodyText = await answer.text();
            try {
                const parsed = JSON.parse(bodyText);
                if(parsed !== null && typeof parsed === "object") envelope = parsed as LambderApiEnvelopeBody<T>;
            } catch { /* not an envelope */ }
        } catch { /* body unavailable */ }
        return {
            ok: false, reason: 'server', status,
            errorMessage: envelope?.errorMessage,
            logList: envelope?.logList,
            ...(envelope ? { response: envelope } : {}),
            error: new Error("Request failed: " + status + " - " + (answer.statusText ?? "")),
        };
    }

    if(status === 422){
        // A 422 without Lambder's validation body (e.g. a proxy's error page)
        // is a server failure, not a validation result.
        // The validation body carries the call's logList as every other
        // answer does, so it is read here rather than left on the wire.
        let body: { zodError?: LambderValidationError; logList?: unknown[] } | null | undefined;
        try { body = await answer.json() as { zodError?: LambderValidationError; logList?: unknown[] } | null; }
        catch { /* not JSON */ }
        const zodError = body?.zodError;
        if(zodError === undefined){
            return { ok: false, reason: 'server', status, error: new Error("Request failed: 422 without a validation body") };
        }
        return { ok: false, reason: 'validation', status, zodError, logList: body?.logList };
    }

    // Retry-After (delta-seconds) rides every refusal that knows its reset
    // time, e.g. a rate limit; absent or unreadable is undefined.
    const retryAfterValue = Number(answer.header("retry-after") ?? NaN);
    const retryAfter = Number.isFinite(retryAfterValue) && retryAfterValue >= 0 ? { retryAfterSeconds: retryAfterValue } : {};

    let data: LambderApiEnvelopeBody<T>;
    try {
        data = await answer.json() as LambderApiEnvelopeBody<T>;
        if(data === null || typeof data !== "object") throw new Error("Response is not an object");
    }catch(err){
        // A non-envelope body (e.g. an HTML error page) is a server failure.
        return { ok: false, reason: 'server', status, error: new Error("Request failed: response is not a valid API envelope (status " + status + ")", { cause: err }) };
    }

    if(data.versionExpired) return { ok: false, reason: 'versionExpired', status, errorMessage: data.errorMessage, response: data, logList: data.logList, ...retryAfter };
    if(data.sessionExpired) return { ok: false, reason: 'sessionExpired', status, errorMessage: data.errorMessage, response: data, logList: data.logList, ...retryAfter };
    if(data.notAuthorized) return { ok: false, reason: 'notAuthorized', status, errorMessage: data.errorMessage, response: data, logList: data.logList, ...retryAfter };
    // Presence, not truthiness: the writer keeps an errorMessage an app spelled
    // out as the empty string, so a refusal that says nothing is still a
    // refusal. Tested for truth here, it shipped back as a success.
    if(data.errorMessage !== undefined) return { ok: false, reason: 'errorMessage', status, errorMessage: data.errorMessage, response: data, logList: data.logList, ...retryAfter };
    return { ok: true, payload: data.payload, response: data, logList: data.logList };
};

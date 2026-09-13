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
import type { LambderApiResponse } from "./LambderApiContract.js";

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

/**
 * Discriminated result of an API call: `ok: true` carries the payload, every
 * failure carries a machine-readable reason, so "the server returned null"
 * and "the request failed" are never conflated.
 */
export type LambderApiOutcome<T> =
    | { ok: true; payload: T | null | undefined; response: LambderApiResponse<T> }
    | {
        ok: false;
        reason: LambderApiFailureReason;
        /** HTTP status, when a response was received. */
        status?: number;
        /** Envelope errorMessage, when the server provided one. */
        errorMessage?: any;
        /** Seconds to wait before retrying, from the response's Retry-After header (rate-limit refusals send it). */
        retryAfterSeconds?: number;
        /** Underlying Error for network/timeout/server/unknown failures. */
        error?: Error;
        /** The issues for 'validation'. */
        zodError?: LambderValidationError;
        /** The parsed envelope, when one was received (protocol-level failures, and a 5xx that answered with Lambder's own envelope). */
        response?: LambderApiResponse<T>;
    };

/** What the mapping needs from an HTTP answer, whichever transport produced it. */
export type LambderApiHttpAnswer = {
    status: number;
    statusText?: string;
    /** Case-insensitive header lookup; null or undefined when absent. */
    header: (name: string) => string | null | undefined;
    /** The body parsed as JSON; rejects when it is not JSON. */
    json: () => Promise<unknown>;
    /** The body as text. */
    text: () => Promise<string>;
};

/**
 * Reads one HTTP answer into an outcome. A 5xx is a server failure that keeps
 * the envelope when the server sent one (Lambder's own 500 body carries
 * errorMessage, and a global error handler may add crash and logList); a
 * 422 is a validation failure only with Lambder's validation body; anything
 * else must be a JSON envelope, whose flags are honoured in a fixed order.
 */
export const resolveApiOutcome = async <T>(answer: LambderApiHttpAnswer): Promise<LambderApiOutcome<T>> => {
    const status = answer.status;

    if(status >= 500){
        // Lambder's own 500 fallback is a JSON envelope, but custom error
        // handlers may answer text/HTML: parse defensively.
        let envelope: LambderApiResponse<T> | undefined;
        try {
            const bodyText = await answer.text();
            try {
                const parsed = JSON.parse(bodyText);
                if(parsed !== null && typeof parsed === "object") envelope = parsed as LambderApiResponse<T>;
            } catch { /* not an envelope */ }
        } catch { /* body unavailable */ }
        return {
            ok: false, reason: 'server', status,
            errorMessage: envelope?.errorMessage,
            ...(envelope ? { response: envelope } : {}),
            error: new Error("Request failed: " + status + " - " + (answer.statusText ?? "")),
        };
    }

    if(status === 422){
        // A 422 without Lambder's validation body (e.g. a proxy's error page)
        // is a server failure, not a validation result.
        let zodError: LambderValidationError | undefined;
        try { zodError = (await answer.json() as { zodError?: LambderValidationError } | null)?.zodError; }
        catch { /* not JSON */ }
        if(zodError === undefined){
            return { ok: false, reason: 'server', status, error: new Error("Request failed: 422 without a validation body") };
        }
        return { ok: false, reason: 'validation', status, zodError };
    }

    // Retry-After (delta-seconds) rides every refusal that knows its reset
    // time, e.g. a rate limit; absent or unreadable is undefined.
    const retryAfterValue = Number(answer.header("retry-after") ?? NaN);
    const retryAfter = Number.isFinite(retryAfterValue) && retryAfterValue >= 0 ? { retryAfterSeconds: retryAfterValue } : {};

    let data: LambderApiResponse<T>;
    try {
        data = await answer.json() as LambderApiResponse<T>;
        if(data === null || typeof data !== "object") throw new Error("Response is not an object");
    }catch(err){
        // A non-envelope body (e.g. an HTML error page) is a server failure.
        return { ok: false, reason: 'server', status, error: new Error("Request failed: response is not a valid API envelope (status " + status + ")", { cause: err }) };
    }

    if(data.versionExpired) return { ok: false, reason: 'versionExpired', status, errorMessage: data.errorMessage, response: data, ...retryAfter };
    if(data.sessionExpired) return { ok: false, reason: 'sessionExpired', status, errorMessage: data.errorMessage, response: data, ...retryAfter };
    if(data.notAuthorized) return { ok: false, reason: 'notAuthorized', status, errorMessage: data.errorMessage, response: data, ...retryAfter };
    if(data.errorMessage) return { ok: false, reason: 'errorMessage', status, errorMessage: data.errorMessage, response: data, ...retryAfter };
    return { ok: true, payload: data.payload, response: data };
};

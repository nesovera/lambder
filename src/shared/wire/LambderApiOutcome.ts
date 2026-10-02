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

import type { z } from "zod";
import type { LambderApiRefusalEnvelope, LambderApiSuccessEnvelope } from "./LambderApiContract.js";
import { refusalMessageOf, type LambderUncheckedRefusalMessage } from "./LambderApiRefusal.js";
import { isObjectPayload } from "./LambderObjectPayload.js";

/**
 * The 422 body's `zodError` as it survives JSON: a ZodError's name and
 * message, and its issues spelled out. Not a ZodError instance (it has no
 * methods on this side of the wire), which is why it is not typed as one.
 */
export type LambderValidationError = { name: string; message: string; issues: z.core.$ZodIssue[] };

export type LambderApiFailureReason =
    | 'network'          // the request never got an answer: offline, DNS, CORS, a rejected invoke
    | 'timeout'          // aborted by the configured timeoutMs
    | 'aborted'          // aborted by the call's own signal: the site gave the call up, which nothing reports as a failure
    | 'server'           // HTTP 5xx, or a response body that is not the API envelope
    | 'validation'       // HTTP 422: the server rejected the input schema
    | 'versionExpired'   // envelope flag: the client was built against another shape of the endpoint (its signature did not match)
    | 'sessionExpired'   // envelope flag: session gone (cookies cleared)
    | 'notAuthorized'    // envelope flag: authenticated but not allowed
    | 'refusal'     // structured refusal on the envelope's refusal field
    | 'unknown';         // unexpected internal failure (e.g. an app handler threw)

/**
 * The endpoint's handler answered: `payload` is its output, parsed through
 * the API's output schema on the server, exactly the contract's type. Only a
 * handler's answer reads as a success: everything else the server writes
 * into an API call is a refusal (see LambderApiRefusalConfig), and a reader
 * refuses a success whose payload is not an object (see isObjectPayload).
 */
export type LambderApiSuccessOutcome<T> = {
    ok: true;
    payload: T;
    response: LambderApiSuccessEnvelope<T>;
    /** The answer's logList, when it carried one. See LambderApiFailureFields.logList: the field is on every arm so a caller surfaces logs once. */
    logList?: unknown[];
};

/**
 * What every failure carries, whatever went wrong. TMessage is the refusal
 * message the endpoint can answer with (LambderContractRefusalMessage), on
 * every arm: a refusal flagged notAuthorized arrives as that reason and still
 * carries its message.
 */
type LambderApiFailureFields<TMessage extends LambderUncheckedRefusalMessage> = {
    ok: false;
    /** HTTP status, when a response was received. */
    status?: number;
    /** The envelope's refusal, when the server provided one: always the message object, a plain string having been read as one (refusalMessageOf). */
    refusal?: TMessage;
    /** Seconds to wait before retrying, from the response's Retry-After header (rate-limit refusals send it, and so may a 503). */
    retryAfterSeconds?: number;
    /**
     * The answer's logList, when it carried one: the envelope's on a success
     * or an envelope refusal, the parsed 500 body's on a server failure, and
     * the validation body's on a 422. It is on every arm so a caller surfaces
     * logs in ONE place, right after reading the answer, rather than per
     * outcome, where early returns would skip the logs that matter most: a
     * 500's.
     */
    logList?: unknown[];
};

/**
 * No result came back to read: the request never completed, it was given up
 * on (by its timeout, or by the site through its signal), the server failed,
 * or something inside the caller threw. Always carries the Error, so a reader
 * that narrowed this far never has to check for it. A 5xx also carries
 * `response` when the server answered with Lambder's own envelope, which is
 * how a crash detail and a logList arrive with it.
 */
export type LambderApiCallFailure<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = LambderApiFailureFields<TMessage> & {
    reason: 'network' | 'timeout' | 'aborted' | 'server' | 'unknown';
    error: Error;
    response?: LambderApiRefusalEnvelope;
};

/** HTTP 422: the server rejected the input against the API's schema. Always carries the issues. */
export type LambderApiValidationFailure<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = LambderApiFailureFields<TMessage> & {
    reason: 'validation';
    zodError: LambderValidationError;
};

/** The server answered, and the envelope itself says the call is refused. Always carries that envelope, and a `refusal` failure always carries the refusal. */
export type LambderApiEnvelopeFailure<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = LambderApiFailureFields<TMessage> & {
    response: LambderApiRefusalEnvelope;
} & (
    | { reason: 'versionExpired' | 'sessionExpired' | 'notAuthorized' }
    | { reason: 'refusal'; refusal: TMessage }
);

/**
 * The failure side of an API call's outcome, every arm of it: what a failure
 * handler is handed beside the error it reports (LambderCaller's
 * errorHandler), and what a site that keeps a failure to act on later holds.
 * Discriminated by `reason` like the outcome itself.
 */
export type LambderApiFailure<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> =
    | LambderApiCallFailure<TMessage>
    | LambderApiValidationFailure<TMessage>
    | LambderApiEnvelopeFailure<TMessage>;

/**
 * Discriminated result of an API call: `ok: true` carries the handler's
 * output, every failure carries a machine-readable reason, so "the server
 * answered" and "the request failed" are never conflated.
 *
 * The failure side is discriminated by `reason`, so narrowing to a reason
 * narrows to what it carries: `zodError` after `reason === 'validation'`,
 * `response` after an envelope reason, `error` after the rest, with no
 * non-null assertion needed. TMessage is the endpoint's refusal message
 * (LambderContractRefusalMessage), which `refusal.code` narrows.
 */
export type LambderApiOutcome<T, TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> =
    | LambderApiSuccessOutcome<T>
    | LambderApiFailure<TMessage>;

/**
 * What reading one HTTP answer can produce: LambderApiOutcome minus the
 * four reasons no answer carries (`network` is no answer at all, `timeout`
 * and `aborted` are the caller giving up on one, `unknown` is something
 * throwing around the call). A caller that has handled `server` and
 * `validation` holds a success or an envelope refusal, both of which carry
 * the envelope.
 */
export type LambderApiAnswerOutcome<T, TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> =
    | LambderApiSuccessOutcome<T>
    | (LambderApiCallFailure<TMessage> & { reason: 'server' })
    | LambderApiValidationFailure<TMessage>
    | LambderApiEnvelopeFailure<TMessage>;

/**
 * What the mapping needs from an HTTP answer, whichever transport produced it.
 *
 * Exactly one of `json()` and `text()` is read per answer, since a real
 * Response body may only be read once (a 5xx reads text and parses it
 * itself, so a non-envelope body is still reportable).
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
    /**
     * The CSRF tokens of a transport that keeps the session's cookies itself
     * (a cookie jar), where document.cookie is not where they live: the one
     * it posted, and a read of the one it holds now. LambderCaller judges
     * whether a sessionExpired is about the session the page still holds by
     * these; absent, it compares document.cookie before and after the call.
     */
    csrfTokens?: { posted: string; held: () => string };
};

/**
 * An envelope as it is read, before it is told apart: every field either
 * kind may carry, each as it came off the wire.
 */
type LambderApiEnvelopeRead = {
    apiVersion: string | null;
    payload?: unknown;
    versionExpired?: unknown;
    sessionExpired?: unknown;
    notAuthorized?: unknown;
    refusal?: unknown;
    logList?: unknown[];
    crash?: unknown;
};

/**
 * Whether a parsed body is Lambder's envelope, which always carries
 * apiVersion (null when the server set none). An object without it is
 * somebody else's answer: API Gateway's own errors ({"message": ...} on a
 * 413, a throttle, a WAF or missing-route 403, an authorizer 401, a 502 from
 * a crashed function), a proxy's, a load balancer's.
 */
const isApiEnvelope = (value: unknown): value is LambderApiEnvelopeRead =>
    value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "apiVersion");

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
export const resolveApiOutcome = async <T, TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage>(answer: LambderApiHttpAnswer): Promise<LambderApiAnswerOutcome<T, TMessage>> => {
    const status = answer.status;
    const refusalOf = (envelope: LambderApiEnvelopeRead | undefined): { refusal?: TMessage } =>
        envelope?.refusal !== undefined ? { refusal: refusalMessageOf(envelope.refusal) as TMessage } : {};
    // Retry-After (delta-seconds) rides every refusal that knows its reset
    // time, e.g. a rate limit, and a 503 that says when to come back; absent
    // or unreadable is undefined.
    const retryAfterValue = Number(answer.header("retry-after") ?? NaN);
    const retryAfter = Number.isFinite(retryAfterValue) && retryAfterValue >= 0 ? { retryAfterSeconds: retryAfterValue } : {};

    if(status >= 500){
        // Lambder's own 500 fallback is a JSON envelope, but custom error
        // handlers may answer text or HTML, and a gateway in front answers
        // JSON of its own: parse defensively, and keep only the envelope, so
        // a foreign body's fields never read as the app's message or crash.
        let envelope: LambderApiEnvelopeRead | undefined;
        try {
            const bodyText = await answer.text();
            try {
                const parsed: unknown = JSON.parse(bodyText);
                if(isApiEnvelope(parsed)) envelope = parsed;
            } catch { /* not JSON */ }
        } catch { /* body unavailable */ }
        return {
            ok: false, reason: 'server', status,
            ...refusalOf(envelope),
            logList: envelope?.logList,
            ...(envelope ? { response: envelope as LambderApiRefusalEnvelope } : {}),
            error: new Error("Request failed: " + status + " - " + (answer.statusText ?? "")),
            ...retryAfter,
        };
    }

    if(status === 422){
        // A 422 without Lambder's validation body (e.g. a proxy's error page)
        // is a server failure, not a validation result. The validation body
        // carries the call's logList like every other answer, so it is read.
        let body: { zodError?: LambderValidationError; logList?: unknown[] } | null | undefined;
        try { body = await answer.json() as { zodError?: LambderValidationError; logList?: unknown[] } | null; }
        catch { /* not JSON */ }
        const zodError = body?.zodError;
        if(zodError === undefined){
            return { ok: false, reason: 'server', status, error: new Error("Request failed: 422 without a validation body") };
        }
        return { ok: false, reason: 'validation', status, zodError, logList: body?.logList };
    }

    let data: unknown;
    try {
        data = await answer.json();
        if(data === null || typeof data !== "object") throw new Error("Response is not an object");
    }catch(err){
        // A non-envelope body (e.g. an HTML error page) is a server failure.
        return { ok: false, reason: 'server', status, error: new Error("Request failed: response is not a valid API envelope (status " + status + ")", { cause: err }), ...retryAfter };
    }

    // Read as envelopes, a gateway's own JSON errors would resolve as
    // successes with no payload, so a refused save would look saved.
    if(!isApiEnvelope(data)){
        const gatewayMessage = typeof (data as { message?: unknown }).message === "string" ? `: ${(data as { message: string }).message}` : "";
        return { ok: false, reason: 'server', status, error: new Error(`Request failed: ${status} - the answer is not a Lambder envelope${gatewayMessage}`), ...retryAfter };
    }

    const asRefusal = data as LambderApiRefusalEnvelope;
    if(data.versionExpired) return { ok: false, reason: 'versionExpired', status, ...refusalOf(data), response: asRefusal, logList: data.logList, ...retryAfter };
    if(data.sessionExpired) return { ok: false, reason: 'sessionExpired', status, ...refusalOf(data), response: asRefusal, logList: data.logList, ...retryAfter };
    if(data.notAuthorized) return { ok: false, reason: 'notAuthorized', status, ...refusalOf(data), response: asRefusal, logList: data.logList, ...retryAfter };
    // Presence, not truthiness: the writer keeps a refusal an app set
    // to the empty string, and a refusal that says nothing is still a
    // refusal, not a success.
    if(data.refusal !== undefined) return { ok: false, reason: 'refusal', status, refusal: refusalMessageOf(data.refusal) as TMessage, response: asRefusal, logList: data.logList, ...retryAfter };
    // An envelope that says nothing is wrong is still not a success when the
    // status says otherwise, nor when its payload is not what a handler
    // answers. Neither is a refusal either, so neither carries the body as
    // one: the error says what it was.
    if(status < 200 || status >= 300){
        return { ok: false, reason: 'server', status, logList: data.logList, error: new Error(`Request failed: ${status} - ${answer.statusText ?? ""}`), ...retryAfter };
    }
    if(!isObjectPayload(data.payload)){
        return { ok: false, reason: 'server', status, logList: data.logList, error: new Error("Request failed: the answer's payload is not an object or an array, so no handler of this API wrote it") };
    }
    return { ok: true, payload: data.payload as T, response: data as LambderApiSuccessEnvelope<T>, logList: data.logList };
};

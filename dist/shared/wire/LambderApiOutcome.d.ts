/**
 * The one mapping from an HTTP answer to an API outcome.
 *
 * LambderCaller (a browser, over fetch) and LambderInvokeCaller (a server,
 * over a direct Lambda invoke) receive the same envelope and must read it
 * the same way: which status is a crash, which is a rejected input, in what
 * order the envelope flags are honoured, what a non-envelope body means.
 * Both hand their answer to resolveApiOutcome and act on the result; their
 * side effects (handlers, cookie clearing, error reporting) stay with them.
 * Pure and dependency-free, so the browser entry can include it.
 */
import type { z } from "zod";
import type { LambderApiEnvelopeBody } from "./LambderApiContract.js";
import { type LambderAppRefusalMessage } from "./LambderApiRefusal.js";
/**
 * The 422 body's `zodError` as it survives JSON: a ZodError's name and
 * message, and its issues spelled out. Not a ZodError instance (it has no
 * methods on this side of the wire), which is why it is not typed as one.
 */
export type LambderValidationError = {
    name: string;
    message: string;
    issues: z.core.$ZodIssue[];
};
export type LambderApiFailureReason = 'network' | 'timeout' | 'server' | 'validation' | 'versionExpired' | 'sessionExpired' | 'notAuthorized' | 'errorMessage' | 'unknown';
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
    /** Envelope errorMessage, when the server provided one: always the message object, a plain string having been read as one (refusalMessageOf). */
    errorMessage?: LambderAppRefusalMessage;
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
/** The server answered, and the envelope itself says the call is refused. Always carries that envelope, and an `errorMessage` refusal always carries its message. */
export type LambderApiEnvelopeFailure<T> = LambderApiFailureFields & {
    response: LambderApiEnvelopeBody<T>;
} & ({
    reason: 'versionExpired' | 'sessionExpired' | 'notAuthorized';
} | {
    reason: 'errorMessage';
    errorMessage: LambderAppRefusalMessage;
});
/**
 * Discriminated result of an API call: `ok: true` carries the payload, every
 * failure carries a machine-readable reason, so "the server returned null"
 * and "the request failed" are never conflated.
 *
 * The failure side is discriminated by `reason`, so narrowing to a reason
 * narrows to what it carries: `zodError` after `reason === 'validation'`,
 * `response` after an envelope reason, `error` after the rest, with no
 * non-null assertion needed.
 */
export type LambderApiOutcome<T> = LambderApiSuccessOutcome<T> | LambderApiCallFailure<T> | LambderApiValidationFailure | LambderApiEnvelopeFailure<T>;
/**
 * What reading one HTTP answer can produce: LambderApiOutcome minus the
 * three reasons no answer carries (`network` and `timeout` are the caller's
 * own abort, `unknown` is something throwing around the call). A caller that
 * has handled `server` and `validation` holds a success or an envelope
 * refusal, both of which carry the envelope.
 */
export type LambderApiAnswerOutcome<T> = LambderApiSuccessOutcome<T> | (LambderApiCallFailure<T> & {
    reason: 'server';
}) | LambderApiValidationFailure | LambderApiEnvelopeFailure<T>;
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
    csrfTokens?: {
        posted: string;
        held: () => string;
    };
};
/**
 * Reads one HTTP answer into an outcome. A 5xx is a server failure that keeps
 * the envelope when the server sent one (Lambder's own 500 body carries
 * errorMessage, and a global error handler may add crash and logList); a
 * 422 is a validation failure only with Lambder's validation body; anything
 * else must be a JSON envelope, whose flags are honoured in a fixed order.
 * A failure read off any answer but a 422 carries the answer's Retry-After
 * as retryAfterSeconds.
 */
export declare const resolveApiOutcome: <T>(answer: LambderApiHttpAnswer) => Promise<LambderApiAnswerOutcome<T>>;
export {};

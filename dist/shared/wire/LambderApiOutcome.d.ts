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
import { type LambderUncheckedRefusalMessage } from "./LambderApiRefusal.js";
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
export type LambderApiFailureReason = 'network' | 'timeout' | 'aborted' | 'server' | 'validation' | 'versionExpired' | 'sessionExpired' | 'notAuthorized' | 'refusal' | 'unknown';
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
} & ({
    reason: 'versionExpired' | 'sessionExpired' | 'notAuthorized';
} | {
    reason: 'refusal';
    refusal: TMessage;
});
/**
 * The failure side of an API call's outcome, every arm of it: what a failure
 * handler is handed beside the error it reports (LambderCaller's
 * errorHandler), and what a site that keeps a failure to act on later holds.
 * Discriminated by `reason` like the outcome itself.
 */
export type LambderApiFailure<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = LambderApiCallFailure<TMessage> | LambderApiValidationFailure<TMessage> | LambderApiEnvelopeFailure<TMessage>;
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
export type LambderApiOutcome<T, TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = LambderApiSuccessOutcome<T> | LambderApiFailure<TMessage>;
/**
 * What reading one HTTP answer can produce: LambderApiOutcome minus the
 * four reasons no answer carries (`network` is no answer at all, `timeout`
 * and `aborted` are the caller giving up on one, `unknown` is something
 * throwing around the call). A caller that has handled `server` and
 * `validation` holds a success or an envelope refusal, both of which carry
 * the envelope.
 */
export type LambderApiAnswerOutcome<T, TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = LambderApiSuccessOutcome<T> | (LambderApiCallFailure<TMessage> & {
    reason: 'server';
}) | LambderApiValidationFailure<TMessage> | LambderApiEnvelopeFailure<TMessage>;
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
export declare const resolveApiOutcome: <T, TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage>(answer: LambderApiHttpAnswer) => Promise<LambderApiAnswerOutcome<T, TMessage>>;
export {};

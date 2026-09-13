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
export type LambderValidationError = {
    name: string;
    message: string;
    issues: z.core.$ZodIssue[];
};
export type LambderApiFailureReason = 'network' | 'timeout' | 'server' | 'validation' | 'versionExpired' | 'sessionExpired' | 'notAuthorized' | 'errorMessage' | 'unknown';
/**
 * Discriminated result of an API call: `ok: true` carries the payload, every
 * failure carries a machine-readable reason, so "the server returned null"
 * and "the request failed" are never conflated.
 */
export type LambderApiOutcome<T> = {
    ok: true;
    payload: T | null | undefined;
    response: LambderApiResponse<T>;
} | {
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
export declare const resolveApiOutcome: <T>(answer: LambderApiHttpAnswer) => Promise<LambderApiOutcome<T>>;

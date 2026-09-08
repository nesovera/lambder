import type { HttpStatusCode } from "../core/LambderResponse.js";

export type LambderApiErrorOptions = {
    /**
     * Structured, user-facing failure detail placed on the API envelope's
     * `errorMessage` field. Any shape the app's errorMessageHandler expects
     * (e.g. `{ type: "warning", content: "..." }`). Defaults to the error
     * message string, so a bare `throw new LambderApiError("...")` is still
     * visible to the client.
     */
    errorMessage?: any;
    /** Sets the envelope's `notAuthorized` flag (routed to the caller's notAuthorizedHandler). */
    notAuthorized?: boolean;
    /** Sets the envelope's `sessionExpired` flag (the caller clears session cookies and calls sessionExpiredHandler). */
    sessionExpired?: boolean;
    /**
     * HTTP status of the refusal response. Default 200: the envelope is the
     * semantic channel. Avoid 5xx (LambderCaller treats those as crashes) and
     * 422 (reserved for input validation).
     */
    statusCode?: HttpStatusCode;
    /** Extra response headers on the refusal (e.g. Retry-After on a rate limit). */
    headers?: Record<string, string>;
    /** Underlying cause, preserved on the standard Error `cause` property. */
    cause?: unknown;
};

/**
 * A typed refusal: "this request is denied/invalid" as opposed to "the server
 * crashed". Throw it from anywhere in an API call's call stack — handlers,
 * hooks, or nested helpers that have no access to the per-request resolver —
 * and the render pipeline maps it onto the structured API envelope
 * (`res.api(null, { errorMessage, notAuthorized, sessionExpired })`) instead
 * of routing it through setGlobalErrorHandler. Refusals therefore never reach
 * crash logging, and clients receive a parseable response they can surface.
 *
 * Thrown outside an API call (e.g. in a route handler) it behaves like any
 * other error: global error handler, then the default 500.
 *
 * Isomorphic and dependency-free, so shared code (validators, permission
 * checks) may import and throw it from packages used by both server and
 * browser builds; in the browser it is just an Error.
 */
export class LambderApiError extends Error {
    /**
     * Brand for detection across duplicate lambder installs: when two copies
     * of the package coexist in one bundle, `instanceof LambderApiError` fails
     * across them while this marker does not. The pipeline checks the brand.
     */
    readonly isLambderApiError = true;

    readonly errorMessage?: any;
    readonly notAuthorized?: boolean;
    readonly sessionExpired?: boolean;
    readonly statusCode?: HttpStatusCode;
    readonly headers?: Record<string, string>;

    constructor(message: string, options: LambderApiErrorOptions = {}){
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "LambderApiError";
        this.errorMessage = options.errorMessage ?? message;
        this.notAuthorized = options.notAuthorized;
        this.sessionExpired = options.sessionExpired;
        this.statusCode = options.statusCode;
        this.headers = options.headers;
    }
}

/** Brand-based type guard (see LambderApiError.isLambderApiError). */
export const isLambderApiError = (err: unknown): err is LambderApiError =>
    err instanceof Error && (err as LambderApiError).isLambderApiError === true;

/**
 * The standard shape refusals carry on the envelope's errorMessage field.
 * `code` is the refusal's machine-readable identity: clients branch and
 * translate on it and never string-match `content`, which stays the
 * human-readable fallback for codes a client does not know yet. Apps keep
 * their own typed code vocabulary; the framework's own refusals carry a
 * LambderRefusalCode. The caller's errorMessageHandler receives the object
 * as-is; apps with their own errorMessage vocabulary can keep using
 * LambderApiError directly instead.
 */
export type LambderRefusalMessage = {
    type: "warning" | "error" | "info";
    /** Machine-readable identity of the refusal (the app's own vocabulary, or a LambderRefusalCode). */
    code?: string;
    title?: string;
    content: string;
};

/**
 * Codes the framework stamps on the refusals it authors itself, under the
 * reserved `lambder/` prefix so app codes never collide. Compare against
 * these constants on the client (exported from `lambder/client` too) rather
 * than retyping the strings.
 */
export const LAMBDER_REFUSAL_CODES = {
    /** A rate-limit policy refused (429). A policy's own errorMessage inherits this unless it sets a code. */
    rateLimited: "lambder/rate-limited",
    /** The original of an idempotent request is still processing (409). */
    duplicateInFlight: "lambder/duplicate-in-flight",
    /** The idempotencyKey is malformed (400). */
    invalidIdempotencyKey: "lambder/invalid-idempotency-key",
    /** No API is registered under the requested name. */
    apiNotFound: "lambder/api-not-found",
    /** The request's compressed payload is malformed or over the size limit (400). */
    invalidRequestPayload: "lambder/invalid-request-payload",
} as const;
export type LambderRefusalCode = (typeof LAMBDER_REFUSAL_CODES)[keyof typeof LAMBDER_REFUSAL_CODES];

export type LambderRefuseOptions = {
    /** Rendering intent for the client's errorMessageHandler. Default: "warning". */
    type?: LambderRefusalMessage["type"];
    /** Machine-readable identity of the refusal, for clients to branch and translate on. */
    code?: string;
    /** Optional heading shown above the content. */
    title?: string;
    /** Sets the envelope's notAuthorized flag (routed to the caller's notAuthorizedHandler). */
    notAuthorized?: boolean;
    /** Sets the envelope's sessionExpired flag. */
    sessionExpired?: boolean;
    /** HTTP status of the refusal. Default 200; avoid 5xx (caller treats as crash) and 422 (reserved for validation). */
    statusCode?: HttpStatusCode;
    /** Extra response headers on the refusal (e.g. Retry-After). */
    headers?: Record<string, string>;
    /** Underlying cause, preserved on the Error cause property. */
    cause?: unknown;
};

/**
 * Refuse the current API call: a routine business "no" (not found, invalid
 * input, not allowed) with a user-facing message. Throws a LambderApiError
 * carrying the standard LambderRefusalMessage shape, so the pipeline maps it
 * onto the structured envelope instead of a 500, and crash logging never
 * sees it. Callable from anywhere in the call stack — handlers, hooks,
 * guards, shared helpers with no resolver access.
 *
 * The const carries the annotation so TypeScript applies never-return
 * control-flow narrowing at call sites (`if (!row) refuse(...)` implies
 * `row` is defined afterwards).
 */
export const refuse: (content: string, options?: LambderRefuseOptions) => never = (content, options = {}) => {
    throw new LambderApiError(content, {
        errorMessage: {
            type: options.type ?? "warning",
            ...(options.code !== undefined ? { code: options.code } : {}),
            ...(options.title !== undefined ? { title: options.title } : {}),
            content,
        } satisfies LambderRefusalMessage,
        notAuthorized: options.notAuthorized,
        sessionExpired: options.sessionExpired,
        statusCode: options.statusCode,
        headers: options.headers,
        cause: options.cause,
    });
};

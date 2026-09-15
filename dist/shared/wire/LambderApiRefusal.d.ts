import type { LambderHttpStatusCode } from "./LambderHttpStatus.js";
export type LambderApiRefusalOptions = {
    /**
     * User-facing failure detail placed on the API envelope's `errorMessage`
     * field: a refusal message (`{ type: "warning", content: "..." }`, with
     * an app's own `code`) or a plain string. Defaults to the error message
     * string, so a bare `throw new LambderApiRefusal("...")` is still
     * visible to the client.
     */
    errorMessage?: LambderAppRefusalMessage | string;
    /** Sets the envelope's `notAuthorized` flag (routed to the caller's notAuthorizedHandler). */
    notAuthorized?: boolean;
    /** Sets the envelope's `sessionExpired` flag (the caller clears session cookies and calls sessionExpiredHandler). */
    sessionExpired?: boolean;
    /**
     * HTTP status of the refusal response. Default 200: the envelope is the
     * semantic channel. Avoid 5xx (LambderCaller treats those as crashes) and
     * 422 (reserved for input validation).
     */
    statusCode?: LambderHttpStatusCode;
    /** Extra response headers on the refusal (e.g. Retry-After on a rate limit). */
    headers?: Record<string, string>;
    /** Underlying cause, preserved on the standard Error `cause` property. */
    cause?: unknown;
};
/**
 * A typed refusal: "this request is denied/invalid" as opposed to "the server
 * crashed". Throw it from anywhere in an API call's call stack (handlers,
 * hooks, or nested helpers that have no access to the per-request resolver)
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
export declare class LambderApiRefusal extends Error {
    /**
     * Brand for detection across duplicate lambder installs: when two copies
     * of the package coexist in one bundle, `instanceof LambderApiRefusal` fails
     * across them while this marker does not. The pipeline checks the brand.
     */
    readonly isLambderApiRefusal = true;
    readonly errorMessage?: LambderAppRefusalMessage | string;
    readonly notAuthorized?: boolean;
    readonly sessionExpired?: boolean;
    readonly statusCode?: LambderHttpStatusCode;
    readonly headers?: Record<string, string>;
    constructor(message: string, options?: LambderApiRefusalOptions);
}
/** Brand-based type guard (see LambderApiRefusal.isLambderApiRefusal). */
export declare const isLambderApiRefusal: (err: unknown) => err is LambderApiRefusal;
/**
 * The standard shape refusals carry on the envelope's errorMessage field.
 * `code` is the refusal's machine-readable identity: clients branch and
 * translate on it and never string-match `content`, which stays the
 * human-readable fallback for codes a client does not know yet. Apps keep
 * their own typed code vocabulary; the framework's own refusals carry a
 * LambderRefusalCode. The caller's errorMessageHandler receives the object
 * as-is, typed as LambderAppRefusalMessage or a plain string; an app's own
 * vocabulary goes in `code`.
 */
export type LambderRefusalMessage<TAppCode extends string = never> = {
    type: "warning" | "error" | "info";
    /**
     * Machine-readable identity of the refusal: a LambderRefusalCode, plus
     * whatever vocabulary the reader names in TAppCode.
     *
     * Parameterized rather than widened with `string & {}`, because a union
     * with `string` in it does not narrow: inside a `switch(message.code)`
     * the case was not assignable and the `default: never` assertion failed,
     * which is exactly the exhaustiveness the codes exist for. A client that
     * reads its own vocabulary declares it
     * (`LambderRefusalMessage<"app/not-verified" | ...>`) and gets a switch
     * that is checked; a value an app WRITES takes LambderAppRefusalMessage,
     * where any code is welcome.
     */
    code?: LambderRefusalCode | TAppCode;
    title?: string;
    content: string;
};
/**
 * The refusal shape an app authors: any code, with the framework's own still
 * autocompleting. What every option that takes a message from an app is
 * typed as (a rate-limit policy's errorMessage, the mock's failure
 * injection); LambderRefusalMessage itself defaults to the framework's codes
 * alone, so a reader's switch over it is exhaustive.
 */
export type LambderAppRefusalMessage = LambderRefusalMessage<string & {}>;
/**
 * Codes the framework stamps on the refusals it authors itself, under the
 * reserved `lambder/` prefix so app codes never collide. Compare against
 * these constants on the client (exported from `lambder/client` too) rather
 * than retyping the strings.
 */
export declare const LAMBDER_REFUSAL_CODES: {
    /** A rate-limit policy refused (429). A policy's own errorMessage inherits this unless it sets a code. */
    readonly rateLimited: "lambder/rate-limited";
    /** The original of an idempotent request is still processing (409). */
    readonly duplicateInFlight: "lambder/duplicate-in-flight";
    /** The idempotencyKey is malformed (400). */
    readonly invalidIdempotencyKey: "lambder/invalid-idempotency-key";
    /** No API is registered under the requested name. */
    readonly apiNotFound: "lambder/api-not-found";
    /** The request's compressed payload is malformed or over the size limit (400). */
    readonly invalidRequestPayload: "lambder/invalid-request-payload";
    /** Only the mock runtime emits it: the endpoint is registered as not mocked, with a reason. */
    readonly notMocked: "lambder/not-mocked";
};
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
    statusCode?: LambderHttpStatusCode;
    /** Extra response headers on the refusal (e.g. Retry-After). */
    headers?: Record<string, string>;
    /** Underlying cause, preserved on the Error cause property. */
    cause?: unknown;
};
/**
 * Refuse the current API call: a routine business "no" (not found, invalid
 * input, not allowed) with a user-facing message. Throws a LambderApiRefusal
 * carrying the standard LambderRefusalMessage shape, so the pipeline maps it
 * onto the structured envelope instead of a 500, and crash logging never
 * sees it. Callable from anywhere in the call stack: handlers, hooks,
 * guards, shared helpers with no resolver access.
 *
 * The const carries the annotation so TypeScript applies never-return
 * control-flow narrowing at call sites (`if (!row) refuse(...)` implies
 * `row` is defined afterwards).
 */
export declare const refuse: (content: string, options?: LambderRefuseOptions) => never;

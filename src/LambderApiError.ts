import type { HttpStatusCode } from "./LambderResponse.js";

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

    constructor(message: string, options: LambderApiErrorOptions = {}){
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "LambderApiError";
        this.errorMessage = options.errorMessage ?? message;
        this.notAuthorized = options.notAuthorized;
        this.sessionExpired = options.sessionExpired;
        this.statusCode = options.statusCode;
    }
}

/** Brand-based type guard (see LambderApiError.isLambderApiError). */
export const isLambderApiError = (err: unknown): err is LambderApiError =>
    err instanceof Error && (err as LambderApiError).isLambderApiError === true;

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
    isLambderApiError = true;
    errorMessage;
    notAuthorized;
    sessionExpired;
    statusCode;
    constructor(message, options = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "LambderApiError";
        this.errorMessage = options.errorMessage ?? message;
        this.notAuthorized = options.notAuthorized;
        this.sessionExpired = options.sessionExpired;
        this.statusCode = options.statusCode;
    }
}
/** Brand-based type guard (see LambderApiError.isLambderApiError). */
export const isLambderApiError = (err) => err instanceof Error && err.isLambderApiError === true;
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
export const refuse = (content, options = {}) => {
    throw new LambderApiError(content, {
        errorMessage: {
            type: options.type ?? "warning",
            ...(options.title !== undefined ? { title: options.title } : {}),
            content,
        },
        notAuthorized: options.notAuthorized,
        sessionExpired: options.sessionExpired,
        statusCode: options.statusCode,
        cause: options.cause,
    });
};

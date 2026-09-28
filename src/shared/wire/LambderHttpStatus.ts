/**
 * The HTTP status codes a Lambder response may carry.
 *
 * In `shared/` rather than beside LambderResponse: it is HTTP vocabulary, and
 * code a browser bundle reaches needs it (LambderApiRefusal, the mock's
 * contract types). Importing it from `core/` would pull
 * `core/LambderResponse.ts`, and with it `aws-lambda`, into the type graph of
 * `lambder/client`, so a browser-only consumer would need `@types/aws-lambda`
 * to typecheck a status union.
 */
export type LambderHttpStatusCode =
    | 100 | 101
    | 200 | 201 | 202 | 203 | 204 | 206
    | 300 | 301 | 302 | 303 | 304 | 307 | 308
    | 400 | 401 | 402 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 413 | 415 | 416 | 418 | 422 | 428 | 429 | 431 | 451
    | 500 | 501 | 502 | 503 | 504;

/**
 * The status a refusal with a declared code may leave with: not a 5xx, which a
 * reader files as a server failure, not 422, which is input validation's, and
 * not a 1xx.
 */
export type LambderRefusalStatusCode = Exclude<LambderHttpStatusCode, 100 | 101 | 422 | 500 | 501 | 502 | 503 | 504>;

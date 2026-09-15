/**
 * The HTTP status codes a Lambder response may carry.
 *
 * In `shared/` rather than beside LambderResponse because it is HTTP
 * vocabulary with no relationship to the server's response class, and the
 * places that need it include ones a browser bundle reaches
 * (LambderApiRefusal, the mock's contract types). Importing it from `core/`
 * pulled `core/LambderResponse.ts` into the type graph of `lambder/client`,
 * and with it `aws-lambda`, so a browser-only consumer needed
 * `@types/aws-lambda` resolvable to typecheck a status union.
 */
export type LambderHttpStatusCode = 100 | 101 | 200 | 201 | 202 | 203 | 204 | 206 | 300 | 301 | 302 | 303 | 304 | 307 | 308 | 400 | 401 | 402 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 413 | 415 | 416 | 418 | 422 | 428 | 429 | 431 | 451 | 500 | 501 | 502 | 503 | 504;

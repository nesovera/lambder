/**
 * The `requestContext.apiId` of an event LambderInvokeCaller synthesizes, and
 * what the server reads to tell a direct invoke from a gateway's request.
 *
 * A gateway writes its own id there: API Gateway and a Function URL both
 * generate theirs as lowercase letters and digits, so no request through one
 * arrives carrying this hyphenated value, whatever headers it sends. Only a
 * direct invoke delivers an event whose sender wrote the id, and a direct
 * invoke is authorized by IAM. Declared in shared because the invoke caller
 * writes it and the server reads it, and the two must agree byte for byte.
 */
export const LAMBDER_INVOKE_API_ID = "lambder-invoke";

/**
 * The `requestContext.apiId` of a browser-shaped event Lambder synthesizes
 * (lambder/testing, lambderHandlerTransport): a request standing for one a
 * gateway delivered, not an invoke. Hyphenated like LAMBDER_INVOKE_API_ID,
 * so no gateway's event carries it either.
 *
 * The server reads it, like the invoke id, as "Lambder's own event builder
 * wrote this": that builder always delivers a 2.0 event's path decoded, so
 * the path is not decoded a second time whatever host the request names, a
 * Function URL's included. A direct invoker that writes it gains nothing: it
 * writes the whole event, the path included, either way. Declared beside the
 * invoke id for the same reason: the builder writes it and the server reads
 * it.
 */
export const LAMBDER_LOCAL_API_ID = "lambder-local";

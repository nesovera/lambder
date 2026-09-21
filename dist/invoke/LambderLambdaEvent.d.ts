/**
 * The two conversions between a request and what Lambda speaks: a request
 * as the API Gateway payload-format-2.0 event it would have delivered, and
 * a function's answer as the decoded HTTP result it stands for. Shared by
 * LambderInvokeCaller (a real invoke through the Lambda SDK) and
 * lambderHandlerTransport (a Lambder handler called in-process, for tests),
 * along with the smaller conversions that belong to a synthesized request:
 * its body envelope, and a carried session as the cookie pair it travels as.
 * Server-only: Buffer and the codec's zlib restore.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, Context } from "aws-lambda";
import type { LambderHttpEventFormat } from "../core/LambderContext.js";
import type { LambderCompressedBrotliPayload, LambderCompressedGzipPayload } from "../shared/wire/LambderRequestPayload.js";
/** Marks a synthesized request as an invoke, for guards and hooks that want to tell. Not an authorization. */
export declare const LAMBDER_INVOKE_HEADER = "x-lambder-invoke";
/** The invoking function's name, when the caller runs in Lambda; for the callee's logs. */
export declare const LAMBDER_INVOKED_BY_HEADER = "x-lambder-invoked-by";
/** The value of the marker header; a future incompatible event shape would bump it. */
export declare const LAMBDER_INVOKE_PROTOCOL = "1";
/** A session carried on a user's behalf: the two values a browser holds. */
export type LambderInvokeSession = {
    token: string;
    csrf: string;
};
/** The session's cookie pair for a synthesized event: the token rides as a cookie, the CSRF value in the envelope's `token` field. */
export declare const sessionCookies: (session: LambderInvokeSession | undefined, tokenCookieKey: string) => string[] | undefined;
export type LambderSynthesizedRequest = {
    method: string;
    path: string;
    query?: Record<string, string>;
    host: string;
    headers?: Record<string, string>;
    clientIp?: string;
    cookies?: string[];
    body?: string | Buffer;
};
/**
 * The event API Gateway would deliver for this request: payload format 2.0
 * (an HTTP API, a Function URL) unless `eventFormat: "v1"` asks for the REST
 * API's. An invoke is always 2.0; the other format is for an in-process call
 * that wants the handler to meet the shape its own deployment delivers.
 * `invoke: true` adds the invoke marker headers a server-to-server call
 * carries; a browser-shaped request (the handler transport) leaves them off.
 *
 * The client address is `clientIp` and reaches the callee as the gateway's
 * observed source address only (requestContext.http.sourceIp, or
 * requestContext.identity.sourceIp on a REST API event). Writing it as
 * x-forwarded-for as well would put the same fact on a channel a callee may
 * be configured to trust (trustedClientIpHeaders), and the header is the one
 * the caller's own `headers` could otherwise have set.
 */
export declare function synthesizeLambdaHttpEvent(request: LambderSynthesizedRequest, options: {
    invoke: boolean;
    eventFormat?: "v2";
}): APIGatewayProxyEventV2;
export declare function synthesizeLambdaHttpEvent(request: LambderSynthesizedRequest, options: {
    invoke: boolean;
    eventFormat: "v1";
}): APIGatewayProxyEvent;
export declare function synthesizeLambdaHttpEvent(request: LambderSynthesizedRequest, options: {
    invoke: boolean;
    eventFormat?: LambderHttpEventFormat;
}): APIGatewayProxyEventV2 | APIGatewayProxyEvent;
/**
 * The body envelope LambderCaller sends, minus the fields only a browser has
 * a value for, as JSON. A plain payload arrives already serialized (the
 * compression decision needed its JSON) and is spliced in rather than
 * parsed and stringified a second time; a compressed one rides as its two
 * fields.
 */
export declare const buildEnvelopeJson: (fields: {
    apiName: string;
    version?: string;
    signature?: string;
    csrf?: string;
    siteHost: string;
    /** The payload's own JSON, when it goes plainly. */
    payloadJson?: string;
    /** The compressed pair, when it goes compressed. */
    compressed?: LambderCompressedBrotliPayload | LambderCompressedGzipPayload | null;
    guardInputs?: Record<string, unknown>;
    idempotencyKey?: string;
}) => string;
/** The decoded HTTP answer of a Lambda result: status, lowercased headers, cookies and the body bytes (decompressed when the callee compressed them). */
export type LambderLambdaHttpResult = {
    statusCode: number;
    headers: Record<string, string>;
    cookies: string[];
    body: Buffer;
    text: () => string;
    json: () => unknown;
};
/** The function's answer as an HTTP result; throws when it is not one, or its compressed body cannot be restored under `maxBodyBytes`. */
export declare const decodeLambdaHttpResult: (result: unknown, maxBodyBytes: number) => Promise<LambderLambdaHttpResult>;
/** A Lambda context for an in-process call, the fields a handler might read filled plausibly. */
export declare const localLambdaContext: (functionName: string, overrides?: Partial<Context>) => Context;

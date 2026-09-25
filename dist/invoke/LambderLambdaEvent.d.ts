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
/**
 * Marks a synthesized request as an invoke, for guards and hooks that want to
 * tell. Not an authorization: over HTTP it is a header any client can send.
 * The server itself tells an invoke by its requestContext.apiId, which no
 * gateway lets a client write (see LAMBDER_INVOKE_API_ID).
 */
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
    /**
     * The body's type, owned by the event over any Content-Type in `headers`:
     * an API call's envelope is JSON whatever headers a caller forwards, and
     * a server takes a POST to its API path as an API call only when it says
     * so. Left out, a caller's own Content-Type stands, and a body without
     * one is typed by its kind.
     */
    contentType?: string;
};
/**
 * The event API Gateway would deliver for this request: payload format 2.0
 * (an HTTP API's, whose path arrives decoded) unless `eventFormat: "v1"` asks
 * for the REST API's, whose path arrives as written. An invoke is always 2.0;
 * the other format is for an in-process call that wants the handler to meet
 * the shape its own deployment delivers.
 * `invoke: true` adds the invoke marker headers a server-to-server call
 * carries; a browser-shaped request (the handler transport) leaves them off.
 *
 * The client address is `clientIp` and reaches the callee as the gateway's
 * observed source address (requestContext.http.sourceIp, or
 * requestContext.identity.sourceIp on a REST API event). On an invoke it is
 * the only channel, and x-forwarded-for is dropped from the caller's
 * `headers`: a server of this version reads no trusted forwarding header on
 * an event carrying LAMBDER_INVOKE_API_ID, but a callee on Lambder 7.x reads
 * the one it trusts on any event, so a gateway lambda forwarding a browser's
 * headers would hand it a ctx.ip the browser chose. x-forwarded-for is the
 * header a gateway writes and the one such a callee trusts in the common
 * case. A browser-shaped request keeps every header it was given: it stands
 * for what a gateway delivered, and a test that writes a forwarding header
 * on one is exercising the app's own trustedClientIpHeaders.
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

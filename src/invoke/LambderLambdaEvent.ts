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
// invoke/ may name a core/ type and never a core/ value; the event formats
// are the server's own vocabulary, so they are named from where it declares them.
import type { LambderHttpEventFormat } from "../core/LambderContext.js";
import { restoreBytes } from "../shared/wire/LambderCompressionCodec.js";
import { bytesToBase64 } from "../shared/util/LambderBase64.js";
import { LAMBDER_INVOKE_API_ID, LAMBDER_LOCAL_API_ID } from "../shared/wire/LambderInvokeApiId.js";
import { buildEnvelopeFields } from "../shared/transport/LambderApiTransport.js";
import type { LambderCompressedBrotliPayload, LambderCompressedGzipPayload } from "../shared/wire/LambderRequestPayload.js";

/**
 * Marks a synthesized request as an invoke, for guards and hooks that want to
 * tell. Not an authorization: over HTTP it is a header any client can send.
 * The server itself tells an invoke by its requestContext.apiId, which no
 * gateway lets a client write (see LAMBDER_INVOKE_API_ID).
 */
export const LAMBDER_INVOKE_HEADER = "x-lambder-invoke";
/** The invoking function's name, when the caller runs in Lambda; for the callee's logs. */
export const LAMBDER_INVOKED_BY_HEADER = "x-lambder-invoked-by";
/** The value of the marker header; a future incompatible event shape would bump it. */
export const LAMBDER_INVOKE_PROTOCOL = "1";
/**
 * The forwarded-address header a gateway writes, which an invoke never
 * carries: its address travels as `clientIp` alone (see
 * synthesizeLambdaHttpEvent).
 */
const FORWARDED_FOR_HEADER = "x-forwarded-for";

/** A session carried on a user's behalf: the two values a browser holds. */
export type LambderInvokeSession = { token: string; csrf: string };

/** The session's cookie pair for a synthesized event: the token rides as a cookie, the CSRF value in the envelope's `token` field. */
export const sessionCookies = (session: LambderInvokeSession | undefined, tokenCookieKey: string): string[] | undefined =>
    session ? [`${tokenCookieKey}=${session.token}`] : undefined;

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

const randomRequestId = (): string => {
    const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if(webCrypto?.randomUUID) return webCrypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
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
export function synthesizeLambdaHttpEvent(request: LambderSynthesizedRequest, options: { invoke: boolean; eventFormat?: "v2" }): APIGatewayProxyEventV2;
export function synthesizeLambdaHttpEvent(request: LambderSynthesizedRequest, options: { invoke: boolean; eventFormat: "v1" }): APIGatewayProxyEvent;
export function synthesizeLambdaHttpEvent(request: LambderSynthesizedRequest, options: { invoke: boolean; eventFormat?: LambderHttpEventFormat }): APIGatewayProxyEventV2 | APIGatewayProxyEvent;
export function synthesizeLambdaHttpEvent(request: LambderSynthesizedRequest, options: { invoke: boolean; eventFormat?: LambderHttpEventFormat }): APIGatewayProxyEventV2 | APIGatewayProxyEvent {
    // The caller's own headers go on first, so the ones this function owns
    // cannot be displaced by them.
    const headers: Record<string, string> = {};
    for(const [key, value] of Object.entries(request.headers ?? {})) headers[key.toLowerCase()] = value;
    // The invoke markers the event owns whatever the caller passed: they say
    // what this event is. Forwarding a browser's headers wholesale is an
    // ordinary gateway-lambda pattern, and without these deletes it would let
    // a browser-shaped request claim to be an invoke, or an invoke name an
    // invoking function that did not send it.
    delete headers[LAMBDER_INVOKE_HEADER];
    delete headers[LAMBDER_INVOKED_BY_HEADER];
    if(options.invoke) delete headers[FORWARDED_FOR_HEADER];
    headers.host = request.host;
    headers["accept-encoding"] = "br, gzip";
    if(options.invoke){
        headers[LAMBDER_INVOKE_HEADER] = LAMBDER_INVOKE_PROTOCOL;
        const invokedBy = typeof process !== "undefined" ? process.env?.AWS_LAMBDA_FUNCTION_NAME : undefined;
        if(invokedBy) headers[LAMBDER_INVOKED_BY_HEADER] = invokedBy;
    }
    const isBinary = Buffer.isBuffer(request.body);
    if(request.contentType) headers["content-type"] = request.contentType;
    else if(request.body !== undefined && !headers["content-type"]){
        headers["content-type"] = isBinary ? "application/octet-stream" : "application/json";
    }
    const body = request.body === undefined ? undefined : isBinary ? bytesToBase64(request.body as Buffer) : request.body as string;
    const now = Date.now();
    if(options.eventFormat === "v1"){
        // A REST API has no cookies array: cookies ride in the Cookie header,
        // and every header is delivered twice, once as its last value and
        // once as the list of all of them.
        if(request.cookies?.length) headers.cookie = request.cookies.join("; ");
        const query = request.query && Object.keys(request.query).length ? request.query : null;
        return {
            resource: "/{proxy+}",
            path: request.path,
            httpMethod: request.method,
            headers,
            multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]])),
            queryStringParameters: query,
            multiValueQueryStringParameters: query ? Object.fromEntries(Object.entries(query).map(([name, value]) => [name, [value]])) : null,
            pathParameters: null,
            stageVariables: null,
            // The fields a handler might read, filled plausibly; the rest of
            // a REST API's request context (authorizer, the API key, the
            // Cognito identity) describes a deployment this event has none of.
            requestContext: {
                accountId: "",
                apiId: options.invoke ? LAMBDER_INVOKE_API_ID : LAMBDER_LOCAL_API_ID,
                domainName: request.host,
                httpMethod: request.method,
                identity: { sourceIp: request.clientIp ?? "", userAgent: "lambder-local" },
                path: request.path,
                protocol: "HTTP/1.1",
                requestId: randomRequestId(),
                requestTimeEpoch: now,
                resourcePath: "/{proxy+}",
                stage: "local",
            } as unknown as APIGatewayProxyEvent["requestContext"],
            body: body ?? null,
            isBase64Encoded: isBinary,
        };
    }
    // An HTTP API's event, with its path decoded (an encoded slash into a
    // separator, too) the way the gateway delivers it, whatever host the
    // request names. The server reads a gateway's v2 event as encoded when
    // its domain is a Function URL's, so it is told this event is decoded by
    // the apiId, which is Lambder's own either way: a request naming a
    // lambda-url host would otherwise have its path decoded a second time,
    // and `/%2561dmin` would reach `/admin`. A path that does not decode goes
    // as it is.
    let decodedPath = request.path;
    try { decodedPath = decodeURIComponent(request.path); } catch { /* delivered as written */ }
    return {
        version: "2.0",
        routeKey: "$default",
        rawPath: decodedPath,
        rawQueryString: new URLSearchParams(request.query ?? {}).toString(),
        headers,
        ...(request.cookies?.length ? { cookies: request.cookies } : {}),
        requestContext: {
            accountId: "",
            apiId: options.invoke ? LAMBDER_INVOKE_API_ID : LAMBDER_LOCAL_API_ID,
            domainName: request.host,
            domainPrefix: "",
            http: {
                method: request.method,
                path: decodedPath,
                protocol: "HTTP/1.1",
                sourceIp: request.clientIp ?? "",
                userAgent: options.invoke ? "lambder-invoke" : "lambder-local",
            },
            requestId: randomRequestId(),
            routeKey: "$default",
            stage: "$default",
            time: new Date(now).toISOString(),
            timeEpoch: now,
        },
        ...(body !== undefined ? { body } : {}),
        isBase64Encoded: isBinary,
    };
}

/**
 * The body envelope LambderCaller sends, minus the fields only a browser has
 * a value for, as JSON. A plain payload arrives already serialized (the
 * compression decision needed its JSON) and is spliced in rather than
 * parsed and stringified a second time; a compressed one rides as its two
 * fields.
 */
export const buildEnvelopeJson = (fields: {
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
}): string => {
    // The field set is buildEnvelopeFields', so a field added to the envelope
    // reaches this sender too; only the payload is this one's own business.
    const withoutPayload = JSON.stringify(buildEnvelopeFields({
        apiName: fields.apiName,
        version: fields.version,
        signature: fields.signature,
        token: fields.csrf ?? "",
        siteHost: fields.siteHost,
        compressed: fields.compressed,
        guardInputs: fields.guardInputs,
        idempotencyKey: fields.idempotencyKey,
    }));
    if(fields.payloadJson === undefined) return withoutPayload;
    return `${withoutPayload.slice(0, -1)},"payload":${fields.payloadJson}}`;
};

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
export const decodeLambdaHttpResult = async (result: unknown, maxBodyBytes: number): Promise<LambderLambdaHttpResult> => {
    if(!result || typeof result !== "object" || typeof (result as { statusCode?: unknown }).statusCode !== "number"){
        throw new Error("the function did not answer with an HTTP response object; is it a Lambder app?");
    }
    const raw = result as {
        statusCode: number;
        headers?: Record<string, string>;
        multiValueHeaders?: Record<string, string[]>;
        cookies?: string[];
        body?: string | null;
        isBase64Encoded?: boolean;
    };
    const headers: Record<string, string> = {};
    const cookies: string[] = [...(raw.cookies ?? [])];
    for(const [key, value] of Object.entries(raw.headers ?? {})) headers[key.toLowerCase()] = value;
    for(const [key, values] of Object.entries(raw.multiValueHeaders ?? {})){
        // A v1 answer carries Set-Cookie as a multi-value header; keep the
        // values apart, as the v2 cookies array does, since they contain commas.
        if(key.toLowerCase() === "set-cookie") cookies.push(...values);
        headers[key.toLowerCase()] = values.join(", ");
    }
    let body: Buffer = raw.body ? Buffer.from(raw.body, raw.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0);
    const encoding = headers["content-encoding"]?.trim().toLowerCase();
    if(encoding === "br" || encoding === "gzip"){
        // restoreBytes, not restoreText: a route may answer compressed
        // binary (a wasm module, anything it forced compression on), and
        // decoding that as UTF-8 first would replace every byte that is
        // not valid UTF-8 and hand back a silently different body.
        const restored = await restoreBytes(body, encoding, { maxBytes: maxBodyBytes });
        body = Buffer.isBuffer(restored) ? restored : Buffer.from(restored);
    }else if(encoding && encoding !== "identity"){
        // "identity" is a legal value meaning no encoding, and a hook or a
        // proxy may set it, so it passes as a plain body; only other values
        // fail the invoke.
        throw new Error(`the answer carries an unsupported Content-Encoding "${encoding}"`);
    }
    return {
        statusCode: raw.statusCode,
        headers,
        cookies,
        body,
        text: () => body.toString("utf8"),
        json: () => JSON.parse(body.toString("utf8")),
    };
};

/** A Lambda context for an in-process call, the fields a handler might read filled plausibly. */
export const localLambdaContext = (functionName: string, overrides: Partial<Context> = {}): Context => ({
    callbackWaitsForEmptyEventLoop: false,
    functionName,
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:local:000000000000:function:${functionName}`,
    memoryLimitInMB: "128",
    awsRequestId: randomRequestId(),
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: "local",
    getRemainingTimeInMillis: () => 30_000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
    ...overrides,
} as Context);

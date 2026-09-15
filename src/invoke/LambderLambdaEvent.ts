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

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { restoreBytes } from "../shared/wire/LambderCompressionCodec.js";
import { bytesToBase64 } from "../shared/util/LambderBase64.js";
import { buildEnvelopeFields } from "../shared/transport/LambderApiTransport.js";
import type { LambderCompressedBrotliPayload, LambderCompressedGzipPayload } from "../shared/wire/LambderRequestPayload.js";

/** Marks a synthesized request as an invoke, for guards and hooks that want to tell. Not an authorization. */
export const LAMBDER_INVOKE_HEADER = "x-lambder-invoke";
/** The invoking function's name, when the caller runs in Lambda; for the callee's logs. */
export const LAMBDER_INVOKED_BY_HEADER = "x-lambder-invoked-by";
/** The value of the marker header; a future incompatible event shape would bump it. */
export const LAMBDER_INVOKE_PROTOCOL = "1";
/**
 * The forwarded-address header a gateway writes. This event never writes it:
 * the address it asserts travels in requestContext.http.sourceIp, which is
 * what resolveClientIp reads and the only channel a callee trusts by default.
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
};

const randomRequestId = (): string => {
    const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if(webCrypto?.randomUUID) return webCrypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
};

/**
 * The payload-format-2.0 event API Gateway would deliver for this request.
 * `invoke: true` adds the invoke marker headers a server-to-server call
 * carries; a browser-shaped request (the handler transport) leaves them off.
 *
 * The client address is `clientIp` and reaches the callee as
 * requestContext.http.sourceIp only. Writing it as x-forwarded-for as well
 * would put the same fact on a channel a callee may be configured to trust
 * (trustedClientIpHeaders), and the header is the one the caller's own
 * `headers` could otherwise have set.
 */
export const synthesizeLambdaHttpEvent = (request: LambderSynthesizedRequest, options: { invoke: boolean }): APIGatewayProxyEventV2 => {
    // The caller's own headers go on first, so the ones this function owns
    // cannot be displaced by them. Forwarding an incoming browser request's
    // headers into `headers` is an ordinary gateway-lambda pattern, and with
    // the spread last it let that end user overwrite the invoke markers and
    // the forwarded address this event is asserting.
    const headers: Record<string, string> = {};
    for(const [key, value] of Object.entries(request.headers ?? {})) headers[key.toLowerCase()] = value;
    // These three the event owns unconditionally, whatever the caller passed:
    // a forwarded address the caller did not assert through `clientIp` is not
    // this event's to make, and the invoke markers say what this event is. A
    // gateway lambda that forwards a browser's headers wholesale would
    // otherwise hand a callee that trusts x-forwarded-for an end-user-chosen
    // ctx.ip, and let a browser-shaped request claim to be an invoke.
    delete headers[FORWARDED_FOR_HEADER];
    delete headers[LAMBDER_INVOKE_HEADER];
    delete headers[LAMBDER_INVOKED_BY_HEADER];
    headers.host = request.host;
    headers["accept-encoding"] = "br, gzip";
    if(options.invoke){
        headers[LAMBDER_INVOKE_HEADER] = LAMBDER_INVOKE_PROTOCOL;
        const invokedBy = typeof process !== "undefined" ? process.env?.AWS_LAMBDA_FUNCTION_NAME : undefined;
        if(invokedBy) headers[LAMBDER_INVOKED_BY_HEADER] = invokedBy;
    }
    const isBinary = Buffer.isBuffer(request.body);
    if(request.body !== undefined && !headers["content-type"]){
        headers["content-type"] = isBinary ? "application/octet-stream" : "application/json";
    }
    const now = Date.now();
    return {
        version: "2.0",
        routeKey: "$default",
        rawPath: request.path,
        rawQueryString: new URLSearchParams(request.query ?? {}).toString(),
        headers,
        ...(request.cookies?.length ? { cookies: request.cookies } : {}),
        requestContext: {
            accountId: "",
            apiId: options.invoke ? "lambder-invoke" : "lambder-local",
            domainName: request.host,
            domainPrefix: "",
            http: {
                method: request.method,
                path: request.path,
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
        ...(request.body !== undefined
            ? { body: isBinary ? bytesToBase64(request.body as Buffer) : request.body as string }
            : {}),
        isBase64Encoded: isBinary,
    };
};

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
        // proxy may set it; treating it as unsupported turned every such
        // invoke into a protocol failure.
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

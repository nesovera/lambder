/**
 * Calling a Lambder app from another lambda, or from any server code that
 * holds AWS credentials and lambda:InvokeFunction on it.
 *
 * API Gateway delivers an HTTP request to a Lambder app as a JSON event and
 * takes a JSON response object back; a direct InvokeCommand carries JSON in
 * both directions too. So this caller builds the payload-format-2.0 event
 * API Gateway would have built, invokes the function with it, and reads the
 * response object Lambder returns. The callee is an unmodified Lambder app,
 * and everything it offers over HTTP (zod validation, the inferred contract,
 * refusals, guards, idempotency keys, Brotli answers, logList, the crash
 * detail its global error handler chooses to send) applies unchanged. The
 * callee tells an invoke from a browser only by the x-lambder-invoke header,
 * which is a marker for guards and hooks, never an authorization: the IAM
 * grant is that.
 *
 * Server-only (zlib, the Lambda SDK), so it is exported from the root entry
 * and never from lambder/client. The SDK is an optional peer dependency
 * loaded on the first call; the `transport` option replaces it, and
 * LambderInvokeCaller.localTransport runs a callee's handler in-process for
 * tests.
 */

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import type { LambdaClient, LambdaClientConfig } from "@aws-sdk/client-lambda";
import type { ApiContractShape, LambderApiResponse } from "../shared/LambderApiContract.js";
import { resolveApiOutcome, type LambderApiFailureReason, type LambderValidationError } from "../shared/LambderApiOutcome.js";
import {
    mergeGuardInputs,
    type LambderCallOptionsArg,
    type LambderGuardInputsProviderOption,
} from "../shared/LambderCallOptions.js";
import { errorFromCrashDetail, type LambderCrashDetail } from "../shared/LambderCrashDetail.js";
import { resolveCompressionOption, type LambderCompressionOption, type LambderCompressionSettings } from "../shared/LambderCompressionOption.js";
import { compressText, restoreBytes } from "../shared/LambderCompressionCodec.js";
import {
    COMPRESSED_PAYLOAD_BR_FIELD,
    DEFAULT_MAX_RESTORED_PAYLOAD_BYTES,
    compressPayloadWith,
    type LambderCompressedBrotliPayload,
} from "../shared/LambderRequestPayload.js";

/** Marks a synthesized request as an invoke, for guards and hooks that want to tell. Not an authorization. */
export const LAMBDER_INVOKE_HEADER = "x-lambder-invoke";
/** The invoking function's name, when the caller runs in Lambda; for the callee's logs. */
export const LAMBDER_INVOKED_BY_HEADER = "x-lambder-invoked-by";
/** The value of the marker header; a future incompatible event shape would bump it. */
export const LAMBDER_INVOKE_PROTOCOL = "1";
/**
 * Lambda caps a synchronous invoke's request and its response at about 6MB;
 * the same guard threshold finalizeResponse applies to an answer, applied
 * here to the event before it is sent.
 */
export const LAMBDER_INVOKE_MAX_EVENT_BYTES = 5_500_000;
/** Request Brotli when `requestCompression: true`: the HTTP request threshold, at the quality every other Lambder site uses. */
export const DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS: LambderCompressionSettings = { minBytes: 4096, quality: 5 };
const DEFAULT_SESSION_TOKEN_COOKIE_KEY = "LMDRSESSIONTKID";

// ---------------------------------------------------------------------------
// Outcomes and the error api() throws
// ---------------------------------------------------------------------------

export type LambderInvokeFailureReason =
    | LambderApiFailureReason
    | 'crash'            // Lambda reported a FunctionError: the callee failed outside the framework (init, timeout, memory)
    | 'protocol'         // the answer is not a Lambda HTTP response object, or its compressed body could not be restored
    | 'payloadTooLarge'; // refused before sending: the event exceeds the invoke cap

/** Lambda's own error payload for a FunctionError invocation. */
export type LambderInvokeFunctionError = { errorType?: string; errorMessage?: string; trace?: string[] };

export type LambderInvokeFailure = {
    ok: false;
    reason: LambderInvokeFailureReason;
    /** HTTP status, when the callee answered. */
    status?: number;
    /** Envelope errorMessage, when the callee provided one. */
    errorMessage?: any;
    /** Seconds to wait before retrying, from the answer's Retry-After header. */
    retryAfterSeconds?: number;
    /** Always present: the error api() throws for this failure, with the callee's error as its cause when one is known. */
    error: LambderInvokeError;
    /** Zod issue detail for 'validation'. */
    zodError?: LambderValidationError;
    /** The parsed envelope, when one came back. */
    response?: LambderApiResponse<any>;
    /** The callee's crash detail, when its global error handler sent one (the envelope's `crash` field). */
    crash?: LambderCrashDetail;
    /** Lambda's error payload for reason 'crash'. */
    functionError?: LambderInvokeFunctionError;
    /** The answer's logList; empty when no envelope came back. */
    logList: unknown[];
    /** For 'payloadTooLarge': the event's byte size. */
    bytes?: number;
};

export type LambderInvokeOutcome<T> =
    | { ok: true; payload: T; response: LambderApiResponse<T>; logList: unknown[] }
    | LambderInvokeFailure;

type LambderInvokeErrorInit = {
    message: string;
    reason: LambderInvokeFailureReason;
    apiName: string;
    functionName: string;
    status?: number;
    errorMessage?: any;
    crash?: LambderCrashDetail;
    functionError?: LambderInvokeFunctionError;
    logList: unknown[];
    zodError?: LambderValidationError;
    retryAfterSeconds?: number;
    bytes?: number;
    cause?: unknown;
};

/**
 * What api() throws. Its message names the function, the API and the reason,
 * so an error reporter that fingerprints on the message groups one broken
 * API into one row; its cause is the callee's own error rebuilt from the
 * crash detail (or Lambda's FunctionError, or the SDK's rejection), so a
 * reporter that walks causes stores the callee's stack.
 */
export class LambderInvokeError extends Error {
    /** Brand for detection across duplicate lambder installs, like LambderApiError. */
    readonly isLambderInvokeError = true;
    readonly reason: LambderInvokeFailureReason;
    readonly apiName: string;
    readonly functionName: string;
    readonly status?: number;
    readonly errorMessage?: any;
    readonly crash?: LambderCrashDetail;
    readonly functionError?: LambderInvokeFunctionError;
    readonly logList: unknown[];
    readonly zodError?: LambderValidationError;
    readonly retryAfterSeconds?: number;
    readonly bytes?: number;
    /** The full failure outcome; it carries this error and this error carries it. */
    outcome!: LambderInvokeFailure;

    constructor(init: LambderInvokeErrorInit){
        super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
        this.name = "LambderInvokeError";
        this.reason = init.reason;
        this.apiName = init.apiName;
        this.functionName = init.functionName;
        this.status = init.status;
        this.errorMessage = init.errorMessage;
        this.crash = init.crash;
        this.functionError = init.functionError;
        this.logList = init.logList;
        this.zodError = init.zodError;
        this.retryAfterSeconds = init.retryAfterSeconds;
        this.bytes = init.bytes;
    }
}

/** Brand-based type guard (see LambderInvokeError.isLambderInvokeError). */
export const isLambderInvokeError = (err: unknown): err is LambderInvokeError =>
    err instanceof Error && (err as LambderInvokeError).isLambderInvokeError === true;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** What a transport hands back: Lambda's FunctionError marker (null when the function returned normally) and the parsed JSON it returned. */
export type LambderInvokeTransportResult = { functionError: string | null; result: unknown };
/**
 * Delivers one synthesized event and returns what the function answered;
 * rejects when the invoke itself failed. `eventJson` is the event serialized
 * once by the caller: the SDK transport sends those bytes as they are, and a
 * custom transport that works from the object may ignore it.
 */
export type LambderInvokeTransport = (
    event: APIGatewayProxyEventV2,
    options: { functionName: string; eventJson: string; signal?: AbortSignal },
) => Promise<LambderInvokeTransportResult>;

/** The onLogList option: each answer's logList, success or failure, when it has entries. */
export type LambderInvokeLogListHandler = (apiName: string, logList: unknown[]) => void | Promise<void>;
/** The onFailure option: every failed call, once, awaited before api() throws or apiOutcome() returns. */
export type LambderInvokeFailureHandler = (failure: LambderInvokeFailure, info: { apiName: string; functionName: string }) => void | Promise<void>;

/** A session carried on a user's behalf: the two values a browser holds. */
export type LambderInvokeSession = { token: string; csrf: string };

export type LambderInvokeCallOptions = {
    /** Abort after this many ms; overrides the constructor default. The callee keeps running regardless. */
    timeoutMs?: number;
    /** External abort signal, combined with the timeout when both are set. */
    signal?: AbortSignal;
    /** Overrides the constructor's requestCompression for this call: false sends the payload plainly, true compresses it regardless of the threshold. Either way it is only sent compressed when that is smaller. */
    compressRequest?: boolean;
    /** Forwarded as X-Forwarded-For, so ctx.ip on the callee is the end user's address rather than nothing. */
    clientIp?: string;
    /** Extra request headers the callee sees. */
    headers?: Record<string, string>;
    /** Values for the API's guardInput-mode guards, keyed by guard name; the contract makes this REQUIRED for APIs that declare such guards, except those a guardInputsProvider covers. */
    guardInputs?: Record<string, unknown>;
    /** Replay-protection key for APIs declared idempotent on the callee. Same rules as LambderCaller: unguessable, at least 16 characters, one per logical operation. */
    idempotencyKey?: string;
    /** A user's session, so a session API on the callee runs on their behalf. */
    session?: LambderInvokeSession;
};

type LambderInvokeCallerBaseOptions = {
    /** Function name or ARN. */
    functionName: string;
    /** A ready client, e.g. one shared with the rest of the app. */
    client?: LambdaClient;
    /** Otherwise the client is created from this on the first call (region, credentials, maxAttempts). */
    clientConfig?: LambdaClientConfig;
    /** Must match the callee's apiPath. Default: "/api". */
    apiPath?: string;
    /** Sent as `version`; the callee answers versionExpired on a mismatch when it has one too. Default: none. */
    apiVersion?: string;
    /** The Host the callee sees (ctx.host). Default: functionName. */
    host?: string;
    /**
     * Brotli the request payload when its JSON reaches the threshold, sent
     * as `payloadBr` beside its byte length instead of `payload` whenever
     * that is smaller. Off by default; `true` is { minBytes: 4096,
     * quality: 5 }. The callee understands both shapes either way.
     */
    requestCompression?: LambderCompressionOption;
    /** Ceiling on what a compressed answer may restore to, the counterpart of the server's maxRequestPayloadBytes. Default: 20,000,000. */
    maxResponsePayloadBytes?: number;
    /** Default per-call timeout in ms. The callee's own timeout is the real ceiling. Default: none. */
    timeoutMs?: number;
    /** Receives each answer's logList. Default: console.log with the function and api name. A throw is logged and otherwise ignored. */
    onLogList?: LambderInvokeLogListHandler;
    /**
     * Called, and awaited, for every failed call before api() throws or
     * apiOutcome() returns, so failures are reported in one place whichever
     * method the site used, and before the lambda answers. A throw inside it
     * is logged and otherwise ignored: apiOutcome() never throws.
     */
    onFailure?: LambderInvokeFailureHandler;
    /** The session token cookie's name, when a session is carried and the callee uses a non-default `tokenCookieKey`. The CSRF value rides in the envelope's `token` field, which has no name to configure. */
    sessionTokenCookieKey?: string;
    /** Replaces the Lambda SDK. */
    transport?: LambderInvokeTransport;
};

/** Constructor options: the base options plus guardInputsProvider, mandatory once TProvided names guards. */
export type LambderInvokeCallerOptions<TContract, TProvided extends string = never> =
    LambderInvokeCallerBaseOptions & LambderGuardInputsProviderOption<TContract, TProvided>;

/** The decoded HTTP answer of request(): status, lowercased headers, cookies and the body bytes (decompressed when the callee compressed them). */
export type LambderInvokeHttpResult = {
    statusCode: number;
    headers: Record<string, string>;
    cookies: string[];
    body: Buffer;
    text: () => string;
    json: () => unknown;
};

export type LambderInvokeRequestInit = {
    /** Default: GET. */
    method?: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    /** A string body is sent as-is (JSON unless a content-type says otherwise); a Buffer is sent base64-encoded as API Gateway would. */
    body?: string | Buffer;
    /** Cookie header pairs, `name=value`. */
    cookies?: string[];
    clientIp?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
};

/** What createEvent builds an API call event from; the instance path adds compression on top. */
export type LambderInvokeEventInit = {
    /** Default: "/api". */
    apiPath?: string;
    apiName: string;
    payload?: unknown;
    /** Default: "lambder-invoke". */
    host?: string;
    apiVersion?: string;
    guardInputs?: Record<string, unknown>;
    idempotencyKey?: string;
    clientIp?: string;
    headers?: Record<string, string>;
    session?: LambderInvokeSession;
    sessionTokenCookieKey?: string;
};

// ---------------------------------------------------------------------------
// The synthesized event
// ---------------------------------------------------------------------------

type SynthesizedRequest = {
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

/** The payload-format-2.0 event API Gateway would deliver for this request. */
const synthesizeHttpEvent = (request: SynthesizedRequest): APIGatewayProxyEventV2 => {
    const headers: Record<string, string> = {
        host: request.host,
        "accept-encoding": "br, gzip",
        [LAMBDER_INVOKE_HEADER]: LAMBDER_INVOKE_PROTOCOL,
    };
    const invokedBy = typeof process !== "undefined" ? process.env?.AWS_LAMBDA_FUNCTION_NAME : undefined;
    if(invokedBy) headers[LAMBDER_INVOKED_BY_HEADER] = invokedBy;
    if(request.clientIp) headers["x-forwarded-for"] = request.clientIp;
    for(const [key, value] of Object.entries(request.headers ?? {})) headers[key.toLowerCase()] = value;
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
            apiId: "lambder-invoke",
            domainName: request.host,
            domainPrefix: "",
            http: {
                method: request.method,
                path: request.path,
                protocol: "HTTP/1.1",
                sourceIp: request.clientIp ?? "",
                userAgent: "lambder-invoke",
            },
            requestId: randomRequestId(),
            routeKey: "$default",
            stage: "$default",
            time: new Date(now).toISOString(),
            timeEpoch: now,
        },
        ...(request.body !== undefined
            ? { body: isBinary ? (request.body as Buffer).toString("base64") : request.body as string }
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
const buildEnvelopeJson = (fields: {
    apiName: string;
    version?: string;
    csrf?: string;
    siteHost: string;
    /** The payload's own JSON, when it goes plainly. */
    payloadJson?: string;
    /** The payloadBr pair, when it goes compressed. */
    compressed?: LambderCompressedBrotliPayload | null;
    guardInputs?: Record<string, unknown>;
    idempotencyKey?: string;
}): string => {
    const withoutPayload = JSON.stringify({
        apiName: fields.apiName,
        version: fields.version,
        token: fields.csrf ?? "",
        siteHost: fields.siteHost,
        ...(fields.compressed ?? {}),
        ...(fields.guardInputs !== undefined ? { guardInputs: fields.guardInputs } : {}),
        ...(fields.idempotencyKey !== undefined ? { idempotencyKey: fields.idempotencyKey } : {}),
    });
    if(fields.payloadJson === undefined) return withoutPayload;
    return `${withoutPayload.slice(0, -1)},"payload":${fields.payloadJson}}`;
};

const sessionCookies = (session: LambderInvokeSession | undefined, tokenCookieKey: string): string[] | undefined =>
    session ? [`${tokenCookieKey}=${session.token}`] : undefined;

/**
 * Brotli one payload's JSON for sending, or null when the plain JSON should
 * go instead: the browser's compressPayloadGzip with Brotli, because both
 * ends are Node. The threshold and the only-when-smaller rule are
 * compressPayloadWith's, shared with the gzip side.
 */
export const compressPayloadBrotli = (
    json: string,
    minBytes: number,
    quality: number,
): Promise<LambderCompressedBrotliPayload | null> =>
    compressPayloadWith(json, minBytes, COMPRESSED_PAYLOAD_BR_FIELD, (bytes) =>
        compressText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), "br", quality));

/** A timeout controller chained to an external signal, so either source aborts the invoke. */
const abortAfter = (timeoutMs: number | undefined, external: AbortSignal | undefined) => {
    let timedOut = false;
    let signal: AbortSignal | undefined = external;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // The forwarding listener is detached in clear(), not left to `once`: an
    // external signal usually outlives the call (a request-scoped one passed
    // to several invokes, an app-lifetime one), so a listener per call would
    // accumulate on it for as long as it lives.
    let detach: (() => void) | undefined;
    if(timeoutMs !== undefined){
        const controller = new AbortController();
        if(external){
            if(external.aborted){ controller.abort(external.reason); }
            else {
                const forward = () => controller.abort(external.reason);
                external.addEventListener("abort", forward, { once: true });
                detach = () => external.removeEventListener("abort", forward);
            }
        }
        timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        signal = controller.signal;
    }
    return {
        signal,
        timedOut: () => timedOut,
        clear: () => { if(timeoutId !== undefined) clearTimeout(timeoutId); detach?.(); },
    };
};

const errorFromFunctionError = (functionError: LambderInvokeFunctionError): Error => {
    const error = new Error(functionError.errorMessage ?? "the function failed");
    error.name = functionError.errorType ?? "FunctionError";
    if(functionError.trace?.length) error.stack = functionError.trace.join("\n");
    return error;
};

const parseFunctionError = (result: unknown): LambderInvokeFunctionError => {
    if(result && typeof result === "object"){
        const { errorType, errorMessage, trace } = result as Record<string, unknown>;
        return {
            ...(typeof errorType === "string" ? { errorType } : {}),
            ...(typeof errorMessage === "string" ? { errorMessage } : {}),
            ...(Array.isArray(trace) ? { trace: trace.map(String) } : {}),
        };
    }
    return { errorMessage: typeof result === "string" ? result : undefined };
};

/** The one-line detail a failure's message ends with. */
const describeFailure = (init: Omit<LambderInvokeErrorInit, "message" | "apiName" | "functionName" | "logList">): string => {
    if(init.crash) return init.crash.message;
    if(init.functionError) return `${init.functionError.errorType ?? "FunctionError"}: ${init.functionError.errorMessage ?? "the function failed"}`;
    if(init.errorMessage !== undefined){
        const content = (init.errorMessage as { content?: unknown })?.content;
        if(typeof content === "string") return content;
        if(typeof init.errorMessage === "string") return init.errorMessage;
        try { return JSON.stringify(init.errorMessage); } catch { return String(init.errorMessage); }
    }
    if(init.reason === 'validation') return "the callee rejected the input";
    if(init.reason === 'versionExpired') return "the callee answered versionExpired";
    if(init.reason === 'sessionExpired') return "the callee answered sessionExpired";
    if(init.reason === 'notAuthorized') return "the callee answered notAuthorized";
    if(init.cause instanceof Error) return init.cause.message;
    return init.status !== undefined ? `HTTP ${init.status}` : "no answer";
};

// ---------------------------------------------------------------------------
// The caller
// ---------------------------------------------------------------------------

type FailureInit = Omit<LambderInvokeErrorInit, "message" | "apiName" | "functionName" | "logList"> & {
    logList?: unknown[];
    /** The parsed envelope, when one came back. */
    response?: LambderApiResponse<any>;
    /** Replaces the derived one-line detail in the error message. */
    detail?: string;
};

/**
 * @typeParam TContract - The callee's API contract (`typeof lambder.ApiContract`, imported type-only), for typed names, payloads, results and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderInvokeCaller<TContract extends ApiContractShape = any, TProvidedGuards extends string = never> {
    private readonly functionName: string;
    private readonly apiPath: string;
    private readonly apiVersion?: string;
    private readonly host: string;
    private readonly requestCompression: LambderCompressionSettings | null;
    private readonly maxResponsePayloadBytes: number;
    private readonly timeoutMs?: number;
    private readonly onLogList?: LambderInvokeCallerBaseOptions["onLogList"];
    private readonly onFailure?: LambderInvokeCallerBaseOptions["onFailure"];
    private readonly guardInputsProvider?: (apiName: string) => unknown;
    private readonly sessionTokenCookieKey: string;
    private readonly transport: LambderInvokeTransport;
    private readonly clientConfig: LambdaClientConfig | undefined;
    private client: LambdaClient | undefined;
    private sdk: Promise<typeof import("@aws-sdk/client-lambda")> | undefined;

    constructor(options: LambderInvokeCallerOptions<TContract, TProvidedGuards>){
        const {
            functionName, client, clientConfig, apiPath, apiVersion, host,
            requestCompression, maxResponsePayloadBytes, timeoutMs,
            onLogList, onFailure, sessionTokenCookieKey, transport, guardInputsProvider,
        } = options as LambderInvokeCallerBaseOptions & { guardInputsProvider?: (apiName: string) => unknown };
        if(!functionName?.trim()) throw new Error("LambderInvokeCaller: functionName is required");
        this.functionName = functionName;
        this.client = client;
        this.clientConfig = clientConfig;
        this.apiPath = apiPath ?? "/api";
        this.apiVersion = apiVersion;
        this.host = host ?? functionName;
        // `?? false`: like the browser caller, off unless asked for.
        this.requestCompression = resolveCompressionOption(requestCompression ?? false, DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS);
        this.maxResponsePayloadBytes = maxResponsePayloadBytes ?? DEFAULT_MAX_RESTORED_PAYLOAD_BYTES;
        if(!Number.isSafeInteger(this.maxResponsePayloadBytes) || this.maxResponsePayloadBytes <= 0){
            throw new Error("LambderInvokeCaller: maxResponsePayloadBytes must be a positive integer");
        }
        this.timeoutMs = timeoutMs;
        this.onLogList = onLogList;
        this.onFailure = onFailure;
        this.guardInputsProvider = guardInputsProvider;
        this.sessionTokenCookieKey = sessionTokenCookieKey ?? DEFAULT_SESSION_TOKEN_COOKIE_KEY;
        this.transport = transport ?? ((_event, { eventJson, signal }) => this.invokeThroughSdk(eventJson, signal));
    }

    /**
     * The event api() would send for this call, with a plain payload. For
     * tests and boot checks that hand a built package an event file.
     */
    static createEvent(init: LambderInvokeEventInit): APIGatewayProxyEventV2 {
        const host = init.host ?? "lambder-invoke";
        const tokenCookieKey = init.sessionTokenCookieKey ?? DEFAULT_SESSION_TOKEN_COOKIE_KEY;
        return synthesizeHttpEvent({
            method: "POST",
            path: init.apiPath ?? "/api",
            host,
            headers: init.headers,
            clientIp: init.clientIp,
            cookies: sessionCookies(init.session, tokenCookieKey),
            body: buildEnvelopeJson({
                apiName: init.apiName,
                version: init.apiVersion,
                csrf: init.session?.csrf,
                siteHost: host,
                payloadJson: init.payload !== undefined ? JSON.stringify(init.payload) : undefined,
                guardInputs: init.guardInputs,
                idempotencyKey: init.idempotencyKey,
            }),
        });
    }

    /**
     * A transport that runs a callee's handler in this process, the way
     * Lambda would: a thrown error becomes a FunctionError payload. For
     * tests that want the real handlers behind the real envelope.
     */
    static localTransport(
        handler: (event: APIGatewayProxyEventV2, context: Context) => Promise<unknown>,
        context: Partial<Context> = {},
    ): LambderInvokeTransport {
        return async (event, { functionName }) => {
            const lambdaContext = {
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
                ...context,
            } as Context;
            try {
                return { functionError: null, result: await handler(event, lambdaContext) };
            } catch(err){
                const error = err instanceof Error ? err : new Error(String(err));
                return {
                    functionError: "Unhandled",
                    result: { errorType: error.name, errorMessage: error.message, trace: (error.stack ?? "").split("\n") },
                };
            }
        };
    }

    private loadSdk(){
        if(!this.sdk){
            this.sdk = import("@aws-sdk/client-lambda").catch(() => {
                throw new Error("LambderInvokeCaller requires @aws-sdk/client-lambda: npm install @aws-sdk/client-lambda");
            });
        }
        return this.sdk;
    }

    private async invokeThroughSdk(eventJson: string, signal: AbortSignal | undefined): Promise<LambderInvokeTransportResult> {
        const { LambdaClient, InvokeCommand } = await this.loadSdk();
        if(!this.client) this.client = new LambdaClient(this.clientConfig ?? {});
        const output = await this.client.send(new InvokeCommand({
            FunctionName: this.functionName,
            InvocationType: "RequestResponse",
            Payload: Buffer.from(eventJson, "utf8"),
        }), signal ? { abortSignal: signal } : undefined);
        const text = output.Payload ? Buffer.from(output.Payload).toString("utf8") : "";
        let result: unknown = undefined;
        if(text){
            try { result = JSON.parse(text); } catch { result = text; }
        }
        return { functionError: output.FunctionError ?? null, result };
    }

    /** Delivers one event, serialized exactly once; a rejected transport is a network or timeout failure. */
    private async deliver(
        event: APIGatewayProxyEventV2,
        eventJson: string,
        options: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<{ sent: LambderInvokeTransportResult } | { failed: FailureInit }> {
        const abort = abortAfter(options.timeoutMs ?? this.timeoutMs, options.signal);
        try {
            const sent = await this.transport(event, { functionName: this.functionName, eventJson, signal: abort.signal });
            return { sent };
        } catch(err){
            const cause = err instanceof Error ? err : new Error(String(err));
            return { failed: { reason: abort.timedOut() ? 'timeout' : 'network', cause } };
        } finally {
            abort.clear();
        }
    }

    /** The function's answer as an HTTP result; throws when it is not one, or its compressed body cannot be restored. */
    private async decodeHttpResult(result: unknown): Promise<LambderInvokeHttpResult> {
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
        for(const [key, value] of Object.entries(raw.headers ?? {})) headers[key.toLowerCase()] = value;
        for(const [key, values] of Object.entries(raw.multiValueHeaders ?? {})) headers[key.toLowerCase()] = values.join(", ");
        let body: Buffer = raw.body ? Buffer.from(raw.body, raw.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0);
        const encoding = headers["content-encoding"]?.trim().toLowerCase();
        if(encoding === "br" || encoding === "gzip"){
            // restoreBytes, not restoreText: a route may answer compressed
            // binary (a wasm module, anything it forced compression on), and
            // decoding that as UTF-8 first would replace every byte that is
            // not valid UTF-8 and hand back a silently different body.
            body = await restoreBytes(body, encoding, { maxBytes: this.maxResponsePayloadBytes });
        }else if(encoding){
            throw new Error(`the answer carries an unsupported Content-Encoding "${encoding}"`);
        }
        return {
            statusCode: raw.statusCode,
            headers,
            cookies: raw.cookies ?? [],
            body,
            text: () => body.toString("utf8"),
            json: () => JSON.parse(body.toString("utf8")),
        };
    }

    /** Builds the failure and its error, reports it once, and hands it back. */
    private async fail(apiName: string, init: FailureInit): Promise<LambderInvokeFailure> {
        const logList = init.logList ?? [];
        const cause = init.crash ? errorFromCrashDetail(init.crash)
            : init.functionError ? errorFromFunctionError(init.functionError)
            : init.cause;
        const detail = init.detail ?? describeFailure(init);
        const error = new LambderInvokeError({
            message: `${this.functionName} ${apiName} failed (${init.reason}): ${detail}`,
            reason: init.reason,
            apiName,
            functionName: this.functionName,
            status: init.status,
            errorMessage: init.errorMessage,
            crash: init.crash,
            functionError: init.functionError,
            logList,
            zodError: init.zodError,
            retryAfterSeconds: init.retryAfterSeconds,
            bytes: init.bytes,
            cause,
        });
        const failure: LambderInvokeFailure = {
            ok: false,
            reason: init.reason,
            error,
            logList,
            ...(init.status !== undefined ? { status: init.status } : {}),
            ...(init.errorMessage !== undefined ? { errorMessage: init.errorMessage } : {}),
            ...(init.retryAfterSeconds !== undefined ? { retryAfterSeconds: init.retryAfterSeconds } : {}),
            ...(init.zodError !== undefined ? { zodError: init.zodError } : {}),
            ...(init.crash !== undefined ? { crash: init.crash } : {}),
            ...(init.functionError !== undefined ? { functionError: init.functionError } : {}),
            ...(init.bytes !== undefined ? { bytes: init.bytes } : {}),
        };
        if(init.response !== undefined) failure.response = init.response;
        error.outcome = failure;
        if(this.onFailure){
            // A reporting hook that breaks must not turn apiOutcome() into a
            // throwing call, nor replace the failure it was told about.
            try { await this.onFailure(failure, { apiName, functionName: this.functionName }); }
            catch(err){ console.error(`[lambder invoke] onFailure threw for ${this.functionName} ${apiName}`, err); }
        }
        return failure;
    }

    private async surfaceLogs(apiName: string, logList: unknown[]): Promise<void> {
        if(!logList.length) return;
        if(this.onLogList){
            try { await this.onLogList(apiName, logList); }
            catch(err){ console.error(`[lambder invoke] onLogList threw for ${this.functionName} ${apiName}`, err); }
            return;
        }
        for(const entry of logList) console.log(`[lambder invoke] ${this.functionName} ${apiName}`, entry);
    }

    /** One call, one outcome. Never throws; api() is what throws. */
    private async dispatch<TOutput>(
        apiName: string,
        payload: unknown,
        options: LambderInvokeCallOptions = {},
    ): Promise<LambderInvokeOutcome<TOutput>> {
        // Everything that happens before the event leaves: the guardInputs
        // provider, the payload's JSON and its compression. All of it can
        // throw on the caller's own inputs (a provider that rejects, a
        // payload holding a cycle or a BigInt), and none of it may escape:
        // apiOutcome() promises an outcome, api() promises a
        // LambderInvokeError, and onFailure is the one place failures are
        // reported. So a throw here is an 'unknown' failure like any other.
        let event: APIGatewayProxyEventV2;
        let eventJson: string;
        let bytes: number;
        try {
            // Provider values underneath, per-call values on top.
            const provided = this.guardInputsProvider
                ? await this.guardInputsProvider(apiName) as Record<string, unknown> | undefined
                : undefined;
            const guardInputs = mergeGuardInputs(provided, options.guardInputs);

            // The payload is serialized once: the compression decision needs
            // its JSON, and when it goes plainly that same JSON is spliced
            // into the envelope. Compressed when enabled and the JSON reaches
            // the threshold; `compressRequest` overrides both ways.
            const payloadJson = payload !== undefined ? JSON.stringify(payload) : undefined;
            const compressionMinBytes = options.compressRequest === true ? 0
                : options.compressRequest === false ? null
                : this.requestCompression?.minBytes ?? null;
            const compressed = compressionMinBytes !== null && payloadJson !== undefined
                ? await compressPayloadBrotli(payloadJson, compressionMinBytes, this.requestCompression?.quality ?? DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS.quality)
                : null;

            event = synthesizeHttpEvent({
                method: "POST",
                path: this.apiPath,
                host: this.host,
                headers: options.headers,
                clientIp: options.clientIp,
                cookies: sessionCookies(options.session, this.sessionTokenCookieKey),
                body: buildEnvelopeJson({
                    apiName,
                    version: this.apiVersion,
                    csrf: options.session?.csrf,
                    siteHost: this.host,
                    payloadJson: compressed ? undefined : payloadJson,
                    compressed,
                    guardInputs,
                    idempotencyKey: options.idempotencyKey,
                }),
            });

            // Serialized once here; the size guard and the SDK transport both use it.
            eventJson = JSON.stringify(event);
            bytes = Buffer.byteLength(eventJson, "utf8");
        } catch(err){
            return await this.fail(apiName, { reason: 'unknown', cause: err instanceof Error ? err : new Error(String(err)) });
        }

        if(bytes > LAMBDER_INVOKE_MAX_EVENT_BYTES){
            return await this.fail(apiName, {
                reason: 'payloadTooLarge', bytes,
                detail: `the event is ${bytes} bytes, over the ${LAMBDER_INVOKE_MAX_EVENT_BYTES} byte invoke cap`,
            });
        }

        const delivery = await this.deliver(event, eventJson, options);
        if("failed" in delivery) return await this.fail(apiName, delivery.failed);
        if(delivery.sent.functionError){
            return await this.fail(apiName, { reason: 'crash', functionError: parseFunctionError(delivery.sent.result) });
        }

        let http: LambderInvokeHttpResult;
        try {
            http = await this.decodeHttpResult(delivery.sent.result);
        } catch(err){
            const cause = err instanceof Error ? err : new Error(String(err));
            return await this.fail(apiName, { reason: 'protocol', cause, detail: cause.message });
        }

        const outcome = await resolveApiOutcome<TOutput>({
            status: http.statusCode,
            header: (name) => http.headers[name.toLowerCase()] ?? null,
            json: async () => http.json(),
            text: async () => http.text(),
        });
        const logList = outcome.response?.logList ?? [];
        await this.surfaceLogs(apiName, logList);
        // The declared output, by the callee's own typing: res.api(null) compiles
        // only for an output that allows null or beside a reason (an errorMessage
        // is a failure below; a message-only null is the callee's contract to keep).
        if(outcome.ok) return { ok: true, payload: (outcome.payload ?? null) as TOutput, response: outcome.response, logList };

        // A 404 text page is what a callee answers when apiPath does not
        // match: the one misconfiguration every first integration hits.
        const detail = http.statusCode === 404 && outcome.reason === 'server'
            ? `no API at ${this.apiPath} on ${this.functionName} (HTTP 404): does apiPath match the callee's?`
            : undefined;
        return await this.fail(apiName, {
            reason: outcome.reason,
            status: outcome.status,
            errorMessage: outcome.errorMessage,
            retryAfterSeconds: outcome.retryAfterSeconds,
            zodError: outcome.zodError,
            response: outcome.response,
            crash: outcome.response?.crash,
            logList,
            cause: outcome.error,
            detail,
        });
    }

    /**
     * Full-fidelity call: resolves to a discriminated LambderInvokeOutcome
     * instead of throwing. Never throws; for sites that degrade gracefully.
     */
    async apiOutcome<
        TApiName extends keyof TContract & string = string,
        TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any
    >(
        apiName: TApiName,
        payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any,
        ...rest: LambderCallOptionsArg<TContract, TApiName, TProvidedGuards, LambderInvokeCallOptions>
    ): Promise<LambderInvokeOutcome<TOutput>> {
        return await this.dispatch<TOutput>(apiName, payload, rest[0]);
    }

    /**
     * The declared output, or a thrown LambderInvokeError carrying the
     * outcome. A failed dependency is a failed request: the throw reaches the
     * app's global error handler with the callee's error as its cause. The
     * result is the callee's output type as it declared it: the resolver
     * only lets a handler answer null when the output allows it or beside a
     * reason (LambderApiAnswer), so a nullable output is the one place null
     * arrives.
     */
    async api<
        TApiName extends keyof TContract & string = string,
        TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any
    >(
        apiName: TApiName,
        payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any,
        ...rest: LambderCallOptionsArg<TContract, TApiName, TProvidedGuards, LambderInvokeCallOptions>
    ): Promise<TOutput> {
        const outcome = await this.dispatch<TOutput>(apiName, payload, rest[0]);
        if(!outcome.ok) throw outcome.error;
        return outcome.payload;
    }

    /**
     * Any route of the callee, untyped: the synthesized request and the
     * decoded answer, whatever its status. Throws a LambderInvokeError only
     * when no HTTP answer came back (a rejected invoke, a FunctionError, a
     * non-HTTP answer); those go through onFailure like an API call's.
     */
    async request(init: LambderInvokeRequestInit): Promise<LambderInvokeHttpResult> {
        const method = (init.method ?? "GET").toUpperCase();
        const name = `${method} ${init.path}`;
        const event = synthesizeHttpEvent({
            method,
            path: init.path,
            query: init.query,
            host: this.host,
            headers: init.headers,
            clientIp: init.clientIp,
            cookies: init.cookies,
            body: init.body,
        });
        const delivery = await this.deliver(event, JSON.stringify(event), init);
        if("failed" in delivery) throw (await this.fail(name, delivery.failed)).error;
        if(delivery.sent.functionError){
            throw (await this.fail(name, { reason: 'crash', functionError: parseFunctionError(delivery.sent.result) })).error;
        }
        try {
            return await this.decodeHttpResult(delivery.sent.result);
        } catch(err){
            const cause = err instanceof Error ? err : new Error(String(err));
            throw (await this.fail(name, { reason: 'protocol', cause, detail: cause.message })).error;
        }
    }
}

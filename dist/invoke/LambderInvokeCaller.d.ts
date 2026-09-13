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
import { type LambderApiFailureReason, type LambderValidationError } from "../shared/LambderApiOutcome.js";
import { type LambderCallOptionsArg, type LambderGuardInputsProviderOption } from "../shared/LambderCallOptions.js";
import { type LambderCrashDetail } from "../shared/LambderCrashDetail.js";
import { type LambderCompressionOption, type LambderCompressionSettings } from "../shared/LambderCompressionOption.js";
import { type LambderCompressedBrotliPayload } from "../shared/LambderRequestPayload.js";
/** Marks a synthesized request as an invoke, for guards and hooks that want to tell. Not an authorization. */
export declare const LAMBDER_INVOKE_HEADER = "x-lambder-invoke";
/** The invoking function's name, when the caller runs in Lambda; for the callee's logs. */
export declare const LAMBDER_INVOKED_BY_HEADER = "x-lambder-invoked-by";
/** The value of the marker header; a future incompatible event shape would bump it. */
export declare const LAMBDER_INVOKE_PROTOCOL = "1";
/**
 * Lambda caps a synchronous invoke's request and its response at about 6MB;
 * the same guard threshold finalizeResponse applies to an answer, applied
 * here to the event before it is sent.
 */
export declare const LAMBDER_INVOKE_MAX_EVENT_BYTES = 5500000;
/** Request Brotli when `requestCompression: true`: the HTTP request threshold, at the quality every other Lambder site uses. */
export declare const DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS: LambderCompressionSettings;
export type LambderInvokeFailureReason = LambderApiFailureReason | 'crash' | 'protocol' | 'payloadTooLarge';
/** Lambda's own error payload for a FunctionError invocation. */
export type LambderInvokeFunctionError = {
    errorType?: string;
    errorMessage?: string;
    trace?: string[];
};
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
export type LambderInvokeOutcome<T> = {
    ok: true;
    payload: T;
    response: LambderApiResponse<T>;
    logList: unknown[];
} | LambderInvokeFailure;
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
export declare class LambderInvokeError extends Error {
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
    outcome: LambderInvokeFailure;
    constructor(init: LambderInvokeErrorInit);
}
/** Brand-based type guard (see LambderInvokeError.isLambderInvokeError). */
export declare const isLambderInvokeError: (err: unknown) => err is LambderInvokeError;
/** What a transport hands back: Lambda's FunctionError marker (null when the function returned normally) and the parsed JSON it returned. */
export type LambderInvokeTransportResult = {
    functionError: string | null;
    result: unknown;
};
/**
 * Delivers one synthesized event and returns what the function answered;
 * rejects when the invoke itself failed. `eventJson` is the event serialized
 * once by the caller: the SDK transport sends those bytes as they are, and a
 * custom transport that works from the object may ignore it.
 */
export type LambderInvokeTransport = (event: APIGatewayProxyEventV2, options: {
    functionName: string;
    eventJson: string;
    signal?: AbortSignal;
}) => Promise<LambderInvokeTransportResult>;
/** The onLogList option: each answer's logList, success or failure, when it has entries. */
export type LambderInvokeLogListHandler = (apiName: string, logList: unknown[]) => void | Promise<void>;
/** The onFailure option: every failed call, once, awaited before api() throws or apiOutcome() returns. */
export type LambderInvokeFailureHandler = (failure: LambderInvokeFailure, info: {
    apiName: string;
    functionName: string;
}) => void | Promise<void>;
/** A session carried on a user's behalf: the two values a browser holds. */
export type LambderInvokeSession = {
    token: string;
    csrf: string;
};
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
export type LambderInvokeCallerOptions<TContract, TProvided extends string = never> = LambderInvokeCallerBaseOptions & LambderGuardInputsProviderOption<TContract, TProvided>;
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
/**
 * Brotli one payload's JSON for sending, or null when the plain JSON should
 * go instead: the browser's compressPayloadGzip with Brotli, because both
 * ends are Node. The threshold and the only-when-smaller rule are
 * compressPayloadWith's, shared with the gzip side.
 */
export declare const compressPayloadBrotli: (json: string, minBytes: number, quality: number) => Promise<LambderCompressedBrotliPayload | null>;
/**
 * @typeParam TContract - The callee's API contract (`typeof lambder.ApiContract`, imported type-only), for typed names, payloads, results and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderInvokeCaller<TContract extends ApiContractShape = any, TProvidedGuards extends string = never> {
    private readonly functionName;
    private readonly apiPath;
    private readonly apiVersion?;
    private readonly host;
    private readonly requestCompression;
    private readonly maxResponsePayloadBytes;
    private readonly timeoutMs?;
    private readonly onLogList?;
    private readonly onFailure?;
    private readonly guardInputsProvider?;
    private readonly sessionTokenCookieKey;
    private readonly transport;
    private readonly clientConfig;
    private client;
    private sdk;
    constructor(options: LambderInvokeCallerOptions<TContract, TProvidedGuards>);
    /**
     * The event api() would send for this call, with a plain payload. For
     * tests and boot checks that hand a built package an event file.
     */
    static createEvent(init: LambderInvokeEventInit): APIGatewayProxyEventV2;
    /**
     * A transport that runs a callee's handler in this process, the way
     * Lambda would: a thrown error becomes a FunctionError payload. For
     * tests that want the real handlers behind the real envelope.
     */
    static localTransport(handler: (event: APIGatewayProxyEventV2, context: Context) => Promise<unknown>, context?: Partial<Context>): LambderInvokeTransport;
    private loadSdk;
    private invokeThroughSdk;
    /** Delivers one event, serialized exactly once; a rejected transport is a network or timeout failure. */
    private deliver;
    /** The function's answer as an HTTP result; throws when it is not one, or its compressed body cannot be restored. */
    private decodeHttpResult;
    /** Builds the failure and its error, reports it once, and hands it back. */
    private fail;
    private surfaceLogs;
    /** One call, one outcome. Never throws; api() is what throws. */
    private dispatch;
    /**
     * Full-fidelity call: resolves to a discriminated LambderInvokeOutcome
     * instead of throwing. Never throws; for sites that degrade gracefully.
     */
    apiOutcome<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, ...rest: LambderCallOptionsArg<TContract, TApiName, TProvidedGuards, LambderInvokeCallOptions>): Promise<LambderInvokeOutcome<TOutput>>;
    /**
     * The declared output, or a thrown LambderInvokeError carrying the
     * outcome. A failed dependency is a failed request: the throw reaches the
     * app's global error handler with the callee's error as its cause. The
     * result is the callee's output type as it declared it: the resolver
     * only lets a handler answer null when the output allows it or beside a
     * reason (LambderApiAnswer), so a nullable output is the one place null
     * arrives.
     */
    api<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, ...rest: LambderCallOptionsArg<TContract, TApiName, TProvidedGuards, LambderInvokeCallOptions>): Promise<TOutput>;
    /**
     * Any route of the callee, untyped: the synthesized request and the
     * decoded answer, whatever its status. Throws a LambderInvokeError only
     * when no HTTP answer came back (a rejected invoke, a FunctionError, a
     * non-HTTP answer); those go through onFailure like an API call's.
     */
    request(init: LambderInvokeRequestInit): Promise<LambderInvokeHttpResult>;
}
export {};

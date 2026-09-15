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
import { type LambderInvokeFailure, type LambderInvokeOutcome } from "./LambderInvokeOutcome.js";
import { type LambderApiSignatureMap } from "../shared/wire/LambderApiSignature.js";
import type { LambdaClient, LambdaClientConfig } from "@aws-sdk/client-lambda";
import type { LambderApiContractShape } from "../shared/wire/LambderApiContract.js";
import { type LambderCallArgs, type LambderContractOutputOf, type LambderGuardInputsProviderOption, type LambderSharedCallOptions } from "../shared/wire/LambderCallOptions.js";
import { type LambderCompressionOption } from "../shared/wire/LambderCompressionOption.js";
import { type LambderInvokeSession, type LambderLambdaHttpResult } from "./LambderLambdaEvent.js";
/**
 * Lambda caps a synchronous invoke's request and its response at about 6MB;
 * the same guard threshold finalizeResponse applies to an answer, applied
 * here to the event before it is sent.
 */
export declare const LAMBDER_INVOKE_MAX_EVENT_BYTES = 5500000;
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
/**
 * Per-call options: the request extras both callers share (see
 * LambderSharedCallOptions; a timeout here bounds the wait only, since the
 * callee keeps running regardless) plus the two an invoke has of its own.
 */
export type LambderInvokeCallOptions = LambderSharedCallOptions & {
    /** The address the callee sees as ctx.ip: it becomes the synthesized event's requestContext.http.sourceIp. Empty when the call supplies none. */
    clientIp?: string;
    /** A user's session, so a session API on the callee runs on their behalf. */
    session?: LambderInvokeSession;
};
type LambderInvokeCallerBaseOptions = {
    /** Function name or ARN. */
    functionName: string;
    /**
     * A ready client, e.g. one shared with the rest of the app. It keeps
     * whatever `maxAttempts` it was built with, which is the SDK's own 3
     * unless the app said otherwise: `clientConfig` below is not consulted
     * for a client this caller did not create, and a retry at that layer
     * re-executes a callee whose response was merely lost. Build it with
     * `{ maxAttempts: 1 }`, or send an `idempotencyKey` and let the callee
     * settle the repeat.
     */
    client?: LambdaClient;
    /**
     * Otherwise the client is created from this on the first call (region,
     * credentials, maxAttempts). `maxAttempts` defaults to 1 here rather than
     * to the SDK's 3: a RequestResponse invoke whose response is lost has
     * already run the callee, so a retry at this layer executes the operation
     * a second time, and the transport contract says one call is one delivery
     * attempt. Raise it deliberately if the callee is idempotent, or send an
     * `idempotencyKey` and let the callee settle it.
     */
    clientConfig?: LambdaClientConfig;
    /** Must match the callee's apiPath. Default: "/api". */
    apiPath?: string;
    /** Sent as `version`, informational: the callee stamps its own on every answer. Default: none. */
    apiVersion?: string;
    /**
     * The callee's signature map, generated from its instance
     * (Lambder.apiSignatures()) when this caller was built. Sent per call as
     * `signature`, so the callee answers versionExpired to a call built
     * against another shape of the endpoint. Default: none, and no gate.
     */
    apiSignatures?: LambderApiSignatureMap;
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
    /** The caller's signature for the endpoint, out of the callee's map. */
    signature?: string;
    guardInputs?: Record<string, unknown>;
    idempotencyKey?: string;
    clientIp?: string;
    headers?: Record<string, string>;
    session?: LambderInvokeSession;
    sessionTokenCookieKey?: string;
};
/**
 * @typeParam TContract - The callee's API contract (`typeof lambder.ApiContract`, imported type-only), for typed names, payloads, results and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderInvokeCaller<TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never> {
    private readonly functionName;
    private readonly apiPath;
    private readonly apiVersion?;
    private readonly apiSignatures?;
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
     *
     * It honours the signal the way lambderHandlerTransport does, by ending
     * the wait: a function call in this process cannot be cancelled, so the
     * handler runs to completion regardless and what a timeout buys is the
     * caller's answer. Ignoring it made timeoutMs a no-op here.
     */
    static localTransport(handler: (event: APIGatewayProxyEventV2, context: Context) => Promise<unknown>, context?: Partial<Context>): LambderInvokeTransport;
    private loadSdk;
    private invokeThroughSdk;
    /** Delivers one event, serialized exactly once; an event over the invoke cap, a rejected transport, or one that answered after the call was given up on, is a failure. */
    private deliverEvent;
    /** Builds the failure and its error, reports it once, and hands it back. */
    private failureOutcome;
    private surfaceLogs;
    /** One call, one outcome. Never throws; api() is what throws. */
    private dispatch;
    /**
     * Full-fidelity call: resolves to a discriminated LambderInvokeOutcome
     * instead of throwing. Never throws; for sites that degrade gracefully.
     *
     * The output is computed from the contract in the return type rather than
     * taken as a type parameter, so a call site cannot replace it by
     * annotating what it assigns to.
     */
    apiOutcome<TApiName extends keyof TContract & string = string>(apiName: TApiName, ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderInvokeCallOptions>): Promise<LambderInvokeOutcome<LambderContractOutputOf<TContract, TApiName>>>;
    /**
     * The declared output, or a thrown LambderInvokeError carrying the
     * outcome. A failed dependency is a failed request: the throw reaches the
     * app's global error handler with the callee's error as its cause. The
     * result is the callee's output type as it declared it: the resolver
     * only lets a handler answer null when the output allows it or beside a
     * reason (LambderApiAnswer), so a nullable output is the one place null
     * arrives.
     */
    api<TApiName extends keyof TContract & string = string>(apiName: TApiName, ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderInvokeCallOptions>): Promise<LambderContractOutputOf<TContract, TApiName>>;
    /**
     * Any route of the callee, untyped: the synthesized request and the
     * decoded answer, whatever its status. Throws a LambderInvokeError only
     * when no HTTP answer came back (a rejected invoke, a FunctionError, a
     * non-HTTP answer); those go through onFailure like an API call's.
     */
    request(init: LambderInvokeRequestInit): Promise<LambderLambdaHttpResult>;
}
export {};

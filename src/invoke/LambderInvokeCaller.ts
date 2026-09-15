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
import {
    classifyDeliveryFailure,
    describeFailure,
    errorFromFunctionError,
    LambderInvokeError,
    parseFunctionError,
    type LambderInvokeErrorInit,
    type LambderInvokeFailure,
    type LambderInvokeFunctionError,
    type LambderInvokeOutcome,
} from "./LambderInvokeOutcome.js";
import { DEFAULT_SESSION_TOKEN_COOKIE_KEY } from "../shared/wire/LambderSessionCookieNames.js";
import type { LambdaClient, LambdaClientConfig } from "@aws-sdk/client-lambda";
import type { LambderApiContractShape, LambderApiEnvelopeBody } from "../shared/wire/LambderApiContract.js";
import { resolveApiOutcome, type LambderValidationError } from "../shared/wire/LambderApiOutcome.js";
import {
    mergeGuardInputs,
    type LambderCallArgs,
    type LambderContractOutputOf,
    type LambderGuardInputsProviderOption,
    type LambderSharedCallOptions,
} from "../shared/wire/LambderCallOptions.js";
import { createCallAbort, stopWaitingWhenAborted } from "../shared/util/LambderCallAbort.js";
import { coerceToError, errorFromCrashDetail } from "../shared/wire/LambderCrashDetail.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { resolveCompressionOption, type LambderCompressionOption, type LambderCompressionSettings } from "../shared/wire/LambderCompressionOption.js";
import {
    DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS,
    DEFAULT_MAX_RESTORED_PAYLOAD_BYTES,
    compressPayloadBrotli,
    resolveRequestCompressionMinBytes,
} from "../shared/wire/LambderRequestPayload.js";
import {
    buildEnvelopeJson,
    decodeLambdaHttpResult,
    localLambdaContext,
    sessionCookies,
    synthesizeLambdaHttpEvent,
    type LambderInvokeSession,
    type LambderLambdaHttpResult,
} from "./LambderLambdaEvent.js";

/**
 * Lambda caps a synchronous invoke's request and its response at about 6MB;
 * the same guard threshold finalizeResponse applies to an answer, applied
 * here to the event before it is sent.
 */
export const LAMBDER_INVOKE_MAX_EVENT_BYTES = 5_500_000;

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
// The caller
// ---------------------------------------------------------------------------

/** Everything a failure may have been learned from: what the error message is built out of, and what came back with the answer. */
type FailureInitFields = Omit<LambderInvokeErrorInit, "message" | "apiName" | "functionName" | "logList" | "reason"> & {
    logList?: unknown[];
    /** The answer's Set-Cookie values, when an answer came back. */
    cookies?: string[];
    /** The parsed envelope, when one came back. */
    response?: LambderApiEnvelopeBody<any>;
    /** Replaces the derived one-line detail in the error message. */
    detail?: string;
};

/**
 * What failureOutcome() is told, by reason. The arms mirror
 * LambderInvokeFailure's, so the site that decides a reason is the site the
 * compiler asks for that reason's evidence: a validation failure without its
 * issues, or an envelope refusal without the envelope, does not compile.
 * Everything else stays optional on the shared fields, since a failure carries
 * whatever the answer happened to have.
 */
type FailureInit = FailureInitFields & (
    | { reason: 'validation'; zodError: LambderValidationError }
    | { reason: 'crash'; functionError: LambderInvokeFunctionError }
    | { reason: 'payloadTooLarge'; bytes: number }
    | { reason: 'versionExpired' | 'sessionExpired' | 'notAuthorized' | 'errorMessage'; response: LambderApiEnvelopeBody<any> }
    | { reason: 'network' | 'timeout' | 'server' | 'protocol' | 'unknown' }
);

/**
 * @typeParam TContract - The callee's API contract (`typeof lambder.ApiContract`, imported type-only), for typed names, payloads, results and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderInvokeCaller<TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never> {
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
        this.maxResponsePayloadBytes = assertPositiveInteger(
            maxResponsePayloadBytes ?? DEFAULT_MAX_RESTORED_PAYLOAD_BYTES,
            "LambderInvokeCaller maxResponsePayloadBytes",
        );
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
        return synthesizeLambdaHttpEvent({
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
        }, { invoke: true });
    }

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
    static localTransport(
        handler: (event: APIGatewayProxyEventV2, context: Context) => Promise<unknown>,
        context: Partial<Context> = {},
    ): LambderInvokeTransport {
        return async (event, { functionName, signal }) => {
            signal?.throwIfAborted();
            try {
                return {
                    functionError: null,
                    result: await stopWaitingWhenAborted(handler(event, localLambdaContext(functionName, context)), signal),
                };
            } catch(err){
                // An abort is the caller giving up, not the callee failing:
                // reporting it as a FunctionError would turn a timeout into a
                // crash outcome with an invented error payload.
                if(signal?.aborted && err === signal.reason) throw err;
                const error = coerceToError(err, "the handler failed");
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
        // One call is one delivery attempt, which is what LambderApiTransport
        // promises: the SDK's own default of 3 would re-invoke a callee that
        // already ran when only the response was lost.
        if(!this.client) this.client = new LambdaClient({ maxAttempts: 1, ...this.clientConfig });
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

    /** Delivers one event, serialized exactly once; an event over the invoke cap, a rejected transport, or one that answered after the call was given up on, is a failure. */
    private async deliverEvent(
        event: APIGatewayProxyEventV2,
        eventJson: string,
        options: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<{ sent: LambderInvokeTransportResult } | { failed: FailureInit }> {
        // Measured here rather than on the API path alone, because every
        // caller of this one sends the same bytes. A path that skips the cap
        // gets the SDK's RequestEntityTooLargeException back instead, which
        // classifies as `protocol` and names neither the size nor the cap.
        const bytes = Buffer.byteLength(eventJson, "utf8");
        if(bytes > LAMBDER_INVOKE_MAX_EVENT_BYTES){
            return { failed: {
                reason: 'payloadTooLarge', bytes,
                detail: `the event is ${bytes} bytes, over the ${LAMBDER_INVOKE_MAX_EVENT_BYTES} byte invoke cap`,
            } };
        }
        // The same wiring the browser caller uses, so the two cannot drift on
        // what a late or abandoned call means.
        const abort = createCallAbort({ timeoutMs: options.timeoutMs ?? this.timeoutMs, signal: options.signal });
        try {
            // A call the site has already given up on does not reach the
            // transport: honouring the signal is the transport's obligation
            // and not every transport does.
            const refused = abort.abortFailure("beforeSending");
            if(refused) return { failed: { reason: refused.reason, cause: refused.error, detail: refused.error.message } };

            const sent = await this.transport(event, { functionName: this.functionName, eventJson, signal: abort.signal });

            // An answer that arrives after the abort is not a success: a
            // transport that ignores the signal resolves late, and believing
            // it would report ok on a 20ms timeoutMs at 300ms, handing the
            // call site data it had already abandoned.
            const late = abort.abortFailure("afterAnswering");
            if(late) return { failed: { reason: late.reason, cause: late.error, detail: late.error.message } };
            return { sent };
        } catch(err){
            const cause = coerceToError(err, "the invoke failed");
            // The caller's own timeout wins, since only it knows about that;
            // otherwise the rejection says what it was.
            return { failed: { reason: abort.timedOut() ? 'timeout' : classifyDeliveryFailure(cause), cause } };
        } finally {
            abort.detach();
        }
    }

    /** Builds the failure and its error, reports it once, and hands it back. */
    private async failureOutcome(apiName: string, init: FailureInit): Promise<LambderInvokeFailure> {
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
        // FailureInit's arms mirror the outcome's, so each reason's evidence
        // was already demanded at the site that chose the reason; the
        // assembly is one object either way, and this is where it is named as
        // the arm it is rather than written out five times.
        const failure = {
            ok: false,
            reason: init.reason,
            error,
            logList,
            cookies: init.cookies ?? [],
            ...(init.status !== undefined ? { status: init.status } : {}),
            ...(init.errorMessage !== undefined ? { errorMessage: init.errorMessage } : {}),
            ...(init.retryAfterSeconds !== undefined ? { retryAfterSeconds: init.retryAfterSeconds } : {}),
            ...(init.zodError !== undefined ? { zodError: init.zodError } : {}),
            ...(init.crash !== undefined ? { crash: init.crash } : {}),
            ...(init.functionError !== undefined ? { functionError: init.functionError } : {}),
            ...(init.bytes !== undefined ? { bytes: init.bytes } : {}),
            ...(init.response !== undefined ? { response: init.response } : {}),
        } as LambderInvokeFailure;
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
            const compressionMinBytes = resolveRequestCompressionMinBytes(options.compressRequest, this.requestCompression);
            const compressed = compressionMinBytes !== null && payloadJson !== undefined
                ? await compressPayloadBrotli(payloadJson, compressionMinBytes, this.requestCompression?.quality ?? DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS.quality)
                : null;

            event = synthesizeLambdaHttpEvent({
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
            }, { invoke: true });

            // Serialized once here; the size guard and the SDK transport both use it.
            eventJson = JSON.stringify(event);
        } catch(err){
            return await this.failureOutcome(apiName, { reason: 'unknown', cause: coerceToError(err, "the call could not be built") });
        }

        const delivery = await this.deliverEvent(event, eventJson, options);
        if("failed" in delivery) return await this.failureOutcome(apiName, delivery.failed);
        if(delivery.sent.functionError){
            return await this.failureOutcome(apiName, { reason: 'crash', functionError: parseFunctionError(delivery.sent.result) });
        }

        let http: LambderLambdaHttpResult;
        try {
            http = await decodeLambdaHttpResult(delivery.sent.result, this.maxResponsePayloadBytes);
        } catch(err){
            const cause = coerceToError(err, "the answer could not be decoded");
            return await this.failureOutcome(apiName, { reason: 'protocol', cause, detail: cause.message });
        }

        const outcome = await resolveApiOutcome<TOutput>({
            status: http.statusCode,
            header: (name) => http.headers[name.toLowerCase()] ?? null,
            json: async () => http.json(),
            text: async () => http.text(),
        });
        // Every answer's logs, from the one field the mapping puts them on:
        // an envelope's, a 500 body's, and a rejected input's, which the
        // callee writes onto the validation body as it does onto a success.
        const logList = outcome.logList ?? [];
        await this.surfaceLogs(apiName, logList);
        // The answer's Set-Cookie values, so a session the callee rotated or
        // cleared is visible to whoever is carrying it.
        const cookies = http.cookies;
        // The declared output, by the callee's own typing: res.api(null) compiles
        // only for an output that allows null or beside a reason (an errorMessage
        // is a failure below; a message-only null is the callee's contract to keep).
        if(outcome.ok) return { ok: true, payload: (outcome.payload ?? null) as TOutput, response: outcome.response, logList, cookies };

        const shared = { status: outcome.status, retryAfterSeconds: outcome.retryAfterSeconds, logList, cookies };
        // Each failure reason carries different evidence, and the outcome
        // union says which: a rejected input has its issues and no envelope,
        // an envelope refusal has the envelope and no Error.
        if(outcome.reason === 'validation'){
            return await this.failureOutcome(apiName, { ...shared, reason: 'validation', zodError: outcome.zodError });
        }
        if(outcome.reason === 'server'){
            // A 404 text page is what a callee answers when apiPath does not
            // match: the one misconfiguration every first integration hits.
            const detail = http.statusCode === 404
                ? `no API at ${this.apiPath} on ${this.functionName} (HTTP 404): does apiPath match the callee's?`
                : undefined;
            return await this.failureOutcome(apiName, {
                ...shared,
                reason: 'server',
                errorMessage: outcome.errorMessage,
                response: outcome.response,
                crash: outcome.response?.crash,
                cause: outcome.error,
                detail,
            });
        }
        return await this.failureOutcome(apiName, {
            ...shared,
            reason: outcome.reason,
            errorMessage: outcome.errorMessage,
            response: outcome.response,
            crash: outcome.response.crash,
        });
    }

    /**
     * Full-fidelity call: resolves to a discriminated LambderInvokeOutcome
     * instead of throwing. Never throws; for sites that degrade gracefully.
     *
     * The output is computed from the contract in the return type rather than
     * taken as a type parameter, so a call site cannot replace it by
     * annotating what it assigns to.
     */
    async apiOutcome<TApiName extends keyof TContract & string = string>(
        apiName: TApiName,
        ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderInvokeCallOptions>
    ): Promise<LambderInvokeOutcome<LambderContractOutputOf<TContract, TApiName>>> {
        // The tuple is a conditional type on an unresolved TApiName, so its
        // elements read as unknown from inside; the contract shaped them on
        // the way in, which is where the guarantee belongs.
        const [payload, options] = rest as [unknown, LambderInvokeCallOptions | undefined];
        return await this.dispatch<LambderContractOutputOf<TContract, TApiName>>(apiName, payload, options);
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
    async api<TApiName extends keyof TContract & string = string>(
        apiName: TApiName,
        ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderInvokeCallOptions>
    ): Promise<LambderContractOutputOf<TContract, TApiName>> {
        const [payload, options] = rest as [unknown, LambderInvokeCallOptions | undefined];
        const outcome = await this.dispatch<LambderContractOutputOf<TContract, TApiName>>(apiName, payload, options);
        if(!outcome.ok) throw outcome.error;
        return outcome.payload;
    }

    /**
     * Any route of the callee, untyped: the synthesized request and the
     * decoded answer, whatever its status. Throws a LambderInvokeError only
     * when no HTTP answer came back (a rejected invoke, a FunctionError, a
     * non-HTTP answer); those go through onFailure like an API call's.
     */
    async request(init: LambderInvokeRequestInit): Promise<LambderLambdaHttpResult> {
        const method = (init.method ?? "GET").toUpperCase();
        const name = `${method} ${init.path}`;
        const event = synthesizeLambdaHttpEvent({
            method,
            path: init.path,
            query: init.query,
            host: this.host,
            headers: init.headers,
            clientIp: init.clientIp,
            cookies: init.cookies,
            body: init.body,
        }, { invoke: true });
        const delivery = await this.deliverEvent(event, JSON.stringify(event), init);
        if("failed" in delivery) throw (await this.failureOutcome(name, delivery.failed)).error;
        if(delivery.sent.functionError){
            throw (await this.failureOutcome(name, { reason: 'crash', functionError: parseFunctionError(delivery.sent.result) })).error;
        }
        try {
            return await decodeLambdaHttpResult(delivery.sent.result, this.maxResponsePayloadBytes);
        } catch(err){
            const cause = coerceToError(err, "the answer could not be decoded");
            throw (await this.failureOutcome(name, { reason: 'protocol', cause, detail: cause.message })).error;
        }
    }
}

/**
 * Calling a Lambder app from another lambda, or from any server code that
 * holds AWS credentials and lambda:InvokeFunction on it.
 *
 * Builds the payload-format-2.0 event API Gateway would have built, invokes
 * the function with it directly, and reads the response object Lambder
 * returns. The callee is an unmodified Lambder app, so everything it offers
 * over HTTP (zod validation, the inferred contract, refusals, guards,
 * idempotency keys, Brotli answers, logList, the crash detail its error
 * handler chooses to send) applies unchanged. The callee tells an invoke
 * apart by the event's requestContext.apiId, which no gateway lets a client
 * write, and reads no forwarding header on one, so `clientIp` and `host` are
 * the only address and host it sees. The x-lambder-invoke header is a marker
 * for guards and hooks, never an authorization: the IAM grant is the
 * authorization.
 *
 * Server-only (zlib, the Lambda SDK), so it is exported from the root entry
 * and never from lambder/client. The SDK is an optional peer dependency
 * loaded on the first call; the `transport` option replaces it, and
 * LambderInvokeCaller.localTransport runs a callee's handler in-process for
 * tests.
 */
import { classifyDeliveryFailure, describeFailure, errorFromFunctionError, LambderInvokeError, parseFunctionError, } from "./LambderInvokeOutcome.js";
import { DEFAULT_SESSION_TOKEN_COOKIE_KEY } from "../shared/wire/LambderSessionCookieNames.js";
import { readApiSignature } from "../shared/wire/LambderApiSignature.js";
import { resolveApiOutcome } from "../shared/wire/LambderApiOutcome.js";
import { mergeGuardInputs, } from "../shared/wire/LambderCallOptions.js";
import { beginIdempotentAttempt, IDEMPOTENT_ATTEMPT_NOT_SENT } from "../shared/wire/LambderIdempotencyKeyScope.js";
import { createCallAbort, stopWaitingWhenAborted } from "../shared/util/LambderCallAbort.js";
import { coerceToError, errorFromCrashDetail } from "../shared/wire/LambderCrashDetail.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { resolveCompressionOption } from "../shared/wire/LambderCompressionOption.js";
import { DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS, DEFAULT_MAX_RESTORED_PAYLOAD_BYTES, compressPayloadBrotli, resolveRequestCompressionMinBytes, } from "../shared/wire/LambderRequestPayload.js";
import { DEFAULT_API_PATH } from "../shared/wire/LambderDefaultApiPath.js";
import { buildEnvelopeJson, decodeLambdaHttpResult, localLambdaContext, sessionCookies, synthesizeLambdaHttpEvent, } from "./LambderLambdaEvent.js";
/**
 * Lambda caps a synchronous invoke's request and its response at about 6MB;
 * the same guard threshold finalizeResponse applies to an answer, applied
 * here to the event before it is sent.
 */
export const LAMBDER_INVOKE_MAX_EVENT_BYTES = 5_500_000;
/**
 * @typeParam TContract - The callee's API contract (`typeof lambder.ApiContract`, imported type-only), for typed names, payloads, results and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderInvokeCaller {
    functionName;
    apiPath;
    apiVersion;
    apiSignatures;
    host;
    requestCompression;
    maxResponsePayloadBytes;
    timeoutMs;
    onLogList;
    onFailure;
    guardInputsProvider;
    sessionTokenCookieKey;
    transport;
    clientConfig;
    client;
    sdk;
    constructor(options) {
        const { functionName, client, clientConfig, apiPath, apiVersion, apiSignatures, host, requestCompression, maxResponsePayloadBytes, timeoutMs, onLogList, onFailure, sessionTokenCookieKey, transport, guardInputsProvider, } = options;
        if (!functionName?.trim())
            throw new Error("LambderInvokeCaller: functionName is required");
        this.functionName = functionName;
        this.client = client;
        this.clientConfig = clientConfig;
        this.apiPath = apiPath ?? DEFAULT_API_PATH;
        this.apiVersion = apiVersion;
        this.apiSignatures = apiSignatures;
        this.host = host ?? functionName;
        // `?? false`: like the browser caller, off unless asked for.
        this.requestCompression = resolveCompressionOption(requestCompression ?? false, DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS);
        this.maxResponsePayloadBytes = assertPositiveInteger(maxResponsePayloadBytes ?? DEFAULT_MAX_RESTORED_PAYLOAD_BYTES, "LambderInvokeCaller maxResponsePayloadBytes");
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
    static createEvent(init) {
        const host = init.host ?? "lambder-invoke";
        const tokenCookieKey = init.sessionTokenCookieKey ?? DEFAULT_SESSION_TOKEN_COOKIE_KEY;
        return synthesizeLambdaHttpEvent({
            method: "POST",
            path: init.apiPath ?? DEFAULT_API_PATH,
            host,
            headers: init.headers,
            contentType: "application/json",
            clientIp: init.clientIp,
            cookies: sessionCookies(init.session, tokenCookieKey),
            body: buildEnvelopeJson({
                apiName: init.apiName,
                version: init.apiVersion,
                signature: init.signature,
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
     * It honours the signal by ending the wait, as lambderHandlerTransport
     * does: an in-process call cannot be cancelled, so the handler runs to
     * completion regardless, but timeoutMs still frees the caller.
     */
    static localTransport(handler, context = {}) {
        return async (event, { functionName, signal }) => {
            signal?.throwIfAborted();
            try {
                return {
                    functionError: null,
                    result: await stopWaitingWhenAborted(handler(event, localLambdaContext(functionName, context)), signal),
                };
            }
            catch (err) {
                // An abort is the caller giving up, not the callee failing:
                // reporting it as a FunctionError would turn a timeout into a
                // crash outcome with an invented error payload.
                if (signal?.aborted && err === signal.reason)
                    throw err;
                const error = coerceToError(err, "the handler failed");
                return {
                    functionError: "Unhandled",
                    result: { errorType: error.name, errorMessage: error.message, trace: (error.stack ?? "").split("\n") },
                };
            }
        };
    }
    loadSdk() {
        if (!this.sdk) {
            this.sdk = import("@aws-sdk/client-lambda").catch(() => {
                throw new Error("LambderInvokeCaller requires @aws-sdk/client-lambda: npm install @aws-sdk/client-lambda");
            });
        }
        return this.sdk;
    }
    async invokeThroughSdk(eventJson, signal) {
        const { LambdaClient, InvokeCommand } = await this.loadSdk();
        // One call is one delivery attempt, as LambderApiTransport promises:
        // the SDK's default of 3 would re-invoke a callee that already ran
        // when only the response was lost.
        if (!this.client)
            this.client = new LambdaClient({ maxAttempts: 1, ...this.clientConfig });
        const output = await this.client.send(new InvokeCommand({
            FunctionName: this.functionName,
            InvocationType: "RequestResponse",
            Payload: Buffer.from(eventJson, "utf8"),
        }), signal ? { abortSignal: signal } : undefined);
        const text = output.Payload ? Buffer.from(output.Payload).toString("utf8") : "";
        let result = undefined;
        if (text) {
            try {
                result = JSON.parse(text);
            }
            catch {
                result = text;
            }
        }
        return { functionError: output.FunctionError ?? null, result };
    }
    /** Delivers one event, serialized exactly once; an event over the invoke cap, a rejected transport, or one that answered after the call was given up on, is a failure. */
    async deliverEvent(event, eventJson, options) {
        // Measured here so every path that delivers an event is capped: an
        // oversized event would otherwise come back as the SDK's
        // RequestEntityTooLargeException, which classifies as `protocol` and
        // names neither the size nor the cap.
        const bytes = Buffer.byteLength(eventJson, "utf8");
        if (bytes > LAMBDER_INVOKE_MAX_EVENT_BYTES) {
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
            // transport: honouring the signal is the transport's obligation,
            // and not every transport meets it.
            const refused = abort.abortFailure("beforeSending");
            if (refused)
                return { failed: { reason: refused.reason, cause: refused.error, detail: refused.error.message } };
            const sent = await this.transport(event, { functionName: this.functionName, eventJson, signal: abort.signal });
            // An answer that arrives after the abort is not a success: a
            // transport that ignores the signal resolves late, and trusting it
            // would hand the call site data it had already abandoned.
            const late = abort.abortFailure("afterAnswering");
            if (late)
                return { failed: { reason: late.reason, cause: late.error, detail: late.error.message } };
            return { sent };
        }
        catch (err) {
            const cause = coerceToError(err, "the invoke failed");
            // The caller's own timeout wins, since only the caller knows about
            // it; otherwise the rejection says what it was.
            return { failed: { reason: abort.timedOut() ? 'timeout' : classifyDeliveryFailure(cause), cause } };
        }
        finally {
            abort.detach();
        }
    }
    /** Builds the failure and its error, reports it once, and hands it back. */
    async failureOutcome(apiName, init) {
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
        // was already demanded where the reason was chosen; the failure is
        // assembled once here and cast to its arm.
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
        };
        error.outcome = failure;
        if (this.onFailure) {
            // A reporting hook that breaks must not turn apiOutcome() into a
            // throwing call, nor replace the failure it was told about.
            try {
                await this.onFailure(failure, { apiName, functionName: this.functionName });
            }
            catch (err) {
                console.error(`[lambder invoke] onFailure threw for ${this.functionName} ${apiName}`, err);
            }
        }
        return failure;
    }
    async surfaceLogs(apiName, logList) {
        if (!logList.length)
            return;
        if (this.onLogList) {
            try {
                await this.onLogList(apiName, logList);
            }
            catch (err) {
                console.error(`[lambder invoke] onLogList threw for ${this.functionName} ${apiName}`, err);
            }
            return;
        }
        for (const entry of logList)
            console.log(`[lambder invoke] ${this.functionName} ${apiName}`, entry);
    }
    /**
     * One call, one outcome. Never throws; api() is what throws. A key scope
     * is told how the attempt ended, as it is on LambderCaller.
     */
    async dispatch(apiName, payload, options = {}) {
        const idempotentAttempt = beginIdempotentAttempt(options.idempotencyKey);
        const outcome = await this.dispatchAttempt(apiName, payload, options, idempotentAttempt);
        // Only the first settle counts: an attempt that never left settled
        // itself as not sent.
        idempotentAttempt.settle(outcome);
        return outcome;
    }
    async dispatchAttempt(apiName, payload, options, idempotentAttempt) {
        const idempotencyKey = idempotentAttempt.key;
        // Everything before the event leaves can throw on the caller's own
        // inputs (a provider that rejects, a payload holding a cycle or a
        // BigInt). None of it may escape: apiOutcome() promises an outcome,
        // api() a LambderInvokeError, and onFailure must see every failure,
        // so it becomes an 'unknown' failure.
        let event;
        let eventJson;
        try {
            // The callee's signature for this endpoint, when this caller was
            // built with the callee's map. A name the map lacks fails here,
            // as a provider that threw would: the map predates the endpoint.
            const signature = this.apiSignatures ? await readApiSignature(this.apiSignatures, apiName) : undefined;
            // Provider values underneath, per-call values on top.
            const provided = this.guardInputsProvider
                ? await this.guardInputsProvider(apiName)
                : undefined;
            const guardInputs = mergeGuardInputs(provided, options.guardInputs);
            // Serialized once: the compression decision needs the JSON, and a
            // plain payload splices that same JSON into the envelope.
            // Compressed when enabled and the JSON reaches the threshold;
            // `compressRequest` overrides both ways.
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
                contentType: "application/json",
                clientIp: options.clientIp,
                cookies: sessionCookies(options.session, this.sessionTokenCookieKey),
                body: buildEnvelopeJson({
                    apiName,
                    version: this.apiVersion,
                    signature,
                    csrf: options.session?.csrf,
                    siteHost: this.host,
                    payloadJson: compressed ? undefined : payloadJson,
                    compressed,
                    guardInputs,
                    idempotencyKey,
                }),
            }, { invoke: true });
            // Serialized once here; the size guard and the SDK transport both use it.
            eventJson = JSON.stringify(event);
        }
        catch (err) {
            // Nothing was sent, so the key was not used: the same as the
            // browser caller's failure before sending.
            idempotentAttempt.settle(IDEMPOTENT_ATTEMPT_NOT_SENT);
            return await this.failureOutcome(apiName, { reason: 'unknown', cause: coerceToError(err, "the call could not be built") });
        }
        const delivery = await this.deliverEvent(event, eventJson, options);
        if ("failed" in delivery)
            return await this.failureOutcome(apiName, delivery.failed);
        if (delivery.sent.functionError) {
            return await this.failureOutcome(apiName, { reason: 'crash', functionError: parseFunctionError(delivery.sent.result) });
        }
        let http;
        try {
            http = await decodeLambdaHttpResult(delivery.sent.result, this.maxResponsePayloadBytes);
        }
        catch (err) {
            const cause = coerceToError(err, "the answer could not be decoded");
            return await this.failureOutcome(apiName, { reason: 'protocol', cause, detail: cause.message });
        }
        const outcome = await resolveApiOutcome({
            status: http.statusCode,
            header: (name) => http.headers[name.toLowerCase()] ?? null,
            json: async () => http.json(),
            text: async () => http.text(),
        });
        // Every answer's logs arrive on outcome.logList, whether they came
        // from an envelope, a 500 body or a validation body.
        const logList = outcome.logList ?? [];
        await this.surfaceLogs(apiName, logList);
        // The answer's Set-Cookie values, so a session the callee rotated or
        // cleared is visible to whoever is carrying it.
        const cookies = http.cookies;
        // The declared output, by the callee's own typing: res.api(null)
        // compiles only for an output that allows null or beside a reason (an
        // errorMessage is a failure below; a message-only null is the
        // callee's contract to keep).
        if (outcome.ok)
            return { ok: true, payload: (outcome.payload ?? null), response: outcome.response, logList, cookies };
        const shared = { status: outcome.status, retryAfterSeconds: outcome.retryAfterSeconds, logList, cookies };
        // Each failure reason carries different evidence, and the outcome
        // union says which: a rejected input has its issues and no envelope,
        // an envelope refusal has the envelope and no Error.
        if (outcome.reason === 'validation') {
            return await this.failureOutcome(apiName, { ...shared, reason: 'validation', zodError: outcome.zodError });
        }
        if (outcome.reason === 'server') {
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
            ...(outcome.reason === 'errorMessage' ? { reason: outcome.reason, errorMessage: outcome.errorMessage } : { reason: outcome.reason }),
            response: outcome.response,
            crash: outcome.response.crash,
        });
    }
    /**
     * Full-fidelity call: resolves to a discriminated LambderInvokeOutcome
     * instead of throwing, for sites that degrade gracefully. The output type
     * comes from the contract rather than a type parameter, so a call site
     * cannot replace it by annotating what it assigns to.
     */
    async apiOutcome(apiName, ...rest) {
        // The tuple is a conditional type on an unresolved TApiName, so its
        // elements read as unknown here; the contract already checked them at
        // the call site.
        const [payload, options] = rest;
        return await this.dispatch(apiName, payload, options);
    }
    /**
     * The declared output, or a thrown LambderInvokeError carrying the
     * outcome. A failed dependency is a failed request: the throw reaches the
     * app's global error handler with the callee's error as its cause. The
     * resolver lets a handler answer null only when the output allows it or
     * beside a reason (LambderApiAnswer), so null arrives only for a
     * nullable output.
     */
    async api(apiName, ...rest) {
        const [payload, options] = rest;
        const outcome = await this.dispatch(apiName, payload, options);
        if (!outcome.ok)
            throw outcome.error;
        return outcome.payload;
    }
    /**
     * Any route of the callee, untyped: the synthesized request and the
     * decoded answer, whatever its status. Throws a LambderInvokeError only
     * when no HTTP answer came back (a rejected invoke, a FunctionError, a
     * non-HTTP answer); those go through onFailure like an API call's.
     */
    async request(init) {
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
        if ("failed" in delivery)
            throw (await this.failureOutcome(name, delivery.failed)).error;
        if (delivery.sent.functionError) {
            throw (await this.failureOutcome(name, { reason: 'crash', functionError: parseFunctionError(delivery.sent.result) })).error;
        }
        try {
            return await decodeLambdaHttpResult(delivery.sent.result, this.maxResponsePayloadBytes);
        }
        catch (err) {
            const cause = coerceToError(err, "the answer could not be decoded");
            throw (await this.failureOutcome(name, { reason: 'protocol', cause, detail: cause.message })).error;
        }
    }
}

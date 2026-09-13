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
import { resolveApiOutcome } from "../shared/LambderApiOutcome.js";
import { mergeGuardInputs, } from "../shared/LambderCallOptions.js";
import { errorFromCrashDetail } from "../shared/LambderCrashDetail.js";
import { resolveCompressionOption } from "../shared/LambderCompressionOption.js";
import { compressText, restoreBytes } from "../shared/LambderCompressionCodec.js";
import { COMPRESSED_PAYLOAD_BR_FIELD, DEFAULT_MAX_RESTORED_PAYLOAD_BYTES, compressPayloadWith, } from "../shared/LambderRequestPayload.js";
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
export const DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS = { minBytes: 4096, quality: 5 };
const DEFAULT_SESSION_TOKEN_COOKIE_KEY = "LMDRSESSIONTKID";
/**
 * What api() throws. Its message names the function, the API and the reason,
 * so an error reporter that fingerprints on the message groups one broken
 * API into one row; its cause is the callee's own error rebuilt from the
 * crash detail (or Lambda's FunctionError, or the SDK's rejection), so a
 * reporter that walks causes stores the callee's stack.
 */
export class LambderInvokeError extends Error {
    /** Brand for detection across duplicate lambder installs, like LambderApiError. */
    isLambderInvokeError = true;
    reason;
    apiName;
    functionName;
    status;
    errorMessage;
    crash;
    functionError;
    logList;
    zodError;
    retryAfterSeconds;
    bytes;
    /** The full failure outcome; it carries this error and this error carries it. */
    outcome;
    constructor(init) {
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
export const isLambderInvokeError = (err) => err instanceof Error && err.isLambderInvokeError === true;
const randomRequestId = () => {
    const webCrypto = globalThis.crypto;
    if (webCrypto?.randomUUID)
        return webCrypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
};
/** The payload-format-2.0 event API Gateway would deliver for this request. */
const synthesizeHttpEvent = (request) => {
    const headers = {
        host: request.host,
        "accept-encoding": "br, gzip",
        [LAMBDER_INVOKE_HEADER]: LAMBDER_INVOKE_PROTOCOL,
    };
    const invokedBy = typeof process !== "undefined" ? process.env?.AWS_LAMBDA_FUNCTION_NAME : undefined;
    if (invokedBy)
        headers[LAMBDER_INVOKED_BY_HEADER] = invokedBy;
    if (request.clientIp)
        headers["x-forwarded-for"] = request.clientIp;
    for (const [key, value] of Object.entries(request.headers ?? {}))
        headers[key.toLowerCase()] = value;
    const isBinary = Buffer.isBuffer(request.body);
    if (request.body !== undefined && !headers["content-type"]) {
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
            ? { body: isBinary ? request.body.toString("base64") : request.body }
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
const buildEnvelopeJson = (fields) => {
    const withoutPayload = JSON.stringify({
        apiName: fields.apiName,
        version: fields.version,
        token: fields.csrf ?? "",
        siteHost: fields.siteHost,
        ...(fields.compressed ?? {}),
        ...(fields.guardInputs !== undefined ? { guardInputs: fields.guardInputs } : {}),
        ...(fields.idempotencyKey !== undefined ? { idempotencyKey: fields.idempotencyKey } : {}),
    });
    if (fields.payloadJson === undefined)
        return withoutPayload;
    return `${withoutPayload.slice(0, -1)},"payload":${fields.payloadJson}}`;
};
const sessionCookies = (session, tokenCookieKey) => session ? [`${tokenCookieKey}=${session.token}`] : undefined;
/**
 * Brotli one payload's JSON for sending, or null when the plain JSON should
 * go instead: the browser's compressPayloadGzip with Brotli, because both
 * ends are Node. The threshold and the only-when-smaller rule are
 * compressPayloadWith's, shared with the gzip side.
 */
export const compressPayloadBrotli = (json, minBytes, quality) => compressPayloadWith(json, minBytes, COMPRESSED_PAYLOAD_BR_FIELD, (bytes) => compressText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), "br", quality));
/** A timeout controller chained to an external signal, so either source aborts the invoke. */
const abortAfter = (timeoutMs, external) => {
    let timedOut = false;
    let signal = external;
    let timeoutId;
    // The forwarding listener is detached in clear(), not left to `once`: an
    // external signal usually outlives the call (a request-scoped one passed
    // to several invokes, an app-lifetime one), so a listener per call would
    // accumulate on it for as long as it lives.
    let detach;
    if (timeoutMs !== undefined) {
        const controller = new AbortController();
        if (external) {
            if (external.aborted) {
                controller.abort(external.reason);
            }
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
        clear: () => { if (timeoutId !== undefined)
            clearTimeout(timeoutId); detach?.(); },
    };
};
const errorFromFunctionError = (functionError) => {
    const error = new Error(functionError.errorMessage ?? "the function failed");
    error.name = functionError.errorType ?? "FunctionError";
    if (functionError.trace?.length)
        error.stack = functionError.trace.join("\n");
    return error;
};
const parseFunctionError = (result) => {
    if (result && typeof result === "object") {
        const { errorType, errorMessage, trace } = result;
        return {
            ...(typeof errorType === "string" ? { errorType } : {}),
            ...(typeof errorMessage === "string" ? { errorMessage } : {}),
            ...(Array.isArray(trace) ? { trace: trace.map(String) } : {}),
        };
    }
    return { errorMessage: typeof result === "string" ? result : undefined };
};
/** The one-line detail a failure's message ends with. */
const describeFailure = (init) => {
    if (init.crash)
        return init.crash.message;
    if (init.functionError)
        return `${init.functionError.errorType ?? "FunctionError"}: ${init.functionError.errorMessage ?? "the function failed"}`;
    if (init.errorMessage !== undefined) {
        const content = init.errorMessage?.content;
        if (typeof content === "string")
            return content;
        if (typeof init.errorMessage === "string")
            return init.errorMessage;
        try {
            return JSON.stringify(init.errorMessage);
        }
        catch {
            return String(init.errorMessage);
        }
    }
    if (init.reason === 'validation')
        return "the callee rejected the input";
    if (init.reason === 'versionExpired')
        return "the callee answered versionExpired";
    if (init.reason === 'sessionExpired')
        return "the callee answered sessionExpired";
    if (init.reason === 'notAuthorized')
        return "the callee answered notAuthorized";
    if (init.cause instanceof Error)
        return init.cause.message;
    return init.status !== undefined ? `HTTP ${init.status}` : "no answer";
};
/**
 * @typeParam TContract - The callee's API contract (`typeof lambder.ApiContract`, imported type-only), for typed names, payloads, results and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderInvokeCaller {
    functionName;
    apiPath;
    apiVersion;
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
        const { functionName, client, clientConfig, apiPath, apiVersion, host, requestCompression, maxResponsePayloadBytes, timeoutMs, onLogList, onFailure, sessionTokenCookieKey, transport, guardInputsProvider, } = options;
        if (!functionName?.trim())
            throw new Error("LambderInvokeCaller: functionName is required");
        this.functionName = functionName;
        this.client = client;
        this.clientConfig = clientConfig;
        this.apiPath = apiPath ?? "/api";
        this.apiVersion = apiVersion;
        this.host = host ?? functionName;
        // `?? false`: like the browser caller, off unless asked for.
        this.requestCompression = resolveCompressionOption(requestCompression ?? false, DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS);
        this.maxResponsePayloadBytes = maxResponsePayloadBytes ?? DEFAULT_MAX_RESTORED_PAYLOAD_BYTES;
        if (!Number.isSafeInteger(this.maxResponsePayloadBytes) || this.maxResponsePayloadBytes <= 0) {
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
    static createEvent(init) {
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
    static localTransport(handler, context = {}) {
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
                done: () => { },
                fail: () => { },
                succeed: () => { },
                ...context,
            };
            try {
                return { functionError: null, result: await handler(event, lambdaContext) };
            }
            catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
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
        if (!this.client)
            this.client = new LambdaClient(this.clientConfig ?? {});
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
    /** Delivers one event, serialized exactly once; a rejected transport is a network or timeout failure. */
    async deliver(event, eventJson, options) {
        const abort = abortAfter(options.timeoutMs ?? this.timeoutMs, options.signal);
        try {
            const sent = await this.transport(event, { functionName: this.functionName, eventJson, signal: abort.signal });
            return { sent };
        }
        catch (err) {
            const cause = err instanceof Error ? err : new Error(String(err));
            return { failed: { reason: abort.timedOut() ? 'timeout' : 'network', cause } };
        }
        finally {
            abort.clear();
        }
    }
    /** The function's answer as an HTTP result; throws when it is not one, or its compressed body cannot be restored. */
    async decodeHttpResult(result) {
        if (!result || typeof result !== "object" || typeof result.statusCode !== "number") {
            throw new Error("the function did not answer with an HTTP response object; is it a Lambder app?");
        }
        const raw = result;
        const headers = {};
        for (const [key, value] of Object.entries(raw.headers ?? {}))
            headers[key.toLowerCase()] = value;
        for (const [key, values] of Object.entries(raw.multiValueHeaders ?? {}))
            headers[key.toLowerCase()] = values.join(", ");
        let body = raw.body ? Buffer.from(raw.body, raw.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0);
        const encoding = headers["content-encoding"]?.trim().toLowerCase();
        if (encoding === "br" || encoding === "gzip") {
            // restoreBytes, not restoreText: a route may answer compressed
            // binary (a wasm module, anything it forced compression on), and
            // decoding that as UTF-8 first would replace every byte that is
            // not valid UTF-8 and hand back a silently different body.
            body = await restoreBytes(body, encoding, { maxBytes: this.maxResponsePayloadBytes });
        }
        else if (encoding) {
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
    async fail(apiName, init) {
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
        const failure = {
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
        if (init.response !== undefined)
            failure.response = init.response;
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
    /** One call, one outcome. Never throws; api() is what throws. */
    async dispatch(apiName, payload, options = {}) {
        // Everything that happens before the event leaves: the guardInputs
        // provider, the payload's JSON and its compression. All of it can
        // throw on the caller's own inputs (a provider that rejects, a
        // payload holding a cycle or a BigInt), and none of it may escape:
        // apiOutcome() promises an outcome, api() promises a
        // LambderInvokeError, and onFailure is the one place failures are
        // reported. So a throw here is an 'unknown' failure like any other.
        let event;
        let eventJson;
        let bytes;
        try {
            // Provider values underneath, per-call values on top.
            const provided = this.guardInputsProvider
                ? await this.guardInputsProvider(apiName)
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
        }
        catch (err) {
            return await this.fail(apiName, { reason: 'unknown', cause: err instanceof Error ? err : new Error(String(err)) });
        }
        if (bytes > LAMBDER_INVOKE_MAX_EVENT_BYTES) {
            return await this.fail(apiName, {
                reason: 'payloadTooLarge', bytes,
                detail: `the event is ${bytes} bytes, over the ${LAMBDER_INVOKE_MAX_EVENT_BYTES} byte invoke cap`,
            });
        }
        const delivery = await this.deliver(event, eventJson, options);
        if ("failed" in delivery)
            return await this.fail(apiName, delivery.failed);
        if (delivery.sent.functionError) {
            return await this.fail(apiName, { reason: 'crash', functionError: parseFunctionError(delivery.sent.result) });
        }
        let http;
        try {
            http = await this.decodeHttpResult(delivery.sent.result);
        }
        catch (err) {
            const cause = err instanceof Error ? err : new Error(String(err));
            return await this.fail(apiName, { reason: 'protocol', cause, detail: cause.message });
        }
        const outcome = await resolveApiOutcome({
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
        if (outcome.ok)
            return { ok: true, payload: (outcome.payload ?? null), response: outcome.response, logList };
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
    async apiOutcome(apiName, payload, ...rest) {
        return await this.dispatch(apiName, payload, rest[0]);
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
    async api(apiName, payload, ...rest) {
        const outcome = await this.dispatch(apiName, payload, rest[0]);
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
        if ("failed" in delivery)
            throw (await this.fail(name, delivery.failed)).error;
        if (delivery.sent.functionError) {
            throw (await this.fail(name, { reason: 'crash', functionError: parseFunctionError(delivery.sent.result) })).error;
        }
        try {
            return await this.decodeHttpResult(delivery.sent.result);
        }
        catch (err) {
            const cause = err instanceof Error ? err : new Error(String(err));
            throw (await this.fail(name, { reason: 'protocol', cause, detail: cause.message })).error;
        }
    }
}

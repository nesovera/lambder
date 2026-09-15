import type { LambderAppRefusalMessage } from '../shared/wire/LambderApiRefusal.js';
import Cookies from 'js-cookie';
import {
    compressPayloadGzip,
    isRequestCompressionAvailable,
    resolveRequestCompressionMinBytes,
    DEFAULT_REQUEST_COMPRESSION_SETTINGS,
    type LambderRequestCompressionOption,
    type LambderRequestCompressionSettings,
} from '../shared/wire/LambderRequestPayload.js';
import { resolveCompressionOption } from '../shared/wire/LambderCompressionOption.js';
import type { LambderApiContractShape } from '../shared/wire/LambderApiContract.js';
import { resolveApiOutcome, type LambderApiHttpAnswer, type LambderApiOutcome, type LambderValidationError } from '../shared/wire/LambderApiOutcome.js';
import {
    mergeGuardInputs,
    type LambderCallArgs,
    type LambderContractOutputOf,
    type LambderGuardInputsProviderOption,
    type LambderSharedCallOptions,
} from '../shared/wire/LambderCallOptions.js';
import { createCallAbort, type LambderCallAbortStage } from '../shared/util/LambderCallAbort.js';
import { coerceToError } from '../shared/wire/LambderCrashDetail.js';
import { isLambderTransportFailure, type LambderApiTransport } from '../shared/transport/LambderApiTransport.js';
import { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from '../shared/wire/LambderSessionCookieNames.js';
import { readApiSignature, type LambderApiSignatureMap } from '../shared/wire/LambderApiSignature.js';
import { LambderReloadLoopBreaker, RELOAD_LOOP_WINDOW_MS } from './LambderReloadLoopBreaker.js';
import { lambderFetchTransport } from './lambderFetchTransport.js';

// The outcome vocabulary and the contract-driven option typing are shared
// with LambderInvokeCaller (src/shared/); re-exported here so the entries
// keep their names.
export type { LambderApiOutcome, LambderApiFailureReason, LambderValidationError } from '../shared/wire/LambderApiOutcome.js';
export type { LambderProvidedGuardInputs, LambderGuardInputsProvider } from '../shared/wire/LambderCallOptions.js';

/** A handler told that something happened, with nothing to hand it. */
type NotifyHandler = ()=>void|Promise<void>;
/** One call in flight: pushed when it starts, removed when it settles, so the list is the in-flight list rather than a log of every call ever made. */
type FetchTracker = { apiName: string };
type EventHandlerFetchParams = {
    apiName: string,
    payload?: any,
    headers?: Record<string, string>
};

type FetchStartEventHandler = (params: {
    fetchParams: EventHandlerFetchParams,
    activeFetchList: FetchTracker[],
})=>void|Promise<void>;

type FetchEndEventHandler = (params: {
    fetchParams: EventHandlerFetchParams,
    fetchResult: any,
    activeFetchList: FetchTracker[],
})=>void|Promise<void>;

type ErrorHandler = (err: Error) => void|Promise<void>;
type ValidationErrorHandler = (zodError: LambderValidationError) => (void|false)|Promise<(void|false)>;
type MessageHandler = (message: LambderAppRefusalMessage | string) => void|Promise<void>;

/** The logListHandler option: an answer's logList, success or failure, when it has entries. The invoke caller's onLogList, for a browser. */
export type LambderLogListHandler = (apiName: string, logList: unknown[]) => void|Promise<void>;

/** One logical operation's rotating idempotency key: see LambderCaller.createIdempotencyKeyScope(). */
export type LambderIdempotencyKeyScope = {
    /** The key for the operation currently in progress. */
    readonly current: string;
    /** Call after a confirmed success: the next operation is a new intent. Returns the new key. */
    rotate(): string;
};

/**
 * Per-call options: the request extras both callers share (see
 * LambderSharedCallOptions) plus an override for every constructor handler.
 */
export type LambderCallOptions = LambderSharedCallOptions & {
    versionExpiredHandler?: NotifyHandler;
    sessionExpiredHandler?: NotifyHandler;
    messageHandler?: MessageHandler;
    errorMessageHandler?: MessageHandler;
    apiInputValidationErrorHandler?: ValidationErrorHandler;
    notAuthorizedHandler?: NotifyHandler;
    errorHandler?: ErrorHandler;
    logListHandler?: LambderLogListHandler;
    fetchStartedHandler?: FetchStartEventHandler;
    fetchEndedHandler?: FetchEndEventHandler;
};

type LambderCallerBaseOptions = {
    apiPath: string,
    /** Sent with every call as `version`, informational: the server stamps its own on every answer. */
    apiVersion?: string,
    /**
     * The server's signature map, generated from its instance
     * (Lambder.apiSignatures()) and shipped with this build. Sent per call as
     * `signature`, so the server answers versionExpired to a call built
     * against another shape of the endpoint and runs every other call. Leave
     * it out and no call is gated.
     */
    apiSignatures?: LambderApiSignatureMap,
    isCorsEnabled: boolean,
    /** Default per-request timeout in ms (none unless set; API Gateway caps around 29s, so ~30000 is a sensible value). Overridable per call. */
    timeoutMs?: number,
    versionExpiredHandler?: NotifyHandler,
    sessionExpiredHandler?: NotifyHandler,
    messageHandler?: MessageHandler,
    errorMessageHandler?: MessageHandler,
    notAuthorizedHandler?: NotifyHandler,
    errorHandler?: ErrorHandler,
    /** Receives each answer's logList, with the API name. Default: console.log with a `[lambder]` prefix, one line per entry. */
    logListHandler?: LambderLogListHandler,
    fetchStartedHandler?: FetchStartEventHandler,
    fetchEndedHandler?: FetchEndEventHandler,
    apiInputValidationErrorHandler?: ValidationErrorHandler,
    /** Must mirror the server's session cookie Domain, otherwise expired cookies cannot be cleared. */
    sessionCookieDomain?: string | ((hostname: string) => string | undefined | null),
    /**
     * Gzip the payload of calls whose JSON reaches the threshold, sending it
     * as `payloadGz` beside its byte length instead of `payload` whenever
     * that is smaller (a base64 image, say, is not, and goes plain). Off by
     * default; `true` is `{ minBytes: 4096 }`. Nothing at the call sites
     * changes, and the server understands both shapes either way, so it can
     * be turned on or off freely. Chiefly a way to fit a large payload under
     * Lambda's ~6MB invoke cap, which applies to the compressed bytes.
     */
    requestCompression?: LambderRequestCompressionOption,
    /**
     * How a call reaches the server. Default: fetch to apiPath
     * (lambderFetchTransport, with CORS per isCorsEnabled). A mock runtime,
     * an in-process Lambder handler, or a cookie-jar decorator over either
     * are the other transports that ship; see LambderApiTransport.
     */
    transport?: LambderApiTransport,
};

/** Constructor options: the base options plus guardInputsProvider, mandatory once TProvided names guards. */
export type LambderCallerOptions<TContract, TProvided extends string = never> =
    LambderCallerBaseOptions & LambderGuardInputsProviderOption<TContract, TProvided>;

/**
 * @typeParam TContract - The API contract, for typed names, payloads and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderCaller<TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never> {
    private isCorsEnabled: boolean;
    private apiPath: string;
    private apiVersion?: string;
    private apiSignatures?: LambderApiSignatureMap;
    private timeoutMs?: number;
    /** What keeps a stale bundle from reloading itself forever; see the class. */
    private readonly reloadLoopBreaker = new LambderReloadLoopBreaker();

    /** The calls currently in flight, in the order they started. */
    fetchTrackerList: FetchTracker[] = [];
    /** Whether any call is in flight. Derived, so it cannot drift from the list the way a separate flag did. */
    get isLoading(): boolean { return this.fetchTrackerList.length > 0; }

    private versionExpiredHandler?: NotifyHandler;
    private sessionExpiredHandler?: NotifyHandler;

    private messageHandler?: MessageHandler;
    private errorMessageHandler?: MessageHandler;
    private notAuthorizedHandler?: NotifyHandler;
    private errorHandler?: ErrorHandler;
    private apiInputValidationErrorHandler?: ValidationErrorHandler;
    private logListHandler?: LambderLogListHandler;

    private fetchStartedHandler?: FetchStartEventHandler;
    private fetchEndedHandler?: FetchEndEventHandler;
    private guardInputsProvider?: (apiName: string) => unknown;

    private sessionTokenCookieKey = DEFAULT_SESSION_TOKEN_COOKIE_KEY;
    private sessionCsrfCookieKey = DEFAULT_SESSION_CSRF_COOKIE_KEY;
    private sessionCookieDomain?: string | ((hostname: string) => string | undefined | null);
    private requestCompression: LambderRequestCompressionSettings | null;
    private transport: LambderApiTransport;

    constructor(options: LambderCallerOptions<TContract, TProvidedGuards>){
        // The conditional provider option is resolved per instantiation;
        // inside the class it is read through the plain shape.
        const {
            apiPath, apiVersion, apiSignatures,
            isCorsEnabled,
            timeoutMs,
            versionExpiredHandler, sessionExpiredHandler,
            messageHandler, errorMessageHandler,
            notAuthorizedHandler, errorHandler, logListHandler,
            fetchStartedHandler, fetchEndedHandler,
            apiInputValidationErrorHandler,
            sessionCookieDomain,
            requestCompression,
            guardInputsProvider,
            transport,
        } = options as LambderCallerBaseOptions & { guardInputsProvider?: (apiName: string) => unknown };
        this.apiPath = apiPath;
        this.apiVersion = apiVersion;
        this.apiSignatures = apiSignatures;
        this.isCorsEnabled = isCorsEnabled;
        this.timeoutMs = timeoutMs;
        this.sessionCookieDomain = sessionCookieDomain;
        // `?? false`: unlike the at-rest stores, this one is off unless asked for.
        this.requestCompression = resolveCompressionOption(requestCompression ?? false, DEFAULT_REQUEST_COMPRESSION_SETTINGS);
        this.transport = transport ?? lambderFetchTransport({ cors: this.isCorsEnabled });

        this.versionExpiredHandler = versionExpiredHandler;
        this.sessionExpiredHandler = sessionExpiredHandler;

        this.messageHandler = messageHandler;
        this.errorMessageHandler = errorMessageHandler;
        this.notAuthorizedHandler = notAuthorizedHandler;
        this.errorHandler = errorHandler;
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;
        this.logListHandler = logListHandler;

        this.fetchStartedHandler = fetchStartedHandler;
        this.fetchEndedHandler = fetchEndedHandler;
        this.guardInputsProvider = guardInputsProvider;
    };

    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string){
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
    }

    /** Replaces how calls reach the server: a mock runtime, an in-process handler, a decorated transport. */
    setTransport(transport: LambderApiTransport): this {
        this.transport = transport;
        return this;
    }

    /**
     * A self-rotating idempotency key for a component or form that performs
     * the same logical operation repeatedly. `current` is the key for the
     * operation in progress: send it with every attempt (first try, retry
     * after a failure, double-tap) so the server collapses them. Call
     * `rotate()` after a confirmed success so the next operation is a new
     * intent with its own key.
     *
     * ```typescript
     * const submitKey = LambderCaller.createIdempotencyKeyScope();
     * await caller.api("order.create", payload, { idempotencyKey: submitKey.current });
     * submitKey.rotate();
     * ```
     */
    static createIdempotencyKeyScope(): LambderIdempotencyKeyScope {
        let key = LambderCaller.createIdempotencyKey();
        return {
            get current(){ return key; },
            rotate(){ key = LambderCaller.createIdempotencyKey(); return key; },
        };
    }

    /**
     * Generate an idempotency key for one logical operation. Create it when
     * the operation begins (a form opens, a draft starts), send the same key
     * on every attempt of that operation, and generate a new one after a
     * confirmed success. Uses crypto.randomUUID when available and falls back
     * to a v4 UUID from getRandomValues, because randomUUID only exists in
     * secure contexts (plain-http LAN device testing lacks it).
     *
     * A runtime with neither throws rather than reaching for Math.random: the
     * key must be UNGUESSABLE, since it is what scopes the replay record for a
     * logged-out client, and a guessable one hands that client's stored
     * response to whoever guesses it.
     */
    static createIdempotencyKey(): string {
        const cryptoObj = globalThis.crypto;
        if(cryptoObj?.randomUUID) return cryptoObj.randomUUID();
        if(!cryptoObj?.getRandomValues) throw new Error("LambderCaller.createIdempotencyKey needs crypto.getRandomValues: an idempotency key must be unguessable, and this runtime offers no random source that is.");
        const bytes = new Uint8Array(16);
        cryptoObj.getRandomValues(bytes);
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    private clearSessionCookies(){
        const domainOption = this.sessionCookieDomain;
        const hostname = globalThis.location?.hostname ?? "";
        const resolvedDomain = typeof domainOption === "function" ? domainOption(hostname) : domainOption;
        for(const key of [this.sessionTokenCookieKey, this.sessionCsrfCookieKey]){
            // Host-only and domain-scoped cookies are distinct entries; clear both.
            // Only the CSRF cookie is reachable from here: the token cookie is
            // HttpOnly, so its removal is the server's (a Set-Cookie on the
            // session-expired or logout response).
            Cookies.remove(key);
            if(resolvedDomain) Cookies.remove(key, { domain: resolvedDomain, path: "/" });
        }
    }

    /** One call, one outcome. Never throws; every failure path resolves to { ok: false }. */
    private async dispatch<TOutput>(
        apiName: string,
        payload?: any,
        options?: LambderCallOptions,
    ): Promise<LambderApiOutcome<TOutput>>{
        // Per-call overrides win over the constructor handlers.
        const versionExpiredHandler = options?.versionExpiredHandler ?? this.versionExpiredHandler;
        const sessionExpiredHandler = options?.sessionExpiredHandler ?? this.sessionExpiredHandler;
        const messageHandler = options?.messageHandler ?? this.messageHandler;
        const errorMessageHandler = options?.errorMessageHandler ?? this.errorMessageHandler;
        const notAuthorizedHandler = options?.notAuthorizedHandler ?? this.notAuthorizedHandler;
        const errorHandler = options?.errorHandler ?? this.errorHandler;
        const apiInputValidationErrorHandler = options?.apiInputValidationErrorHandler ?? this.apiInputValidationErrorHandler;
        const logListHandler = options?.logListHandler ?? this.logListHandler;
        const fetchStartedHandler = options?.fetchStartedHandler ?? this.fetchStartedHandler;
        const fetchEndedHandler = options?.fetchEndedHandler ?? this.fetchEndedHandler;

        const headers = options?.headers;
        const fetchTracker: FetchTracker = { apiName };

        // Dropped the moment the call settles, and idempotently, since the
        // finally block below runs for the paths fetchEnded never reaches.
        // Left in, the list grew by one per call forever, and every handler
        // call scanned all of it: a long-lived page paid more per call the
        // longer it had been open.
        const dropFetchTracker = () => {
            const at = this.fetchTrackerList.indexOf(fetchTracker);
            if(at !== -1) this.fetchTrackerList.splice(at, 1);
        };

        let fetchEndCalled = false;
        const fetchEnded = async (fetchResult: any) => {
            dropFetchTracker();
            if(fetchEndCalled || !fetchEndedHandler) return;
            fetchEndCalled = true;
            await fetchEndedHandler({
                fetchParams: { apiName, payload, headers },
                fetchResult,
                activeFetchList: [...this.fetchTrackerList],
            });
        };

        let errorHandlerCalled = false;
        const reportError = async (err: Error) => {
            if(errorHandlerCalled || !errorHandler) return;
            errorHandlerCalled = true;
            await errorHandler(err);
        };

        // Timeout and abort wiring, shared with LambderInvokeCaller so the two
        // cannot drift on what a late or abandoned call means.
        const abort = createCallAbort({ timeoutMs: options?.timeoutMs ?? this.timeoutMs, signal: options?.signal });
        const signal = abort.signal;

        /** Reports a call that was given up on, or null while it still stands. */
        const abandonedOutcome = async (stage: LambderCallAbortStage) => {
            const failure = abort.abortFailure(stage);
            if(!failure) return null;
            await fetchEnded(failure.error);
            await reportError(failure.error);
            const outcome: LambderApiOutcome<TOutput> = { ok: false, reason: failure.reason, error: failure.error };
            return outcome;
        };

        try {
            this.fetchTrackerList.push(fetchTracker);
            if(fetchStartedHandler) await fetchStartedHandler({
                fetchParams: { apiName, payload, headers, },
                activeFetchList: [...this.fetchTrackerList],
            });
            const version = this.apiVersion;
            // The server's signature for this endpoint, when this build
            // carries the map. A name the map lacks fails the call here, as a
            // provider that threw would: the map predates the endpoint.
            const signature = this.apiSignatures ? await readApiSignature(this.apiSignatures, apiName) : undefined;
            // js-cookie reads nothing without a document, and there is no
            // location outside a page: both are "" then, and a transport that
            // carries a cookie jar fills the token in from it.
            const token = Cookies.get(this.sessionCsrfCookieKey) || "";
            const siteHost = globalThis.location?.hostname ?? "";
            // Provider values underneath, per-call values on top.
            const providedGuardInputs = this.guardInputsProvider
                ? await this.guardInputsProvider(apiName) as Record<string, unknown> | undefined
                : undefined;
            const guardInputs = mergeGuardInputs(providedGuardInputs, options?.guardInputs);

            // Compressed when enabled and the payload's JSON reaches the
            // threshold; `compressRequest` overrides both ways, and a runtime
            // without CompressionStream always sends the payload plainly.
            // Nothing here runs (the extra stringify included) unless
            // compression is actually a possibility for this call.
            const compressionMinBytes = resolveRequestCompressionMinBytes(options?.compressRequest, this.requestCompression);
            const compressedPayload = compressionMinBytes !== null && payload !== undefined && isRequestCompressionAvailable()
                ? await compressPayloadGzip(JSON.stringify(payload), compressionMinBytes)
                : null;

            // A call the site has already given up on does not reach the
            // transport at all: honouring request.signal is the transport's
            // obligation, and not every transport does.
            const refused = await abandonedOutcome("beforeSending");
            if(refused) return refused;

            let answer: LambderApiHttpAnswer;
            try {
                answer = await this.transport({
                    apiPath: this.apiPath,
                    apiName, version, token, siteHost,
                    ...(signature !== undefined ? { signature } : {}),
                    csrfCookieKey: this.sessionCsrfCookieKey,
                    ...(compressedPayload ? { compressed: compressedPayload } : { payload }),
                    ...(guardInputs !== undefined ? { guardInputs } : {}),
                    ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
                    ...(headers ? { headers } : {}),
                    ...(signal ? { signal } : {}),
                });
            }catch(err){
                const wrappedError = coerceToError(err, "Request failed");
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
                // The caller's own abort wins, since only it knows about that.
                // Otherwise a transport that named its reason is believed:
                // "protocol" means something came back and was not an answer,
                // which is what this caller already calls `server`.
                const reason = abort.timedOut() ? 'timeout'
                    : isLambderTransportFailure(err) && err.reason === 'protocol' ? 'server'
                    : 'network';
                return { ok: false, reason, error: wrappedError };
            }

            // An answer that arrives after the call was given up on is not a
            // success. A transport that ignores request.signal resolves late,
            // and believing it would report ok on a 20ms timeoutMs 300ms in,
            // handing the call site data it had already abandoned.
            const late = await abandonedOutcome("afterAnswering");
            if(late) return late;

            // The reading of the answer is shared with LambderInvokeCaller;
            // only what to do about each outcome is this caller's.
            const outcome = await resolveApiOutcome<TOutput>(answer);

            // Every answer's logs, surfaced once and before any branch that
            // returns: the 500 whose global error handler attached a crash and
            // a logList is the answer whose log trail is worth the most, and
            // surfacing them under the envelope reads meant it was the one
            // answer that never reached logListHandler at all.
            const logList = outcome.logList;
            if(logList?.length){
                if(logListHandler) await logListHandler(apiName, logList);
                else for(const record of logList) console.log("[lambder]", record);
            }

            if(!outcome.ok && outcome.reason === 'server'){
                await fetchEnded(outcome.error);
                await reportError(outcome.error);
                return outcome;
            }
            if(!outcome.ok && outcome.reason === 'validation'){
                await fetchEnded(null);
                if(apiInputValidationErrorHandler){
                    await apiInputValidationErrorHandler(outcome.zodError);
                }else{
                    await reportError(new Error("API Input Validation Error", { cause: outcome.zodError }));
                }
                return outcome;
            }

            // Whatever is left carries the envelope: a success or one of the
            // envelope's own refusals, which is why no assertion is needed.
            const data = outcome.response;
            await fetchEnded(data);

            if(!outcome.ok && outcome.reason === 'versionExpired'){
                // A repeat of a recent versionExpired for the same endpoint and
                // signature means the reload the handler performed brought the
                // same bundle back, and reloading again would loop. The
                // handler is not called; the failure is reported instead, and
                // the outcome still says versionExpired.
                if(this.reloadLoopBreaker.isRepeat(apiName, signature ?? "")){
                    await reportError(new Error(`Version expired again for API "${apiName}" within ${RELOAD_LOOP_WINDOW_MS / 60000} minutes with the same signature: the bundle being served is still the stale one, so versionExpiredHandler was not called again.`));
                    return outcome;
                }
                if(versionExpiredHandler){ await versionExpiredHandler(); }
                else{ await reportError(new Error("Version Expired; Please refresh;")); }
                return outcome;
            }
            if(!outcome.ok && outcome.reason === 'sessionExpired'){
                this.clearSessionCookies();
                if(sessionExpiredHandler){ await sessionExpiredHandler(); }
                else{ await reportError(new Error("Session Expired; Please log in again;")); }
                return outcome;
            }
            if(!outcome.ok && outcome.reason === 'notAuthorized'){
                if(notAuthorizedHandler){ await notAuthorizedHandler(); }
                else{ await reportError(new Error("Not Authorized;")); }
                return outcome;
            }
            // Presence, not truthiness: the envelope keeps a message an app
            // spelled out as the empty string, so the handler runs for it.
            if(data.message !== undefined && messageHandler){
                await messageHandler(data.message);
            }
            if(!outcome.ok && outcome.reason === 'errorMessage'){
                if(errorMessageHandler && data.errorMessage !== undefined){ await errorMessageHandler(data.errorMessage); }
                return outcome;
            }
            return outcome;
        }catch(err){
            // Escape hatch for anything above (typically an app handler throwing):
            // dispatch never throws, so api()/apiOutcome() call sites never do.
            const wrappedError = coerceToError(err, "The call failed before it produced an outcome");
            try {
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
            } catch { /* an app handler threw again; never propagate */ }
            return { ok: false, reason: 'unknown', error: wrappedError };
        }finally{
            dropFetchTracker();
            abort.detach();
        }
    };

    /**
     * Full-fidelity call: resolves to a discriminated LambderApiOutcome
     * instead of collapsing every failure to undefined. Never throws.
     *
     * The output is computed from the contract in the return type rather than
     * taken as a type parameter, so a call site cannot replace it by
     * annotating what it assigns to.
     */
    async apiOutcome<TApiName extends keyof TContract & string = string>(
        apiName: TApiName,
        ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderCallOptions>
    ): Promise<LambderApiOutcome<LambderContractOutputOf<TContract, TApiName>>>{
        // The tuple is a conditional type on an unresolved TApiName, so its
        // elements read as unknown from inside; the contract shaped them on
        // the way in, which is where the guarantee belongs.
        const [payload, options] = rest as [unknown, LambderCallOptions | undefined];
        return await this.dispatch<LambderContractOutputOf<TContract, TApiName>>(apiName, payload, options);
    };

    /**
     * The payload on success, `undefined` on every failure except a
     * structured refusal, which hands back whatever payload the envelope
     * carried (usually null). Neither is distinguishable from a legitimately
     * null or undefined payload: use apiOutcome() when that matters.
     */
    async api<TApiName extends keyof TContract & string = string>(
        apiName: TApiName,
        ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderCallOptions>
    ): Promise<LambderContractOutputOf<TContract, TApiName>|null|undefined> {
        const [payload, options] = rest as [unknown, LambderCallOptions | undefined];
        const outcome = await this.dispatch<LambderContractOutputOf<TContract, TApiName>>(apiName, payload, options);
        if(outcome.ok) return outcome.payload;
        return outcome.reason === 'errorMessage' ? outcome.response.payload : undefined;
    }

}

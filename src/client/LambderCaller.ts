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
import { beginIdempotentAttempt, IDEMPOTENT_ATTEMPT_NOT_SENT } from '../shared/wire/LambderIdempotencyKeyScope.js';
import { createCallAbort, type LambderCallAbortStage } from '../shared/util/LambderCallAbort.js';
import { coerceToError } from '../shared/wire/LambderCrashDetail.js';
import { isLambderTransportFailure, type LambderApiTransport } from '../shared/transport/LambderApiTransport.js';
import { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from '../shared/wire/LambderSessionCookieNames.js';
import { readApiSignature, type LambderApiSignatureMap } from '../shared/wire/LambderApiSignature.js';
import { LambderReloadLoopBreaker, RELOAD_LOOP_WINDOW_MS } from './LambderReloadLoopBreaker.js';
import { lambderFetchTransport } from './lambderFetchTransport.js';

// The outcome vocabulary and the contract-driven option typing live in
// src/shared/ (LambderInvokeCaller uses them too); re-exported so the client
// entry offers them under the same names.
export type { LambderApiOutcome, LambderApiFailureReason, LambderValidationError } from '../shared/wire/LambderApiOutcome.js';
export type { LambderProvidedGuardInputs, LambderGuardInputsProvider } from '../shared/wire/LambderCallOptions.js';

/** A handler told that something happened, with nothing to hand it. */
type NotifyHandler = ()=>void|Promise<void>;
/** One call in flight: pushed when it starts, removed when it settles, so the list holds only calls in flight. */
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
/** Handed the refusal as its message object, a plain-string errorMessage having been read as one (refusalMessageOf). */
type ErrorMessageHandler = (message: LambderAppRefusalMessage) => void|Promise<void>;

/** The logListHandler option: an answer's logList, success or failure, when it has entries. The invoke caller's onLogList, for a browser. */
export type LambderLogListHandler = (apiName: string, logList: unknown[]) => void|Promise<void>;

/**
 * Per-call options: the request extras both callers share (see
 * LambderSharedCallOptions) plus an override for every constructor handler.
 */
export type LambderCallOptions = LambderSharedCallOptions & {
    versionExpiredHandler?: NotifyHandler;
    sessionExpiredHandler?: NotifyHandler;
    messageHandler?: MessageHandler;
    errorMessageHandler?: ErrorMessageHandler;
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
    /**
     * Send credentialed cross-origin requests (fetch's `cors` mode, cookies
     * included). Default: exactly when apiPath is an absolute URL on another
     * origin than the page's, which is when a browser needs it. Ignored when
     * a transport is passed.
     */
    isCorsEnabled?: boolean,
    /** Default per-request timeout in ms (none unless set; API Gateway caps around 29s, so ~30000 is a sensible value). Overridable per call. */
    timeoutMs?: number,
    versionExpiredHandler?: NotifyHandler,
    sessionExpiredHandler?: NotifyHandler,
    messageHandler?: MessageHandler,
    errorMessageHandler?: ErrorMessageHandler,
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

/**
 * What keeps a stale bundle from reloading itself forever (see the class):
 * one for the page, shared by every caller it builds, since a reload is the
 * page's. Held per caller, two callers would each run an ask of their own at
 * the same time.
 */
const pageReloadLoopBreaker = new LambderReloadLoopBreaker();

/** Constructor options: the base options plus guardInputsProvider, mandatory once TProvided names guards. */
export type LambderCallerOptions<TContract, TProvided extends string = never> =
    LambderCallerBaseOptions & LambderGuardInputsProviderOption<TContract, TProvided>;

/**
 * @typeParam TContract - The API contract, for typed names, payloads and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderCaller<TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never> {
    private apiPath: string;
    private apiVersion?: string;
    private apiSignatures?: LambderApiSignatureMap;
    private timeoutMs?: number;

    /** The calls currently in flight, in the order they started. */
    fetchTrackerList: FetchTracker[] = [];
    /** Whether any call is in flight. Derived from the list, so the two cannot drift apart. */
    get isLoading(): boolean { return this.fetchTrackerList.length > 0; }

    private versionExpiredHandler?: NotifyHandler;
    private sessionExpiredHandler?: NotifyHandler;

    private messageHandler?: MessageHandler;
    private errorMessageHandler?: ErrorMessageHandler;
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
        this.timeoutMs = timeoutMs;
        this.sessionCookieDomain = sessionCookieDomain;
        // `?? false`: unlike the at-rest stores, this one is off unless asked for.
        this.requestCompression = resolveCompressionOption(requestCompression ?? false, DEFAULT_REQUEST_COMPRESSION_SETTINGS);
        this.transport = transport ?? lambderFetchTransport({ cors: isCorsEnabled });

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
        // A key scope sends its current key and is told how the attempt
        // ended, before any handler runs: a handler that throws must not
        // leave an unanswered attempt untold. A plain key is sent as it is.
        const idempotentAttempt = beginIdempotentAttempt(options?.idempotencyKey);
        const idempotencyKey = idempotentAttempt.key;
        let sent = false;

        // Dropped the moment the call settles, idempotently, since the finally
        // block below also runs it for the paths fetchEnded never reaches. A
        // tracker left in would grow the list by one per call, and every
        // handler call copies the list, so a long-lived page would pay more
        // per call the longer it stayed open.
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
            idempotentAttempt.settle(stage === "beforeSending" ? IDEMPOTENT_ATTEMPT_NOT_SENT : { ok: false, reason: failure.reason });
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

            // Read last, right before the send: the browser attaches the
            // cookies as the request leaves, and a rotation answered while a
            // provider above was awaited would otherwise pair the new session
            // cookie with the old token. js-cookie reads nothing without a
            // document: the token is "" then, and a transport that carries a
            // cookie jar fills it in from there.
            const token = Cookies.get(this.sessionCsrfCookieKey) || "";
            let answer: LambderApiHttpAnswer;
            try {
                sent = true;
                answer = await this.transport({
                    apiPath: this.apiPath,
                    apiName, version, token, siteHost,
                    ...(signature !== undefined ? { signature } : {}),
                    csrfCookieKey: this.sessionCsrfCookieKey,
                    ...(compressedPayload ? { compressed: compressedPayload } : { payload }),
                    ...(guardInputs !== undefined ? { guardInputs } : {}),
                    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
                    ...(headers ? { headers } : {}),
                    ...(signal ? { signal } : {}),
                });
            }catch(err){
                const wrappedError = coerceToError(err, "Request failed");
                // The caller's own abort wins, since only it knows about that.
                // Otherwise a transport that named its reason is believed:
                // "protocol" means something came back and was not an answer,
                // which is what this caller already calls `server`.
                const reason = abort.timedOut() ? 'timeout'
                    : isLambderTransportFailure(err) && err.reason === 'protocol' ? 'server'
                    : 'network';
                idempotentAttempt.settle({ ok: false, reason });
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
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
            idempotentAttempt.settle(outcome);

            // Every answer's logs, surfaced once and before any branch that
            // returns: a 500 whose global error handler attached a crash and a
            // logList has the log trail worth the most, and it returns early
            // on the `server` branch below.
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
                // A page asks for one reload at a time, however many of its
                // calls are refused. A call refused again after a reload
                // means it brought the same bundle back, and reloading again
                // would loop: the failure is reported instead of calling the
                // handler. The outcome says versionExpired either way.
                const decision = pageReloadLoopBreaker.recordVersionExpired(apiName, signature ?? "", version ?? "");
                if(decision === "alreadyAsked") return outcome;
                if(decision === "loopConfirmed"){
                    await reportError(new Error(`Version expired again for API "${apiName}" within ${RELOAD_LOOP_WINDOW_MS / 60000} minutes of a reload: the bundle being served is still the stale one, so versionExpiredHandler was not called again.`));
                    return outcome;
                }
                await pageReloadLoopBreaker.runReloadAsk(async () => {
                    if(versionExpiredHandler){ await versionExpiredHandler(); }
                    else{ await reportError(new Error("Version Expired; Please refresh;")); }
                });
                return outcome;
            }
            if(!outcome.ok && outcome.reason === 'sessionExpired'){
                // Only when the session this answer is about is still the one
                // the page holds. A call sent before a login or a rotation (a
                // poll, another tab) can answer sessionExpired after it, and
                // acting on it would delete the CSRF cookie the login just set
                // and sign the person out again. A stale answer is returned
                // with nothing touched. A cookie that is gone is no newer
                // session: the server clears both cookies when it refuses an
                // ambiguous pair, and a logout in another tab clears it too.
                // A transport that keeps its own cookies (a jar) names the
                // token it posted and the one it holds, since the page's
                // cookie is not where that session lives.
                const postedToken = answer.csrfTokens?.posted ?? token;
                const heldToken = answer.csrfTokens ? answer.csrfTokens.held() : Cookies.get(this.sessionCsrfCookieKey) || "";
                if(heldToken !== "" && heldToken !== postedToken) return outcome;
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
                if(errorMessageHandler && outcome.errorMessage !== undefined){ await errorMessageHandler(outcome.errorMessage); }
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
            // Whatever ended the call before its attempt was told (a provider
            // or a handler that threw): nothing sent tried nothing, and a
            // request that left may have run.
            idempotentAttempt.settle(sent ? { ok: false, reason: 'unknown' } : IDEMPOTENT_ATTEMPT_NOT_SENT);
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

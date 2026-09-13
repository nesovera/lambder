import Cookies from 'js-cookie';
import {
    compressPayloadGzip,
    isRequestCompressionAvailable,
    DEFAULT_REQUEST_COMPRESSION_SETTINGS,
    type LambderRequestCompressionOption,
    type LambderRequestCompressionSettings,
} from '../shared/LambderRequestPayload.js';
import { resolveCompressionOption } from '../shared/LambderCompressionOption.js';
import type { ApiContractShape } from '../shared/LambderApiContract.js';
import { resolveApiOutcome, type LambderApiOutcome, type LambderValidationError } from '../shared/LambderApiOutcome.js';
import {
    mergeGuardInputs,
    type LambderCallOptionsArg,
    type LambderGuardInputsProviderOption,
} from '../shared/LambderCallOptions.js';

// The outcome vocabulary and the contract-driven option typing are shared
// with LambderInvokeCaller (src/shared/); re-exported here so the entries
// keep their names.
export type { LambderApiOutcome, LambderApiFailureReason, LambderValidationError } from '../shared/LambderApiOutcome.js';
export type { LambderProvidedGuardInputs, LambderGuardInputsProvider } from '../shared/LambderCallOptions.js';

type VoidFunction = ()=>void|Promise<void>;
type FetchTracker = { apiName: string, done: boolean, fetchEndCalled: boolean };
type EventHandlerFetchParams = {
    apiName: string,
    payload?: any,
    headers?: Record<string, any>
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
type MessageHandler = (message:any) => void|Promise<void>;

/** One logical operation's rotating idempotency key: see LambderCaller.createIdempotencyKeyScope(). */
export type LambderIdempotencyKeyScope = {
    /** The key for the operation currently in progress. */
    readonly current: string;
    /** Call after a confirmed success: the next operation is a new intent. Returns the new key. */
    rotate(): string;
};

/** Per-call options: request extras plus overrides for every constructor handler. */
export type LambderCallOptions = {
    headers?: Record<string, any>;
    /** Abort the request after this many ms; overrides the constructor default. */
    timeoutMs?: number;
    /** External abort signal, combined with the timeout when both are set. */
    signal?: AbortSignal;
    /**
     * Overrides the constructor's requestCompression for this call: `false`
     * sends the payload plainly (a hot path where the CPU matters more than
     * the bytes), `true` compresses it regardless of the size threshold.
     * Either way a payload is only sent compressed when that is smaller.
     */
    compressRequest?: boolean;
    /**
     * Values for the API's guardInput-mode guards, keyed by guard name; sent
     * beside the payload and consumed by the guards before validation. The
     * typed contract makes this REQUIRED for APIs that declare such guards,
     * except the guards a guardInputsProvider covers (these merge on top of
     * the provider's values).
     */
    guardInputs?: Record<string, unknown>;
    /**
     * Replay-protection key for APIs declared idempotent on the server.
     * Generate once per logical operation with createIdempotencyKey() and
     * send the same key on retries: duplicates of an in-flight request
     * refuse, and repeats of a completed one replay its stored response
     * instead of re-executing. Must be UNGUESSABLE random (it scopes the
     * replay record for logged-out clients) and at least 16 characters; the
     * server refuses shorter keys with a 400.
     */
    idempotencyKey?: string;
    versionExpiredHandler?: VoidFunction;
    sessionExpiredHandler?: VoidFunction;
    messageHandler?: MessageHandler;
    errorMessageHandler?: MessageHandler;
    apiInputValidationErrorHandler?: ValidationErrorHandler;
    notAuthorizedHandler?: VoidFunction;
    errorHandler?: ErrorHandler;
    fetchStartedHandler?: FetchStartEventHandler;
    fetchEndedHandler?: FetchEndEventHandler;
};

type LambderCallerBaseOptions = {
    apiPath: string,
    apiVersion?: string,
    isCorsEnabled: boolean,
    /** Default per-request timeout in ms (none unless set; API Gateway caps around 29s, so ~30000 is a sensible value). Overridable per call. */
    timeoutMs?: number,
    versionExpiredHandler?: VoidFunction,
    sessionExpiredHandler?: VoidFunction,
    messageHandler?: MessageHandler,
    errorMessageHandler?: MessageHandler,
    notAuthorizedHandler?: VoidFunction,
    errorHandler?: ErrorHandler,
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
};

/** Constructor options: the base options plus guardInputsProvider, mandatory once TProvided names guards. */
export type LambderCallerOptions<TContract, TProvided extends string = never> =
    LambderCallerBaseOptions & LambderGuardInputsProviderOption<TContract, TProvided>;

/**
 * @typeParam TContract - The API contract, for typed names, payloads and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderCaller<TContract extends ApiContractShape = any, TProvidedGuards extends string = never> {
    private isCorsEnabled: boolean;
    private apiPath: string;
    private apiVersion?: string;
    private timeoutMs?: number;

    fetchTrackerList: FetchTracker[] = [];
    isLoading: boolean = false;

    private versionExpiredHandler?: VoidFunction;
    private sessionExpiredHandler?: VoidFunction;

    private messageHandler?: MessageHandler;
    private errorMessageHandler?: MessageHandler;
    private notAuthorizedHandler?: VoidFunction;
    private errorHandler?: ErrorHandler;
    private apiInputValidationErrorHandler?: ValidationErrorHandler;

    private fetchStartedHandler?: FetchStartEventHandler;
    private fetchEndedHandler?: FetchEndEventHandler;
    private guardInputsProvider?: (apiName: string) => unknown;

    private sessionTokenCookieKey = "LMDRSESSIONTKID";
    private sessionCsrfCookieKey = "LMDRSESSIONCSTK";
    private sessionCookieDomain?: string | ((hostname: string) => string | undefined | null);
    private requestCompression: LambderRequestCompressionSettings | null;

    constructor(options: LambderCallerOptions<TContract, TProvidedGuards>){
        // The conditional provider option is resolved per instantiation;
        // inside the class it is read through the plain shape.
        const {
            apiPath, apiVersion,
            isCorsEnabled = false,
            timeoutMs,
            versionExpiredHandler, sessionExpiredHandler,
            messageHandler, errorMessageHandler,
            notAuthorizedHandler, errorHandler,
            fetchStartedHandler, fetchEndedHandler,
            apiInputValidationErrorHandler,
            sessionCookieDomain,
            requestCompression,
            guardInputsProvider,
        } = options as LambderCallerBaseOptions & { guardInputsProvider?: (apiName: string) => unknown };
        this.apiPath = apiPath ?? "/api";
        this.apiVersion = apiVersion;
        this.isCorsEnabled = isCorsEnabled;
        this.timeoutMs = timeoutMs;
        this.sessionCookieDomain = sessionCookieDomain;
        // `?? false`: unlike the at-rest stores, this one is off unless asked for.
        this.requestCompression = resolveCompressionOption(requestCompression ?? false, DEFAULT_REQUEST_COMPRESSION_SETTINGS);

        this.versionExpiredHandler = versionExpiredHandler;
        this.sessionExpiredHandler = sessionExpiredHandler;

        this.messageHandler = messageHandler;
        this.errorMessageHandler = errorMessageHandler;
        this.notAuthorizedHandler = notAuthorizedHandler;
        this.errorHandler = errorHandler;
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;

        this.fetchStartedHandler = fetchStartedHandler;
        this.fetchEndedHandler = fetchEndedHandler;
        this.guardInputsProvider = guardInputsProvider;
    };

    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string){
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
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
     */
    static createIdempotencyKey(): string {
        const cryptoObj = globalThis.crypto;
        if(cryptoObj?.randomUUID) return cryptoObj.randomUUID();
        const bytes = new Uint8Array(16);
        if(cryptoObj?.getRandomValues){ cryptoObj.getRandomValues(bytes); }
        else { for(let i = 0; i < 16; i += 1){ bytes[i] = Math.floor(Math.random() * 256); } }
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    private clearSessionCookies(){
        const domainOption = this.sessionCookieDomain;
        const hostname = typeof window !== "undefined" ? window.location.hostname : "";
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
        const fetchStartedHandler = options?.fetchStartedHandler ?? this.fetchStartedHandler;
        const fetchEndedHandler = options?.fetchEndedHandler ?? this.fetchEndedHandler;

        const headers = options?.headers;
        const fetchTracker: FetchTracker = { apiName, done: false, fetchEndCalled: false };

        const fetchEnded = async (fetchResult: any) => {
            fetchTracker.done = true;
            if(fetchTracker.fetchEndCalled || !fetchEndedHandler) return;
            fetchTracker.fetchEndCalled = true;
            await fetchEndedHandler({
                fetchParams: { apiName, payload, headers },
                fetchResult,
                activeFetchList: this.fetchTrackerList.filter(v=>!v.done),
            });
        };

        let errorHandlerCalled = false;
        const reportError = async (err: Error) => {
            if(errorHandlerCalled || !errorHandler) return;
            errorHandlerCalled = true;
            await errorHandler(err);
        };

        // Timeout / abort wiring: the timeout gets its own controller chained
        // to any external signal, so either source aborts the fetch.
        const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
        const externalSignal = options?.signal;
        let timedOut = false;
        let signal: AbortSignal | undefined = externalSignal;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        if(timeoutMs !== undefined){
            const controller = new AbortController();
            if(externalSignal){
                if(externalSignal.aborted){ controller.abort(externalSignal.reason); }
                else { externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true }); }
            }
            timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
            signal = controller.signal;
        }

        try {
            this.fetchTrackerList.push(fetchTracker);
            if(fetchStartedHandler) await fetchStartedHandler({
                fetchParams: { apiName, payload, headers, },
                activeFetchList: this.fetchTrackerList.filter(v=>!v.done)
            });
            const version = this.apiVersion;
            const token = Cookies.get(this.sessionCsrfCookieKey) || "";
            const siteHost = window.location.hostname;
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
            const compressionMinBytes = options?.compressRequest === true ? 0
                : options?.compressRequest === false ? null
                : this.requestCompression?.minBytes ?? null;
            const compressedPayload = compressionMinBytes !== null && payload !== undefined && isRequestCompressionAvailable()
                ? await compressPayloadGzip(JSON.stringify(payload), compressionMinBytes)
                : null;

            let res: Response;
            try {
                res = await fetch(this.apiPath, {
                    method: 'POST', cache: 'no-cache',
                    // Cross-origin API hosts need CORS mode and included credentials.
                    mode: this.isCorsEnabled ? 'cors' : 'same-origin',
                    credentials: this.isCorsEnabled ? 'include' : 'same-origin',
                    redirect: 'follow', referrerPolicy: 'origin',
                    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
                    body: JSON.stringify({
                        apiName, version, token, siteHost,
                        ...(compressedPayload ?? { payload }),
                        ...(guardInputs !== undefined ? { guardInputs } : {}),
                        ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
                    }),
                    ...(signal ? { signal } : {}),
                });
            }catch(err){
                const wrappedError = err instanceof Error ? err : new Error("Request failed", { cause: err });
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
                return { ok: false, reason: timedOut ? 'timeout' : 'network', error: wrappedError };
            }

            // The reading of the answer is shared with LambderInvokeCaller;
            // only what to do about each outcome is this caller's.
            const outcome = await resolveApiOutcome<TOutput>({
                status: res.status,
                statusText: res.statusText,
                header: (name) => res.headers?.get?.(name) ?? null,
                json: () => res.json(),
                text: () => res.text(),
            });

            if(!outcome.ok && outcome.reason === 'server'){
                await fetchEnded(outcome.error);
                await reportError(outcome.error!);
                return outcome;
            }
            if(!outcome.ok && outcome.reason === 'validation'){
                await fetchEnded(null);
                if(apiInputValidationErrorHandler){
                    await apiInputValidationErrorHandler(outcome.zodError!);
                }else{
                    await reportError(new Error("API Input Validation Error", { cause: outcome.zodError }));
                }
                return outcome;
            }

            const data = outcome.response!;
            await fetchEnded(data);

            if(data.logList?.length){
                for(const record of data.logList){
                    console.log("[lambder]", record);
                }
            }
            if(!outcome.ok && outcome.reason === 'versionExpired'){
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
            if(data.message && messageHandler){
                await messageHandler(data.message);
            }
            if(!outcome.ok && outcome.reason === 'errorMessage'){
                if(errorMessageHandler){ await errorMessageHandler(data.errorMessage); }
                return outcome;
            }
            return outcome;
        }catch(err){
            // Escape hatch for anything above (typically an app handler throwing):
            // dispatch never throws, so api()/apiOutcome() call sites never do.
            const wrappedError = err instanceof Error ? err : new Error("Error: ", { cause: err });
            try {
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
            } catch { /* an app handler threw again; never propagate */ }
            return { ok: false, reason: 'unknown', error: wrappedError };
        }finally{
            fetchTracker.done = true;
            if(timeoutId !== undefined) clearTimeout(timeoutId);
        }
    };

    /**
     * Full-fidelity call: resolves to a discriminated LambderApiOutcome
     * instead of collapsing every failure to null. Never throws.
     */
    async apiOutcome<
        TApiName extends keyof TContract & string = string,
        TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any
    >(
        apiName: TApiName,
        payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any,
        ...rest: LambderCallOptionsArg<TContract, TApiName, TProvidedGuards, LambderCallOptions>
    ): Promise<LambderApiOutcome<TOutput>>{
        return await this.dispatch<TOutput>(apiName, payload, rest[0]);
    };

    /** Payload on success, null/undefined otherwise (indistinguishable from a null payload; prefer apiOutcome() when that matters). */
    async api<
        TApiName extends keyof TContract & string = string,
        TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any
    >(
        apiName: TApiName,
        payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any,
        ...rest: LambderCallOptionsArg<TContract, TApiName, TProvidedGuards, LambderCallOptions>
    ): Promise<TOutput|null|undefined> {
        const outcome = await this.dispatch<TOutput>(apiName, payload, rest[0]);
        if(outcome.ok) return outcome.response?.payload;
        return outcome.reason === 'errorMessage' ? outcome.response?.payload : undefined;
    }

}

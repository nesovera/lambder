import Cookies from 'js-cookie';
import { LambderApiResponse } from './LambderResponseBuilder';
import type { ApiContractShape } from './LambderApiContract';
import type { z } from "zod";

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
type ValidationErrorHandler = (zodError: z.ZodError) => (void|false)|Promise<(void|false)>;
type MessageHandler = (message:any) => void|Promise<void>;

export type LambderApiFailureReason =
    | 'network'          // fetch rejected: offline, DNS, CORS, or an external abort
    | 'timeout'          // aborted by the configured timeoutMs
    | 'server'           // HTTP 5xx, or a response body that is not the API envelope
    | 'validation'       // HTTP 422: the server rejected the input schema
    | 'versionExpired'   // envelope flag: client version behind the server
    | 'sessionExpired'   // envelope flag: session gone (cookies cleared)
    | 'notAuthorized'    // envelope flag: authenticated but not allowed
    | 'errorMessage'     // structured refusal on the envelope's errorMessage field
    | 'unknown';         // unexpected internal failure (e.g. an app handler threw)

/**
 * Discriminated result of an API call: `ok: true` carries the payload, every
 * failure carries a machine-readable reason, so "the server returned null"
 * and "the request failed" are never conflated.
 */
export type LambderApiOutcome<T> =
    | { ok: true; payload: T | null | undefined; response: LambderApiResponse<T> }
    | {
        ok: false;
        reason: LambderApiFailureReason;
        /** HTTP status, when a response was received. */
        status?: number;
        /** Envelope errorMessage, when the server provided one. */
        errorMessage?: any;
        /** Underlying Error for network/timeout/server/unknown failures. */
        error?: Error;
        /** Zod issue detail for 'validation'. */
        zodError?: z.ZodError;
        /** The parsed envelope, when one was received (protocol-level failures). */
        response?: LambderApiResponse<T>;
    };

/** Per-call options: request extras plus overrides for every constructor handler. */
export type LambderCallOptions = {
    headers?: Record<string, any>;
    /** Abort the request after this many ms; overrides the constructor default. */
    timeoutMs?: number;
    /** External abort signal, combined with the timeout when both are set. */
    signal?: AbortSignal;
    /**
     * Replay-protection key for APIs declared idempotent on the server.
     * Generate once per logical operation (e.g. crypto.randomUUID() when the
     * form opens) and send the same key on retries: duplicates of an
     * in-flight request refuse, and repeats of a completed one replay its
     * stored response instead of re-executing.
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

export default class LambderCaller<TContract extends ApiContractShape = any> {
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

    private sessionTokenCookieKey = "LMDRSESSIONTKID";
    private sessionCsrfCookieKey = "LMDRSESSIONCSTK";
    private sessionCookieDomain?: string | ((hostname: string) => string | undefined | null);

    constructor(
        {
            apiPath, apiVersion,
            isCorsEnabled = false,
            timeoutMs,
            versionExpiredHandler, sessionExpiredHandler,
            messageHandler, errorMessageHandler,
            notAuthorizedHandler, errorHandler,
            fetchStartedHandler, fetchEndedHandler,
            apiInputValidationErrorHandler,
            sessionCookieDomain,
        }:
        {
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
        }
    ){
        this.apiPath = apiPath ?? "/api";
        this.apiVersion = apiVersion;
        this.isCorsEnabled = isCorsEnabled;
        this.timeoutMs = timeoutMs;
        this.sessionCookieDomain = sessionCookieDomain;

        this.versionExpiredHandler = versionExpiredHandler;
        this.sessionExpiredHandler = sessionExpiredHandler;

        this.messageHandler = messageHandler;
        this.errorMessageHandler = errorMessageHandler;
        this.notAuthorizedHandler = notAuthorizedHandler;
        this.errorHandler = errorHandler;
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;

        this.fetchStartedHandler = fetchStartedHandler;
        this.fetchEndedHandler = fetchEndedHandler;

    };

    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string){
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
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
                        apiName, version, token, siteHost, payload,
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

            if(res.status >= 500){
                // Lambder's own 500 fallback is a JSON envelope, but custom
                // error handlers may answer text/HTML: parse defensively.
                let errorMessage: any;
                try {
                    const bodyText = await res.text();
                    try { errorMessage = JSON.parse(bodyText)?.errorMessage; } catch { /* not an envelope */ }
                } catch { /* body unavailable */ }
                const wrappedError = new Error("Request failed: " + res.status + " - " + res.statusText);
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
                return { ok: false, reason: 'server', status: res.status, errorMessage, error: wrappedError };
            }

            if(res.status === 422){
                // A 422 without Lambder's validation body (e.g. a proxy's
                // error page) is a server failure, not a validation result.
                let zodError: z.ZodError | undefined;
                try { zodError = (await res.json() as { error: string, zodError: z.ZodError })?.zodError; }
                catch { /* not JSON */ }
                if(zodError === undefined){
                    const wrappedError = new Error("Request failed: 422 without a validation body");
                    await fetchEnded(wrappedError);
                    await reportError(wrappedError);
                    return { ok: false, reason: 'server', status: res.status, error: wrappedError };
                }
                await fetchEnded(null);
                if(apiInputValidationErrorHandler){
                    await apiInputValidationErrorHandler(zodError);
                }else{
                    await reportError(new Error("API Input Validation Error", { cause: zodError }));
                }
                return { ok: false, reason: 'validation', status: res.status, zodError };
            }

            let data: LambderApiResponse<TOutput>;
            try {
                data = await res.json();
                if(data === null || typeof data !== "object") throw new Error("Response is not an object");
            }catch(err){
                // A non-envelope body (e.g. an HTML error page) is a server failure.
                const wrappedError = new Error("Request failed: response is not a valid API envelope (status " + res.status + ")", { cause: err });
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
                return { ok: false, reason: 'server', status: res.status, error: wrappedError };
            }

            await fetchEnded(data);

            if(data.logList?.length){
                for(const record of data.logList){
                    console.log("[lambder]", record);
                }
            }
            if(data.versionExpired){
                if(versionExpiredHandler){ await versionExpiredHandler(); }
                else{ await reportError(new Error("Version Expired; Please refresh;")); }
                return { ok: false, reason: 'versionExpired', status: res.status, errorMessage: data.errorMessage, response: data };
            }
            if(data.sessionExpired){
                this.clearSessionCookies();
                if(sessionExpiredHandler){ await sessionExpiredHandler(); }
                else{ await reportError(new Error("Session Expired; Please log in again;")); }
                return { ok: false, reason: 'sessionExpired', status: res.status, errorMessage: data.errorMessage, response: data };
            }
            if(data.notAuthorized){
                if(notAuthorizedHandler){ await notAuthorizedHandler(); }
                else{ await reportError(new Error("Not Authorized;")); }
                return { ok: false, reason: 'notAuthorized', status: res.status, errorMessage: data.errorMessage, response: data };
            }
            if(data.message && messageHandler){
                await messageHandler(data.message);
            }
            if(data.errorMessage){
                if(errorMessageHandler){ await errorMessageHandler(data.errorMessage); }
                return { ok: false, reason: 'errorMessage', status: res.status, errorMessage: data.errorMessage, response: data };
            }
            return { ok: true, payload: data.payload, response: data };
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
        options?: LambderCallOptions,
    ): Promise<LambderApiOutcome<TOutput>>{
        return await this.dispatch<TOutput>(apiName, payload, options);
    };

    /**
     * Legacy shape: the parsed envelope on success (and on structured
     * errorMessage refusals, which carry an envelope), null on every other
     * failure. Prefer apiOutcome() when the call site needs to know why.
     */
    async apiRaw<
        TApiName extends keyof TContract & string = string,
        TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any
    >(
        apiName: TApiName,
        payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any,
        options?: LambderCallOptions,
    ): Promise<LambderApiResponse<TOutput>|null|undefined>{
        const outcome = await this.dispatch<TOutput>(apiName, payload, options);
        if(outcome.ok) return outcome.response;
        return outcome.reason === 'errorMessage' ? outcome.response : null;
    };

    /** Payload on success, null/undefined otherwise (indistinguishable from a null payload; prefer apiOutcome() when that matters). */
    async api<
        TApiName extends keyof TContract & string = string,
        TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any
    >(
        apiName: TApiName,
        payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any,
        options?: LambderCallOptions,
    ): Promise<TOutput|null|undefined> {
        const result = await this.apiRaw<TApiName, TOutput>(apiName, payload, options);
        return result?.payload;
    }

}

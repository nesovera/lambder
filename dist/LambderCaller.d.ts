import { LambderApiResponse } from './LambderResponseBuilder';
import type { ApiContractShape } from './LambderApiContract';
import type { z } from "zod";
type VoidFunction = () => void | Promise<void>;
type FetchTracker = {
    apiName: string;
    done: boolean;
    fetchEndCalled: boolean;
};
type EventHandlerFetchParams = {
    apiName: string;
    payload?: any;
    headers?: Record<string, any>;
};
type FetchStartEventHandler = (params: {
    fetchParams: EventHandlerFetchParams;
    activeFetchList: FetchTracker[];
}) => void | Promise<void>;
type FetchEndEventHandler = (params: {
    fetchParams: EventHandlerFetchParams;
    fetchResult: any;
    activeFetchList: FetchTracker[];
}) => void | Promise<void>;
type ErrorHandler = (err: Error) => void | Promise<void>;
type ValidationErrorHandler = (zodError: z.ZodError) => (void | false) | Promise<(void | false)>;
type MessageHandler = (message: any) => void | Promise<void>;
export type LambderApiFailureReason = 'network' | 'timeout' | 'server' | 'validation' | 'versionExpired' | 'sessionExpired' | 'notAuthorized' | 'errorMessage' | 'unknown';
/**
 * Discriminated result of an API call: `ok: true` carries the payload, every
 * failure carries a machine-readable reason, so "the server returned null"
 * and "the request failed" are never conflated.
 */
export type LambderApiOutcome<T> = {
    ok: true;
    payload: T | null | undefined;
    response: LambderApiResponse<T>;
} | {
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
    private isCorsEnabled;
    private apiPath;
    private apiVersion?;
    private timeoutMs?;
    fetchTrackerList: FetchTracker[];
    isLoading: boolean;
    private versionExpiredHandler?;
    private sessionExpiredHandler?;
    private messageHandler?;
    private errorMessageHandler?;
    private notAuthorizedHandler?;
    private errorHandler?;
    private apiInputValidationErrorHandler?;
    private fetchStartedHandler?;
    private fetchEndedHandler?;
    private sessionTokenCookieKey;
    private sessionCsrfCookieKey;
    private sessionCookieDomain?;
    constructor({ apiPath, apiVersion, isCorsEnabled, timeoutMs, versionExpiredHandler, sessionExpiredHandler, messageHandler, errorMessageHandler, notAuthorizedHandler, errorHandler, fetchStartedHandler, fetchEndedHandler, apiInputValidationErrorHandler, sessionCookieDomain, }: {
        apiPath: string;
        apiVersion?: string;
        isCorsEnabled: boolean;
        /** Default per-request timeout in ms (none unless set; API Gateway caps around 29s, so ~30000 is a sensible value). Overridable per call. */
        timeoutMs?: number;
        versionExpiredHandler?: VoidFunction;
        sessionExpiredHandler?: VoidFunction;
        messageHandler?: MessageHandler;
        errorMessageHandler?: MessageHandler;
        notAuthorizedHandler?: VoidFunction;
        errorHandler?: ErrorHandler;
        fetchStartedHandler?: FetchStartEventHandler;
        fetchEndedHandler?: FetchEndEventHandler;
        apiInputValidationErrorHandler?: ValidationErrorHandler;
        /** Must mirror the server's session cookie Domain, otherwise expired cookies cannot be cleared. */
        sessionCookieDomain?: string | ((hostname: string) => string | undefined | null);
    });
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): void;
    /**
     * Generate an idempotency key for one logical operation. Create it when
     * the operation begins (a form opens, a draft starts), send the same key
     * on every attempt of that operation, and generate a new one after a
     * confirmed success. Uses crypto.randomUUID when available and falls back
     * to a v4 UUID from getRandomValues, because randomUUID only exists in
     * secure contexts (plain-http LAN device testing lacks it).
     */
    static createIdempotencyKey(): string;
    private clearSessionCookies;
    /** One call, one outcome. Never throws; every failure path resolves to { ok: false }. */
    private dispatch;
    /**
     * Full-fidelity call: resolves to a discriminated LambderApiOutcome
     * instead of collapsing every failure to null. Never throws.
     */
    apiOutcome<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, options?: LambderCallOptions): Promise<LambderApiOutcome<TOutput>>;
    /**
     * Legacy shape: the parsed envelope on success (and on structured
     * errorMessage refusals, which carry an envelope), null on every other
     * failure. Prefer apiOutcome() when the call site needs to know why.
     */
    apiRaw<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, options?: LambderCallOptions): Promise<LambderApiResponse<TOutput> | null | undefined>;
    /** Payload on success, null/undefined otherwise (indistinguishable from a null payload; prefer apiOutcome() when that matters). */
    api<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, options?: LambderCallOptions): Promise<TOutput | null | undefined>;
}
export {};

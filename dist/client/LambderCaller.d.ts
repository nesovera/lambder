import { type LambderRequestCompressionOption } from '../shared/LambderRequestPayload.js';
import type { ApiContractShape } from '../shared/LambderApiContract.js';
import { type LambderApiOutcome, type LambderValidationError } from '../shared/LambderApiOutcome.js';
import { type LambderCallOptionsArg, type LambderGuardInputsProviderOption } from '../shared/LambderCallOptions.js';
export type { LambderApiOutcome, LambderApiFailureReason, LambderValidationError } from '../shared/LambderApiOutcome.js';
export type { LambderProvidedGuardInputs, LambderGuardInputsProvider } from '../shared/LambderCallOptions.js';
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
type ValidationErrorHandler = (zodError: LambderValidationError) => (void | false) | Promise<(void | false)>;
type MessageHandler = (message: any) => void | Promise<void>;
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
    /**
     * Gzip the payload of calls whose JSON reaches the threshold, sending it
     * as `payloadGz` beside its byte length instead of `payload` whenever
     * that is smaller (a base64 image, say, is not, and goes plain). Off by
     * default; `true` is `{ minBytes: 4096 }`. Nothing at the call sites
     * changes, and the server understands both shapes either way, so it can
     * be turned on or off freely. Chiefly a way to fit a large payload under
     * Lambda's ~6MB invoke cap, which applies to the compressed bytes.
     */
    requestCompression?: LambderRequestCompressionOption;
};
/** Constructor options: the base options plus guardInputsProvider, mandatory once TProvided names guards. */
export type LambderCallerOptions<TContract, TProvided extends string = never> = LambderCallerBaseOptions & LambderGuardInputsProviderOption<TContract, TProvided>;
/**
 * @typeParam TContract - The API contract, for typed names, payloads and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderCaller<TContract extends ApiContractShape = any, TProvidedGuards extends string = never> {
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
    private guardInputsProvider?;
    private sessionTokenCookieKey;
    private sessionCsrfCookieKey;
    private sessionCookieDomain?;
    private requestCompression;
    constructor(options: LambderCallerOptions<TContract, TProvidedGuards>);
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): void;
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
    static createIdempotencyKeyScope(): LambderIdempotencyKeyScope;
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
    apiOutcome<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, ...rest: LambderCallOptionsArg<TContract, TApiName, TProvidedGuards, LambderCallOptions>): Promise<LambderApiOutcome<TOutput>>;
    /** Payload on success, null/undefined otherwise (indistinguishable from a null payload; prefer apiOutcome() when that matters). */
    api<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, ...rest: LambderCallOptionsArg<TContract, TApiName, TProvidedGuards, LambderCallOptions>): Promise<TOutput | null | undefined>;
}

import type { LambderAppRefusalMessage } from '../shared/wire/LambderApiRefusal.js';
import { type LambderRequestCompressionOption } from '../shared/wire/LambderRequestPayload.js';
import type { LambderApiContractShape } from '../shared/wire/LambderApiContract.js';
import { type LambderApiOutcome, type LambderValidationError } from '../shared/wire/LambderApiOutcome.js';
import { type LambderCallArgs, type LambderContractOutputOf, type LambderGuardInputsProviderOption, type LambderSharedCallOptions } from '../shared/wire/LambderCallOptions.js';
import { type LambderApiTransport } from '../shared/transport/LambderApiTransport.js';
import { type LambderApiSignatureMap } from '../shared/wire/LambderApiSignature.js';
export type { LambderApiOutcome, LambderApiFailureReason, LambderValidationError } from '../shared/wire/LambderApiOutcome.js';
export type { LambderProvidedGuardInputs, LambderGuardInputsProvider } from '../shared/wire/LambderCallOptions.js';
/** A handler told that something happened, with nothing to hand it. */
type NotifyHandler = () => void | Promise<void>;
/** One call in flight: pushed when it starts, removed when it settles, so the list is the in-flight list rather than a log of every call ever made. */
type FetchTracker = {
    apiName: string;
};
type EventHandlerFetchParams = {
    apiName: string;
    payload?: any;
    headers?: Record<string, string>;
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
type MessageHandler = (message: LambderAppRefusalMessage | string) => void | Promise<void>;
/** The logListHandler option: an answer's logList, success or failure, when it has entries. The invoke caller's onLogList, for a browser. */
export type LambderLogListHandler = (apiName: string, logList: unknown[]) => void | Promise<void>;
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
    apiPath: string;
    /** Sent with every call as `version`, informational: the server stamps its own on every answer. */
    apiVersion?: string;
    /**
     * The server's signature map, generated from its instance
     * (Lambder.apiSignatures()) and shipped with this build. Sent per call as
     * `signature`, so the server answers versionExpired to a call built
     * against another shape of the endpoint and runs every other call. Leave
     * it out and no call is gated.
     */
    apiSignatures?: LambderApiSignatureMap;
    isCorsEnabled: boolean;
    /** Default per-request timeout in ms (none unless set; API Gateway caps around 29s, so ~30000 is a sensible value). Overridable per call. */
    timeoutMs?: number;
    versionExpiredHandler?: NotifyHandler;
    sessionExpiredHandler?: NotifyHandler;
    messageHandler?: MessageHandler;
    errorMessageHandler?: MessageHandler;
    notAuthorizedHandler?: NotifyHandler;
    errorHandler?: ErrorHandler;
    /** Receives each answer's logList, with the API name. Default: console.log with a `[lambder]` prefix, one line per entry. */
    logListHandler?: LambderLogListHandler;
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
    /**
     * How a call reaches the server. Default: fetch to apiPath
     * (lambderFetchTransport, with CORS per isCorsEnabled). A mock runtime,
     * an in-process Lambder handler, or a cookie-jar decorator over either
     * are the other transports that ship; see LambderApiTransport.
     */
    transport?: LambderApiTransport;
};
/** Constructor options: the base options plus guardInputsProvider, mandatory once TProvided names guards. */
export type LambderCallerOptions<TContract, TProvided extends string = never> = LambderCallerBaseOptions & LambderGuardInputsProviderOption<TContract, TProvided>;
/**
 * @typeParam TContract - The API contract, for typed names, payloads and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderCaller<TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never> {
    private isCorsEnabled;
    private apiPath;
    private apiVersion?;
    private apiSignatures?;
    private timeoutMs?;
    /** What keeps a stale bundle from reloading itself forever; see the class. */
    private readonly reloadLoopBreaker;
    /** The calls currently in flight, in the order they started. */
    fetchTrackerList: FetchTracker[];
    /** Whether any call is in flight. Derived, so it cannot drift from the list the way a separate flag did. */
    get isLoading(): boolean;
    private versionExpiredHandler?;
    private sessionExpiredHandler?;
    private messageHandler?;
    private errorMessageHandler?;
    private notAuthorizedHandler?;
    private errorHandler?;
    private apiInputValidationErrorHandler?;
    private logListHandler?;
    private fetchStartedHandler?;
    private fetchEndedHandler?;
    private guardInputsProvider?;
    private sessionTokenCookieKey;
    private sessionCsrfCookieKey;
    private sessionCookieDomain?;
    private requestCompression;
    private transport;
    constructor(options: LambderCallerOptions<TContract, TProvidedGuards>);
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): void;
    /** Replaces how calls reach the server: a mock runtime, an in-process handler, a decorated transport. */
    setTransport(transport: LambderApiTransport): this;
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
     *
     * A runtime with neither throws rather than reaching for Math.random: the
     * key must be UNGUESSABLE, since it is what scopes the replay record for a
     * logged-out client, and a guessable one hands that client's stored
     * response to whoever guesses it.
     */
    static createIdempotencyKey(): string;
    private clearSessionCookies;
    /** One call, one outcome. Never throws; every failure path resolves to { ok: false }. */
    private dispatch;
    /**
     * Full-fidelity call: resolves to a discriminated LambderApiOutcome
     * instead of collapsing every failure to undefined. Never throws.
     *
     * The output is computed from the contract in the return type rather than
     * taken as a type parameter, so a call site cannot replace it by
     * annotating what it assigns to.
     */
    apiOutcome<TApiName extends keyof TContract & string = string>(apiName: TApiName, ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderCallOptions>): Promise<LambderApiOutcome<LambderContractOutputOf<TContract, TApiName>>>;
    /**
     * The payload on success, `undefined` on every failure except a
     * structured refusal, which hands back whatever payload the envelope
     * carried (usually null). Neither is distinguishable from a legitimately
     * null or undefined payload: use apiOutcome() when that matters.
     */
    api<TApiName extends keyof TContract & string = string>(apiName: TApiName, ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderCallOptions>): Promise<LambderContractOutputOf<TContract, TApiName> | null | undefined>;
}

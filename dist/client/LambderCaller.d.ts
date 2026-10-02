import type { LambderUncheckedRefusalMessage } from '../shared/wire/LambderApiRefusal.js';
import { type LambderRequestCompressionOption } from '../shared/wire/LambderRequestPayload.js';
import type { LambderApiContractShape, LambderContractAnyRefusalMessage, LambderContractRefusalMessage } from '../shared/wire/LambderApiContract.js';
import { type LambderApiFailure, type LambderApiOutcome, type LambderValidationError } from '../shared/wire/LambderApiOutcome.js';
import { type LambderCallArgs, type LambderContractOutputOf, type LambderGuardInputsProviderOption, type LambderSharedCallOptions } from '../shared/wire/LambderCallOptions.js';
import { type LambderApiTransport } from '../shared/transport/LambderApiTransport.js';
import { type LambderApiSignatureMap } from '../shared/wire/LambderApiSignatureMap.js';
import { type LambderContractActionOf, type LambderContractGroupsOf, type LambderContractNamesInGroup } from '../shared/wire/LambderApiGroupCalls.js';
export type { LambderApiOutcome, LambderApiFailureReason, LambderValidationError } from '../shared/wire/LambderApiOutcome.js';
export type { LambderProvidedGuardInputs, LambderGuardInputsProvider } from '../shared/wire/LambderCallOptions.js';
/** A handler told that something happened, with nothing to hand it. */
type NotifyHandler = () => void | Promise<void>;
/** One call in flight: pushed when it starts, removed when it settles, so the list holds only calls in flight. */
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
/**
 * Told that a call ended, however it ended, with the outcome apiOutcome()
 * resolves to. TMessage is what the calls it hears can refuse with, as for
 * RefusalHandler.
 */
type FetchEndEventHandler<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = (params: {
    fetchParams: EventHandlerFetchParams;
    fetchResult: LambderApiOutcome<unknown, TMessage>;
    activeFetchList: FetchTracker[];
}) => void | Promise<void>;
/**
 * Told a failure no other handler takes, with the error to report and the
 * failure outcome it came from (its reason, status, refusal and response),
 * so a reporter can word or file it by reason without reading the message.
 * A call its own signal aborted is never one. TMessage as for RefusalHandler.
 */
type ErrorHandler<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = (error: Error, failure: LambderApiFailure<TMessage>) => void | Promise<void>;
type ValidationErrorHandler = (zodError: LambderValidationError) => (void | false) | Promise<(void | false)>;
/**
 * Handed the refusal as its message object, a plain-string refusal
 * having been read as one (refusalMessageOf). TMessage is what the calls it
 * hears can refuse with: one endpoint's declared codes on a per-call
 * override, every endpoint's on the constructor's.
 */
type RefusalHandler<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = (message: TMessage) => void | Promise<void>;
/** The logListHandler option: an answer's logList, success or failure, when it has entries. The invoke caller's onLogList, for a browser. */
export type LambderLogListHandler = (apiName: string, logList: unknown[]) => void | Promise<void>;
/**
 * Per-call options: the request extras both callers share (see
 * LambderSharedCallOptions) plus an override for every constructor handler.
 * TMessage is the endpoint's refusal message, which the per-call
 * refusalHandler is handed.
 */
export type LambderCallOptions<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = LambderSharedCallOptions & {
    versionExpiredHandler?: NotifyHandler;
    sessionExpiredHandler?: NotifyHandler;
    refusalHandler?: RefusalHandler<TMessage>;
    apiInputValidationErrorHandler?: ValidationErrorHandler;
    notAuthorizedHandler?: NotifyHandler;
    errorHandler?: ErrorHandler<TMessage>;
    logListHandler?: LambderLogListHandler;
    fetchStartedHandler?: FetchStartEventHandler;
    fetchEndedHandler?: FetchEndEventHandler<TMessage>;
};
type LambderCallerBaseOptions<TMessage extends LambderUncheckedRefusalMessage = LambderUncheckedRefusalMessage> = {
    /** Must match the server's apiPath. Default: "/api", the server's own default. */
    apiPath?: string;
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
    /**
     * Send credentialed cross-origin requests (fetch's `cors` mode, cookies
     * included). Default: exactly when apiPath is an absolute URL on another
     * origin than the page's, which is when a browser needs it. Ignored when
     * a transport is passed.
     */
    isCorsEnabled?: boolean;
    /** Default per-request timeout in ms (none unless set; API Gateway caps around 29s, so ~30000 is a sensible value). Overridable per call. */
    timeoutMs?: number;
    versionExpiredHandler?: NotifyHandler;
    sessionExpiredHandler?: NotifyHandler;
    /** Handed every refusal a call of this caller comes back with, typed with every code the contract declares. */
    refusalHandler?: RefusalHandler<TMessage>;
    notAuthorizedHandler?: NotifyHandler;
    /** Handed every failure no other handler takes (see ErrorHandler), typed with every code the contract declares. */
    errorHandler?: ErrorHandler<TMessage>;
    /** Receives each answer's logList, with the API name. Default: console.log with a `[lambder]` prefix, one line per entry. */
    logListHandler?: LambderLogListHandler;
    fetchStartedHandler?: FetchStartEventHandler;
    fetchEndedHandler?: FetchEndEventHandler<TMessage>;
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
export type LambderCallerOptions<TContract, TProvided extends string = never> = LambderCallerBaseOptions<LambderContractAnyRefusalMessage<TContract>> & LambderGuardInputsProviderOption<TContract, TProvided>;
/**
 * The caller itself, before the groups: what LambderCaller is, less the
 * endpoints it reaches by group (LambderCallerGroupCalls), which the
 * constructor adds.
 *
 * @typeParam TContract - The API contract, for typed names, payloads and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
declare class LambderCallerCore<TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never> {
    #private;
    /** The calls currently in flight, in the order they started. */
    fetchTrackerList: FetchTracker[];
    /** Whether any call is in flight. Derived from the list, so the two cannot drift apart. */
    get isLoading(): boolean;
    constructor(options: LambderCallerOptions<TContract, TProvidedGuards>);
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): void;
    /** Replaces how calls reach the server: a mock runtime, an in-process handler, a decorated transport. */
    setTransport(transport: LambderApiTransport): this;
    /**
     * Full-fidelity call: resolves to a discriminated LambderApiOutcome
     * instead of collapsing every failure to undefined. Never throws. A
     * success's payload is the endpoint's output, and a refusal's
     * refusal narrows on the codes the endpoint declares.
     *
     * The output is computed from the contract in the return type rather than
     * taken as a type parameter, so a call site cannot replace it by
     * annotating what it assigns to.
     */
    apiOutcome<TApiName extends keyof TContract & string = string>(apiName: TApiName, ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderCallOptions<LambderContractRefusalMessage<TContract, TApiName>>>): Promise<LambderApiOutcome<LambderContractOutputOf<TContract, TApiName>, LambderContractRefusalMessage<TContract, TApiName>>>;
    /**
     * The endpoint's output on success, `undefined` on every failure. An
     * output is always an object or an array, so the result is truthy exactly
     * when the call succeeded; the handlers configured on the caller have
     * already been told why it did not, unless the call's own signal aborted
     * it, which tells none. Use apiOutcome() to branch on the reason at the
     * call site.
     */
    api<TApiName extends keyof TContract & string = string>(apiName: TApiName, ...rest: LambderCallArgs<TContract, TApiName, TProvidedGuards, LambderCallOptions<LambderContractRefusalMessage<TContract, TApiName>>>): Promise<LambderContractOutputOf<TContract, TApiName> | undefined>;
}
/**
 * One endpoint as a caller hands it out on its group: called, it is `api`
 * for that endpoint (the output, or undefined on a failure); `.outcome` is
 * `apiOutcome` (the full outcome, never throwing).
 */
export type LambderCallerEndpoint<TContract, TName extends keyof TContract & string, TProvidedGuards extends string> = {
    (...args: LambderCallArgs<TContract, TName, TProvidedGuards, LambderCallOptions<LambderContractRefusalMessage<TContract, TName>>>): Promise<LambderContractOutputOf<TContract, TName> | undefined>;
    outcome(...args: LambderCallArgs<TContract, TName, TProvidedGuards, LambderCallOptions<LambderContractRefusalMessage<TContract, TName>>>): Promise<LambderApiOutcome<LambderContractOutputOf<TContract, TName>, LambderContractRefusalMessage<TContract, TName>>>;
};
/** Every endpoint of a contract, by group: `caller.orders.place(input)`. */
export type LambderCallerGroupCalls<TContract, TProvidedGuards extends string> = {
    readonly [TGroup in LambderContractGroupsOf<TContract>]: {
        readonly [TName in LambderContractNamesInGroup<TContract, TGroup> as LambderContractActionOf<TName>]: LambderCallerEndpoint<TContract, TName, TProvidedGuards>;
    };
};
/**
 * A typed client of a Lambder app: `caller.orders.place(input)` for the
 * endpoint `orders.place`, `caller.orders.place.outcome(input)` for its full
 * outcome, and `caller.api("orders.place", input)` for code that has the
 * name as a value.
 */
type LambderCaller<TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never> = LambderCallerCore<TContract, TProvidedGuards> & LambderCallerGroupCalls<TContract, TProvidedGuards>;
/** The caller's own members, without the groups: what a wrapper of a caller (the test visitor) types its `api` and `apiOutcome` by. */
export type LambderCallerMembers<TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never> = LambderCallerCore<TContract, TProvidedGuards>;
declare const LambderCaller: {
    new <TContract extends LambderApiContractShape = any, TProvidedGuards extends string = never>(options: LambderCallerOptions<TContract, TProvidedGuards>): LambderCaller<TContract, TProvidedGuards>;
    readonly prototype: LambderCallerCore<any, any>;
};
export default LambderCaller;

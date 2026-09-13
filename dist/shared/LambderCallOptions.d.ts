/**
 * The contract-driven typing of a call's options argument, and the runtime
 * merge of guard inputs, shared by the browser caller (LambderCaller) and the
 * server-side invoke caller (LambderInvokeCaller). Both speak the same
 * envelope to the same kind of contract, so what an API demands of its caller
 * (a guardInput-mode guard's value, say) is decided here once and the two
 * callers cannot drift on it. Pure types and one dependency-free function,
 * so the browser entry resolves it.
 */
export type IsAny<T> = 0 extends (1 & T) ? true : false;
export type GuardInputsOf<TEntry> = TEntry extends {
    guardInputs: infer G;
} ? G : never;
/** Input type of guard G on one contract entry; never when that API does not declare it. */
type GuardInputOf<TEntry, G extends string> = GuardInputsOf<TEntry> extends infer I ? (G extends keyof I ? I[G] : never) : never;
/**
 * What guardInputsProvider returns: for every provided guard name, the value
 * the contract's APIs expect for it (a union across APIs when they differ).
 * Naming a guard no API declares in guardInput mode resolves to never, so a
 * typo fails the provider's return type instead of going missing at runtime.
 */
export type LambderProvidedGuardInputs<TContract, TProvided extends string> = IsAny<TContract> extends true ? Record<TProvided, unknown> : {
    [G in TProvided]: {
        [K in keyof TContract]: GuardInputOf<TContract[K], G>;
    }[keyof TContract];
};
/**
 * Supplies guardInputs for every call from one place (the organization the
 * UI is on, a device token), keyed by guard name; per-call guardInputs
 * merge on top. Name the guards it covers in the caller's second type
 * parameter, `new LambderCaller<Contract, "orgPermission">`, and calls to
 * APIs whose guardInput guards are all covered no longer require the
 * options argument. May be async; a throw fails the call as an unknown
 * error before anything is sent.
 */
export type LambderGuardInputsProvider<TContract, TProvided extends string> = (apiName: keyof TContract & string) => LambderProvidedGuardInputs<TContract, TProvided> | Promise<LambderProvidedGuardInputs<TContract, TProvided>>;
/** Optional until the caller names provided guards: naming them without a provider would send nothing. */
export type LambderGuardInputsProviderOption<TContract, TProvided extends string> = [
    TProvided
] extends [never] ? {
    guardInputsProvider?: LambderGuardInputsProvider<TContract, TProvided>;
} : {
    guardInputsProvider: LambderGuardInputsProvider<TContract, TProvided>;
};
/** An API's guardInput guards the provider does not cover: those the call must still pass. */
type RemainingGuardInputs<TEntry, TProvided extends string> = Omit<GuardInputsOf<TEntry>, TProvided>;
/**
 * The options argument of one call: optional normally, REQUIRED (with
 * guardInputs) when the API's contract declares guardInput-mode guards the
 * provider does not cover, so forgetting to send a guard's value is a
 * compile error at the call site. Provided guards may still be overridden
 * per call. TOptions is the caller's own per-call options type; the
 * guardInputs requirement is layered on top of it.
 */
export type LambderCallOptionsArg<TContract, TApiName, TProvided extends string, TOptions extends {
    guardInputs?: Record<string, unknown>;
}> = IsAny<TContract> extends true ? [options?: TOptions] : TApiName extends keyof TContract ? [GuardInputsOf<TContract[TApiName]>] extends [never] ? [options?: TOptions] : [keyof RemainingGuardInputs<TContract[TApiName], TProvided>] extends [never] ? [options?: TOptions & {
    guardInputs?: Partial<GuardInputsOf<TContract[TApiName]>>;
}] : [
    options: TOptions & {
        guardInputs: RemainingGuardInputs<TContract[TApiName], TProvided> & Partial<GuardInputsOf<TContract[TApiName]>>;
    }
] : [options?: TOptions];
/**
 * Provider values underneath, per-call values on top; undefined when neither
 * side supplied any. Synchronous on purpose: a caller awaits its provider
 * only when it has one, so a call without a provider still issues its
 * request in the same tick it was made.
 */
export declare const mergeGuardInputs: (provided: Record<string, unknown> | undefined, perCall: Record<string, unknown> | undefined) => Record<string, unknown> | undefined;
export {};

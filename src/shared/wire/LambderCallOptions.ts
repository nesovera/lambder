/**
 * The per-call options both callers take, the contract-driven typing of a
 * call's arguments, and the runtime merge of guard inputs, shared by the
 * browser caller (LambderCaller) and the server-side invoke caller
 * (LambderInvokeCaller). Both speak the same envelope to the same kind of
 * contract, so what an API demands of its caller (a guardInput-mode guard's
 * value, say) is decided here once and the two callers cannot drift on it.
 * Pure types and one dependency-free function, so the browser entry resolves
 * it.
 */

import type { LambderContractIdempotencyOf } from "./LambderApiContract.js";

type IsAny<T> = 0 extends (1 & T) ? true : false;

/**
 * The options every call takes, whichever caller sends it. Each caller adds
 * its own on top: the browser's per-call handler overrides, the invoke
 * caller's `clientIp` and `session`.
 */
export type LambderSharedCallOptions = {
    /** Extra request headers the server sees. */
    headers?: Record<string, string>;
    /** Abort the call after this many ms; overrides the constructor default. */
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
     * Generate once per logical operation with
     * LambderCaller.createIdempotencyKey() and send the same key on retries:
     * duplicates of an in-flight request refuse, and repeats of a completed
     * one replay its stored response instead of re-executing. Must be
     * UNGUESSABLE random (it scopes the replay record for logged-out clients)
     * and at least 16 characters; the server refuses shorter keys with a 400.
     *
     * The typed contract makes this REQUIRED for an API whose entry declares
     * `idempotency`, the way it does for guardInput values: a server
     * declaration that reads as protection and silently provides none (the
     * server runs a keyless call, which dedupes nothing) is exactly what the
     * typed caller is for.
     */
    idempotencyKey?: string;
};

/** The payload type one API of a contract takes; `any` for an untyped caller or a name the contract does not know. */
type LambderContractInputOf<TContract, TApiName> =
    IsAny<TContract> extends true ? any
    : TApiName extends keyof TContract
        ? TContract[TApiName] extends { input: infer TInput } ? TInput : any
        : any;

/** The output type one API of a contract declares; `any` for an untyped caller or a name the contract does not know. */
export type LambderContractOutputOf<TContract, TApiName> =
    IsAny<TContract> extends true ? any
    : TApiName extends keyof TContract
        ? TContract[TApiName] extends { output: infer TOutput } ? TOutput : any
        : any;

type GuardInputsOf<TEntry> = TEntry extends { guardInputs: infer G } ? G : never;
/** Input type of guard G on one contract entry; never when that API does not declare it. */
type GuardInputOf<TEntry, G extends string> = GuardInputsOf<TEntry> extends infer I ? (G extends keyof I ? I[G] : never) : never;

/**
 * What guardInputsProvider returns: for every provided guard name, the value
 * the contract's APIs expect for it (a union across APIs when they differ).
 * Naming a guard no API declares in guardInput mode resolves to never, so a
 * typo fails the provider's return type instead of going missing at runtime.
 */
export type LambderProvidedGuardInputs<TContract, TProvided extends string> =
    IsAny<TContract> extends true ? Record<TProvided, unknown>
    : { [G in TProvided]: { [K in keyof TContract]: GuardInputOf<TContract[K], G> }[keyof TContract] };

/**
 * Supplies guardInputs for every call from one place (the organization the
 * UI is on, a device token), keyed by guard name; per-call guardInputs
 * merge on top. Name the guards it covers in the caller's second type
 * parameter, `new LambderCaller<Contract, "orgPermission">`, and calls to
 * APIs whose guardInput guards are all covered do not require the
 * options argument. May be async; a throw fails the call as an unknown
 * error before anything is sent.
 */
export type LambderGuardInputsProvider<TContract, TProvided extends string> =
    (apiName: keyof TContract & string) => LambderProvidedGuardInputs<TContract, TProvided> | Promise<LambderProvidedGuardInputs<TContract, TProvided>>;

/** Optional until the caller names provided guards: naming them without a provider would send nothing. */
export type LambderGuardInputsProviderOption<TContract, TProvided extends string> =
    [TProvided] extends [never]
        ? { guardInputsProvider?: LambderGuardInputsProvider<TContract, TProvided> }
        : { guardInputsProvider: LambderGuardInputsProvider<TContract, TProvided> };

/** An API's guardInput guards the provider does not cover: those the call must still pass. */
type RemainingGuardInputs<TEntry, TProvided extends string> = Omit<GuardInputsOf<TEntry>, TProvided>;

/**
 * The guardInputs field of one API's options: absent when its guards take no
 * client input, optional when the provider covers every one of them (they may
 * still be overridden per call), and mandatory with the uncovered ones spelled
 * out otherwise.
 */
type ContractGuardInputsField<TEntry, TProvided extends string> =
    [GuardInputsOf<TEntry>] extends [never]
        ? {}
        : [keyof RemainingGuardInputs<TEntry, TProvided>] extends [never]
            ? { guardInputs?: Partial<GuardInputsOf<TEntry>> }
            : { guardInputs: RemainingGuardInputs<TEntry, TProvided> & Partial<GuardInputsOf<TEntry>> };

/**
 * The idempotencyKey field of one API's options: mandatory once the entry
 * declares `idempotency`, absent otherwise.
 *
 * Read as "required unless it says false" rather than "required only when it
 * says true", so an entry whose option widened to `boolean` (declared through
 * a spread, or built in a helper) keeps the requirement instead of quietly
 * losing its compile-time half.
 */
type ContractIdempotencyKeyField<TContract, TApiName> =
    TApiName extends keyof TContract
        ? [LambderContractIdempotencyOf<TContract, TApiName>] extends [never]
            ? {}
            : [LambderContractIdempotencyOf<TContract, TApiName>] extends [false]
                ? {}
                : { idempotencyKey: string }
        : {};

/**
 * What the contract adds to one call's options: the guardInputs field and the
 * idempotencyKey field, each decided by what the API's entry declares.
 */
type ContractCallFields<TContract, TApiName, TProvided extends string> =
    TApiName extends keyof TContract
        ? ContractGuardInputsField<TContract[TApiName], TProvided> & ContractIdempotencyKeyField<TContract, TApiName>
        : {};

/**
 * The options argument of one call: optional normally, REQUIRED when the
 * contract demands something of it, so forgetting a guard's value or an
 * idempotent API's key is a compile error at the call site rather than a 422
 * from the server or a replay that never happens. TOptions is the caller's own
 * per-call options type; the contract's fields are layered on top of it.
 *
 * `{} extends TFields` is the question "is every field the contract added
 * optional": an empty object is assignable to a type whose properties are all
 * optional and to nothing else.
 */
type LambderCallOptionsArg<TContract, TApiName, TProvided extends string, TOptions extends { guardInputs?: Record<string, unknown> }> =
    IsAny<TContract> extends true ? [options?: TOptions]
    : TApiName extends keyof TContract
        ? ContractCallFields<TContract, TApiName, TProvided> extends infer TFields
            ? {} extends TFields
                ? [options?: TOptions & TFields]
                : [options: TOptions & TFields]
            : never
        : [options?: TOptions];

/**
 * Everything one call passes after the API name: the payload, then the
 * options, both decided by the contract.
 *
 * The payload is optional only when the API's input accepts undefined, so
 * `caller.api("getUser")` against `input: { id: string }` is a compile error
 * at the call site rather than a 422 from the server. Building it as one rest
 * tuple is what makes that possible: a plain optional parameter cannot be
 * made mandatory by a later type, and TypeScript has no per-argument
 * conditional otherwise.
 *
 * When the options argument is itself mandatory (an uncovered guardInput
 * guard, an idempotent API's key), the payload cannot stay optional in front
 * of it, since a tuple's required element may not follow an optional one.
 * Such a call passes its payload explicitly, `undefined` included.
 */
export type LambderCallArgs<TContract, TApiName, TProvided extends string, TOptions extends { guardInputs?: Record<string, unknown> }> =
    LambderCallOptionsArg<TContract, TApiName, TProvided, TOptions> extends [options: infer TRequired]
        ? [payload: LambderContractInputOf<TContract, TApiName>, options: TRequired]
        : LambderCallOptionsArg<TContract, TApiName, TProvided, TOptions> extends [options?: infer TOptional]
            ? undefined extends LambderContractInputOf<TContract, TApiName>
                ? [payload?: LambderContractInputOf<TContract, TApiName>, options?: TOptional]
                : [payload: LambderContractInputOf<TContract, TApiName>, options?: TOptional]
            : never;

/**
 * Provider values underneath, per-call values on top; undefined when neither
 * side supplied any. Synchronous on purpose: a caller awaits its provider
 * only when it has one, so a call without a provider still issues its
 * request in the same tick it was made.
 */
export const mergeGuardInputs = (
    provided: Record<string, unknown> | undefined,
    perCall: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined =>
    provided !== undefined || perCall !== undefined ? { ...provided, ...perCall } : undefined;

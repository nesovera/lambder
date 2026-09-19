/**
 * Lambder API Contract System
 *
 * Contracts are built via method chaining and inferred using typeof lambder.ApiContract
 */
import type { LambderCrashDetail } from "./LambderCrashDetail.js";
import type { LambderNonEmptyOptionMap } from "../util/LambderTypeUtilities.js";
import type { LambderAppRefusalMessage } from "./LambderApiRefusal.js";
import type { LambderApiIdempotencyOption, LambderGuardsOptionValue, LambderRateLimitOptionValue } from "./LambderApiOptionValues.js";
/** Whether an endpoint runs without a session or requires one (addApi versus addSessionApi). */
export type LambderApiMode = "public" | "session";
/**
 * Base shape for API contracts: what LambderCaller, LambderInvokeCaller and
 * LambderMockApp accept as a contract type.
 */
export type LambderApiContractShape = Record<string, {
    input: any;
    output: any;
    /** "public" (addApi) or "session" (addSessionApi). */
    mode?: LambderApiMode;
    /** Present when the API declares guardInput-mode guards: guard name -> value the client must send via options.guardInputs. */
    guardInputs?: any;
    /**
     * Present when the API declares guards: the `guards` option exactly as
     * written at registration, so a client-side copy of "what does this API
     * need" can be pinned to the server's own declaration with `satisfies`
     * rather than kept honest by a test that reads the source.
     */
    guards?: LambderGuardsOptionValue;
    /** Present when the API declares a rate limit: the `rateLimit` option exactly as written. */
    rateLimit?: LambderRateLimitOptionValue;
    /** Present when the API declares idempotency: the `idempotency` option exactly as written. */
    idempotency?: LambderApiIdempotencyOption;
}>;
/** Envelope flags/channels the server may set beside (or instead of) the payload. */
export type LambderApiResponseConfig = {
    versionExpired?: boolean;
    sessionExpired?: boolean;
    notAuthorized?: boolean;
    message?: any;
    /** A refusal message, or a plain string: what LambderApiRefusal and res.api(null, { errorMessage }) put here. */
    errorMessage?: LambderAppRefusalMessage | string;
    logList?: any[];
    /**
     * A crash described in full (name, message, stack, cause chain, where it
     * happened), for a caller that is allowed to see it: a global error
     * handler answering a trusted invoker sets it with describeCrash().
     * LambderInvokeCaller reads it back as the cause of the error it throws;
     * the browser caller ignores it.
     */
    crash?: LambderCrashDetail;
};
/**
 * The config a null answer carries: at least one of the reason fields, so
 * `res.api(null, {})` is a compile error. A bare null with no flag and no
 * message reaches the caller as a success whose payload is null, which is
 * indistinguishable from an endpoint that answered nothing on purpose.
 */
export type LambderApiNullAnswerConfig = LambderNonEmptyOptionMap<Pick<LambderApiResponseConfig, "versionExpired" | "sessionExpired" | "notAuthorized" | "errorMessage" | "message">> & LambderApiResponseConfig;
/** The API wire envelope both sides speak: res.api() emits it, LambderCaller parses it. */
export type LambderApiEnvelopeBody<T> = LambderApiResponseConfig & {
    apiVersion?: string | null;
    payload?: T | null;
};
/**
 * One contract entry as addApi/addSessionApi record it: the payload types,
 * the mode, and every declarative option exactly as written. Options that
 * were not written are absent rather than undefined, so `keyof` an entry
 * lists only what the endpoint declared.
 */
export type LambderContractEntry<In, Out, Mode extends LambderApiMode, GuardInputs = never, Guards = never, RateLimit = never, Idempotency = never> = {
    input: In;
    output: Out;
    mode: Mode;
} & ([GuardInputs] extends [never] ? {} : {
    guardInputs: GuardInputs;
}) & ([Guards] extends [never] ? {} : {
    guards: Guards;
}) & ([RateLimit] extends [never] ? {} : {
    rateLimit: RateLimit;
}) & ([Idempotency] extends [never] ? {} : {
    idempotency: Idempotency;
});
/** Helper type for merging a new entry into the contract during chaining. */
export type LambderMergeContract<Old, Name extends string, Entry> = Old & {
    [K in Name]: Entry;
};
/** Guard names referenced by a guards option, whichever of its three forms is used. */
export type LambderGuardNamesIn<TOpt> = TOpt extends string ? TOpt : TOpt extends readonly (infer N extends string)[] ? N : TOpt extends object ? keyof TOpt & string : never;
/** The endpoint's mode; a contract written without one admits either. */
export type LambderContractMode<C, K extends keyof C> = C[K] extends {
    mode: infer M extends LambderApiMode;
} ? M : LambderApiMode;
/** The endpoint names of one mode. */
export type LambderContractKeysWithMode<C, M extends LambderApiMode> = {
    [K in keyof C]: LambderContractMode<C, K> extends M ? K : never;
}[keyof C] & string;
/** The endpoint's guards option as written, or never when it declared none. */
export type LambderContractGuardsOf<C, K extends keyof C> = C[K] extends {
    guards: infer G;
} ? G : never;
/** Every guard name any endpoint of the contract declares, or only the endpoints of mode M. */
export type LambderContractGuardNames<C, M extends LambderApiMode = LambderApiMode> = {
    [K in LambderContractKeysWithMode<C, M>]: LambderGuardNamesIn<LambderContractGuardsOf<C, K>>;
}[LambderContractKeysWithMode<C, M>] & string;
/** The endpoint's guardInputs requirement, or never when its guards take no client input. */
export type LambderContractGuardInputsOf<C, K extends keyof C> = C[K] extends {
    guardInputs: infer G;
} ? G : never;
/** The value guard N takes from the client, as the endpoints declaring it inferred it (a union across them when they differ). */
export type LambderContractGuardInput<C, N extends string> = {
    [K in keyof C]: [LambderContractGuardInputsOf<C, K>] extends [never] ? never : (N extends keyof LambderContractGuardInputsOf<C, K> ? LambderContractGuardInputsOf<C, K>[N] : never);
}[keyof C];
/**
 * Guard names any endpoint declares in guardInput mode: the ones whose
 * value the client sends. (An endpoint without guardInputs contributes
 * nothing: `keyof never` would be every key, so it is excluded first.)
 */
export type LambderContractGuardInputNames<C> = {
    [K in keyof C]: [LambderContractGuardInputsOf<C, K>] extends [never] ? never : keyof LambderContractGuardInputsOf<C, K> & string;
}[keyof C];
/** The endpoint's rateLimit option as written, or never. */
export type LambderContractRateLimitOf<C, K extends keyof C> = C[K] extends {
    rateLimit: infer R;
} ? R : never;
/** Every rate-limit policy name any endpoint of the contract references, or only the endpoints of mode M. The rateLimit option takes the guards option's three forms, so the names come out the same way. */
export type LambderContractRateLimitNames<C, M extends LambderApiMode = LambderApiMode> = {
    [K in LambderContractKeysWithMode<C, M>]: LambderGuardNamesIn<LambderContractRateLimitOf<C, K>>;
}[LambderContractKeysWithMode<C, M>] & string;
/** The endpoint's idempotency option as written, or never. */
export type LambderContractIdempotencyOf<C, K extends keyof C> = C[K] extends {
    idempotency: infer I;
} ? I : never;

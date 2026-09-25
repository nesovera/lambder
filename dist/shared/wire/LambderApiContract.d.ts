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
    /**
     * A refusal message, or a plain string when writing
     * (`res.api(null, { errorMessage: "..." })`): the envelope goes out with
     * the message object either way. Read off the wire it can still be a
     * string, or no message at all, wherever a Lambder server did not write
     * the body (a hand-built mock answer, a proxy); refusalMessageOf reads
     * whatever arrives as a message.
     */
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
/**
 * The API wire envelope both sides speak: res.api() emits it, LambderCaller
 * parses it. `apiVersion` is always there (null when the server set none):
 * it is how a reader tells a Lambder envelope from another JSON answer, such
 * as API Gateway's own `{ "message": ... }` errors, so an answer without it
 * reads as a server failure.
 */
export type LambderApiEnvelopeBody<T> = LambderApiResponseConfig & {
    apiVersion: string | null;
    payload?: T | null;
};
/** A value that is already JSON, recursive structures such as z.json() included. */
type LambderJsonValue = string | number | boolean | null | LambderJsonValue[] | {
    [key: string]: LambderJsonValue;
};
/** An array item once it has been through JSON: what an object would drop, an array writes as null. */
type LambderJsonArrayItemOf<T> = T extends undefined | symbol | ((...args: any[]) => unknown) ? null : LambderJsonOf<T>;
/**
 * The keys of object T that JSON may leave out: those whose value may be
 * undefined, since JSON.stringify omits such a key. Distributed over K, the
 * keys of T, one at a time. An index signature is never one of them: a
 * record's undefined entries are left out, which its value type already
 * says once undefined is dropped from it.
 */
type LambderJsonOmissibleKeys<T, K extends keyof T = keyof T> = K extends keyof T ? (string extends K ? never : number extends K ? never : undefined extends T[K] ? K : never) : never;
/**
 * The type a value has once it has been through JSON: what an API's output
 * reaches a client as. A Date becomes its string (through toJSON), a
 * function, a symbol or an undefined member is dropped (written as null in
 * an array), and a bigint, which JSON.stringify refuses, is never. A key
 * whose value may be undefined is optional, since JSON leaves it out then,
 * and a Map or a Set, whose entries are not properties, is written as an
 * empty object. `unknown` stays unknown, and a type that is already JSON
 * maps to itself, which is also what lets a recursive one such as z.json()
 * resolve.
 *
 * An object is mapped in two steps. The omissible keys are made optional
 * first, through the key types alone, and the mapping over the result then
 * keeps each key's modifiers. Deciding optionality inside the mapping, per
 * key, would need the mapped value of every key before the object's own
 * keys were known, which a recursive type (a tree of its own nodes) cannot
 * give without recursing for ever.
 */
export type LambderJsonOf<T> = unknown extends T ? T : T extends LambderJsonValue ? T : T extends {
    toJSON(): infer TJson;
} ? LambderJsonOf<TJson> : T extends undefined | bigint | symbol | ((...args: any[]) => unknown) ? never : T extends readonly unknown[] ? {
    [K in keyof T]: LambderJsonArrayItemOf<T[K]>;
} : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> ? {} : T extends object ? (Partial<Pick<T, LambderJsonOmissibleKeys<T>>> & Omit<T, LambderJsonOmissibleKeys<T>>) extends infer TKeyed ? {
    [K in keyof TKeyed as K extends string | number ? (string extends K ? K : number extends K ? K : [LambderJsonOf<TKeyed[K]>] extends [never] ? never : K) : never]: LambderJsonOf<TKeyed[K]>;
} : never : never;
/**
 * What an API's output reaches the client as: LambderJsonOf of the schema's
 * output, except at the top, where an envelope carries no payload at all
 * rather than a JSON `undefined`. A void or undefined output keeps its type,
 * so a handler and a mock handler answer nothing, and an output that may be
 * undefined keeps that member, which LambderJsonOf drops as it would a
 * member of an object.
 */
export type LambderJsonOutputOf<T> = [T] extends [void] ? T : (undefined extends T ? undefined : never) | LambderJsonOf<T>;
/**
 * One contract entry as addApi/addSessionApi record it: the payload types,
 * the mode, and every declarative option exactly as written. Options that
 * were not written are absent rather than undefined, so `keyof` an entry
 * lists only what the endpoint declared.
 *
 * `In` is what a client sends (the input schema's z.input: a field with a
 * default is optional, a transform's source type is what is posted) and `Out`
 * what it receives (the output schema's z.output as JSON, see
 * LambderJsonOf). The handler's own types are the other side of each, and
 * are not recorded here.
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
/**
 * The contract as one object type, for the `export interface` a consuming
 * app declares its contract through:
 *
 * ```ts
 * export interface ApiContractType extends LambderFlattenContract<typeof lambder.ApiContract> {}
 * ```
 *
 * Chaining leaves the contract an intersection one member deep per endpoint
 * (LambderMergeContract above), and every `C[K]` against a type parameter
 * resolves the property across all of them. The reading helpers below are
 * built on that lookup, so each pays it again per endpoint: in a 182-endpoint
 * app one indexed access costs ~3,000 type instantiations and one mock
 * registration ~18,000.
 *
 * An interface's members are declared, so they resolve once for the whole
 * declaration: the same access costs ~6 instantiations instead, roughly
 * halving such an app's frontend type check time. The alias form
 * (`type C = LambderFlattenContract<...>`) does NOT do this: a mapped type
 * stays deferred and each lookup pays in full, so the `interface ... extends`
 * spelling is the point. Diagnostics also print the interface by name rather
 * than a truncated spill of entries.
 *
 * Every endpoint name must be a string literal for an interface to extend
 * the result, which registration through addApi/addSessionApi guarantees.
 *
 * Two things that look like tidying undo it:
 *
 * - `@typescript-eslint/no-empty-object-type` reports the empty body as
 *   "equivalent to its supertype" and its fix is a type alias, the one
 *   spelling that collapses nothing. Disable the rule on the line instead.
 * - Extending anything but a mapped type loses the inferable index signature.
 *   A hand-written `interface C { ... }` has none, so it is not assignable to
 *   LambderApiContractShape, and initLambderMock<C>, LambderCaller<C> and
 *   LambderInvokeCaller<C> reject it. api-contract.test.ts pins this, and
 *   that the flattened contract is the same type member for member.
 */
export type LambderFlattenContract<C> = {
    [K in keyof C]: C[K];
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
/**
 * The endpoint names whose guards option names guard N, in any of its three
 * forms and whatever else it declares beside it. What a test that calls
 * every endpoint behind one guard loops over, and what a list meant to hold
 * exactly those endpoints is checked against. `satisfies` refuses a name the
 * guard does not cover; a missing name needs a check of its own:
 *
 * ```ts
 * type AdminApi = LambderContractKeysWithGuard<Contract, "platformAdmin">;
 * const ADMIN_APIS = ["admin.listUsers", "admin.deleteUser"] as const satisfies readonly AdminApi[];
 * // Fails to compile while an endpoint behind the guard is left off the list.
 * const adminApisComplete: [Exclude<AdminApi, (typeof ADMIN_APIS)[number]>] extends [never] ? true : false = true;
 * ```
 */
export type LambderContractKeysWithGuard<C, N extends string> = {
    [K in keyof C]: N extends LambderGuardNamesIn<LambderContractGuardsOf<C, K>> ? K : never;
}[keyof C] & string;
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
export {};

/**
 * Lambder API Contract System
 *
 * Contracts are the endpoint declarations an instance registered, read with typeof lambder.ApiContract
 */
import type { LambderCrashDetail } from "./LambderCrashDetail.js";
import type { LambderUncheckedRefusalMessage, LambderPlainRefusalMessage, LambderRefusalMessage } from "./LambderApiRefusal.js";
import type { LambderApiIdempotencyOption, LambderGuardsOptionValue, LambderRateLimitOptionValue } from "./LambderApiOptionValues.js";
/** Whether an endpoint runs without a session or requires one: "session" exactly when one of its guards needs a session. */
export type LambderApiMode = "public" | "session";
/**
 * Base shape for API contracts: what LambderCaller, LambderInvokeCaller and
 * LambderMockApp accept as a contract type.
 */
export type LambderApiContractShape = Record<string, {
    input: any;
    output: any;
    /** "public", or "session" when one of its guards needs a session. */
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
    /** Present when the API can refuse with a declared code: each code mapped to `{ data }` or `{}`. See LambderContractRefusalsOf. */
    refusals?: Record<string, {
        data?: unknown;
    }>;
}>;
/**
 * What a refusal envelope may carry besides its null payload: the flags a
 * caller routes on, the refusal's message, the call's logList, and a crash
 * described for a caller allowed to see it. The one shape the envelope
 * writer takes for every answer that is not a handler's output.
 */
export type LambderRefusalEnvelopeFields = {
    versionExpired?: boolean;
    sessionExpired?: boolean;
    notAuthorized?: boolean;
    /**
     * The refusal's message, or a plain string: the envelope goes out with
     * the message object either way (refusalMessageOf).
     */
    refusal?: LambderUncheckedRefusalMessage | string;
    logList?: unknown[];
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
 * What `res.apiRefusal` writes: an answer to an API call from outside its
 * handler (a hook, a fallback, the input validation handler, the global
 * error handler). It is always a refusal, never a success: it carries an
 * refusal or one of the three flags, which is what a reader tells it
 * from a handler's output by, so a caller's success is only ever the
 * handler's parsed output.
 *
 * Its message carries a framework code or none, and never data: it answers
 * outside any one endpoint's declared refusals, which are what a reader's
 * types allow.
 */
export type LambderApiRefusalConfig = Omit<LambderRefusalEnvelopeFields, "refusal"> & {
    refusal?: LambderPlainRefusalMessage | string;
} & ({
    refusal: LambderPlainRefusalMessage | string;
} | {
    versionExpired: true;
} | {
    sessionExpired: true;
} | {
    notAuthorized: true;
});
/** What every API envelope carries. `apiVersion` is always there (null when the server set none): it is how a reader tells a Lambder envelope from another JSON answer, such as API Gateway's own `{ "message": ... }` errors. */
type LambderApiEnvelopeFields = {
    apiVersion: string | null;
    logList?: unknown[];
};
/** A handler's answer on the wire: its output, parsed through the API's output schema, and nothing else. */
export type LambderApiSuccessEnvelope<T> = LambderApiEnvelopeFields & {
    payload: T;
};
/**
 * Every other answer on the wire: a null payload beside the refusal's
 * message and flags. The flags are present only when set. `refusal` is
 * as it came off the wire, which a reader normalizes (refusalMessageOf),
 * since a body no Lambder server wrote (a hand-built mock answer, a proxy)
 * can put anything there.
 */
export type LambderApiRefusalEnvelope = LambderApiEnvelopeFields & {
    payload: null;
    versionExpired?: true;
    sessionExpired?: true;
    notAuthorized?: true;
    refusal?: LambderUncheckedRefusalMessage | string;
    crash?: LambderCrashDetail;
};
/** The API wire envelope both sides speak: the server writes it, LambderCaller and LambderInvokeCaller read it. */
export type LambderApiEnvelopeBody<T> = LambderApiSuccessEnvelope<T> | LambderApiRefusalEnvelope;
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
 * One contract entry as defineApi records it: the payload types,
 * the mode, and every declarative option exactly as written. Options that
 * were not written are absent rather than undefined, so `keyof` an entry
 * lists only what the endpoint declared.
 *
 * `In` is what a client sends (the input schema's z.input: a field with a
 * default is optional, a transform's source type is what is posted) and `Out`
 * what it receives (the output schema's z.output as JSON, see
 * LambderJsonOf). The handler's own types are the other side of each, and
 * are not recorded here.
 *
 * `Refusals` is the one member not recorded as written: it is every code the
 * endpoint can refuse with, its own `refusals` option and those of the guards
 * it declares together, each mapped to `{ data }` (the data as JSON) or `{}`.
 * A reader needs the whole set, and the guards' part is not in the entry.
 */
export type LambderContractEntry<In, Out, Mode extends LambderApiMode, GuardInputs = never, Guards = never, RateLimit = never, Idempotency = never, Refusals = never> = {
    input: In;
    output: Out;
    mode: Mode;
} & ([Refusals] extends [never] ? {} : {
    refusals: Refusals;
}) & ([GuardInputs] extends [never] ? {} : {
    guardInputs: GuardInputs;
}) & ([Guards] extends [never] ? {} : {
    guards: Guards;
}) & ([RateLimit] extends [never] ? {} : {
    rateLimit: RateLimit;
}) & ([Idempotency] extends [never] ? {} : {
    idempotency: Idempotency;
});
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
 * type AdminApi = LambderContractKeysWithGuard<Contract, "adminOnly">;
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
/**
 * The codes endpoint K can refuse with, each mapped to `{ data }` or `{}`;
 * `{}` when it declares none.
 */
export type LambderContractRefusalsOf<C, K extends keyof C> = C[K] extends {
    refusals: infer R;
} ? R : {};
/**
 * The refusal message a call to endpoint K can come back with: one arm per
 * code it declares, plus the framework's and the uncoded refusal. An untyped
 * contract (one with an index signature) is read as any code.
 */
export type LambderContractRefusalMessage<C, K extends keyof C> = 0 extends 1 & C ? LambderUncheckedRefusalMessage : string extends keyof C ? LambderUncheckedRefusalMessage : LambderRefusalMessage<LambderContractRefusalsOf<C, K>>;
type LambderContractRefusalMaps<C> = {
    [K in keyof C]: LambderContractRefusalsOf<C, K>;
}[keyof C];
type LambderContractRefusalCodes<C> = LambderContractRefusalMaps<C> extends infer TMap ? TMap extends unknown ? keyof TMap & string : never : never;
/**
 * Every code any endpoint of the contract declares, mapped to its `{ data }`
 * or `{}`. Built code by code, not by joining the endpoints' own maps, so a
 * code many endpoints declare is one arm rather than one per endpoint (the
 * vocabulary gives a code one data shape wherever it is used).
 */
export type LambderContractRefusals<C> = {
    [TCode in LambderContractRefusalCodes<C>]: Extract<LambderContractRefusalMaps<C>, Record<TCode, unknown>>[TCode];
};
/** The refusal message any call of the contract can come back with: what a handler for every endpoint at once (a caller's refusalHandler) is handed. */
export type LambderContractAnyRefusalMessage<C> = 0 extends 1 & C ? LambderUncheckedRefusalMessage : string extends keyof C ? LambderUncheckedRefusalMessage : LambderRefusalMessage<LambderContractRefusals<C>>;
export {};

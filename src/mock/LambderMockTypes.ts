/**
 * The types of the mock runtime: what a registry entry is, what a handler
 * receives, how a registry is checked against a contract, and what the
 * subscription emits. Everything a consumer needs at runtime it restates in
 * the builders; these types pin every restatement to the contract type, so
 * the contract stays a type-only import in the consuming app.
 */

import type { z } from "zod";
import type {
    LambderApiMode,
    LambderContractGuardInput,
    LambderContractGuardInputNames,
    LambderContractGuardInputsOf,
    LambderContractGuardNames,
    LambderContractGuardsOf,
    LambderContractIdempotencyOf,
    LambderContractKeysWithMode,
    LambderContractMode,
    LambderContractRateLimitOf,
} from "../shared/wire/LambderApiContract.js";
import type { LambderApiGuard, LambderGuardDataOf, LambderGuardMetaMap } from "../api/LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig, LambderContextRateLimit, LambderContextRateLimitCheck } from "../api/LambderApiRateLimits.js";
import type { LambderApiCallContext } from "../api/LambderApiCallContext.js";
import type { LambderApiRequest } from "../api/LambderApiRequest.js";
import type { LambderHttpStatusCode } from "../shared/wire/LambderHttpStatus.js";
import type { LambderApiDefinition } from "../api/LambderApiDefinition.js";
import type { LambderApiEnvelopeBody } from "../shared/wire/LambderApiContract.js";
import type { LambderAppRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import type LambderSessionController from "../session/LambderSessionController.js";

// ---------------------------------------------------------------------------
// Reading the contract
// ---------------------------------------------------------------------------

export type LambderMockInputOf<C, K extends keyof C> = C[K] extends { input: infer I } ? I : never;
export type LambderMockOutputOf<C, K extends keyof C> = C[K] extends { output: infer O } ? O : never;

// ---------------------------------------------------------------------------
// Option checks
// ---------------------------------------------------------------------------

/**
 * Maps every key an option object carries that its shape does not have to
 * `never`, so a typo is an error on the key itself.
 *
 * Needed once per nesting level: inferring a generic from an object literal
 * (`const G`, `const P` on create()) switches excess-property checking off
 * for the WHOLE literal, so `idempotency: { failOpn: false }` would compile
 * and be dropped. Intersected into a nested position because the type
 * variable must stay naked somewhere for the literal to be inferred at all.
 * `unknown` for a non-object (`idempotency: true`), since mapping Boolean's
 * prototype keys to `never` would refuse the boolean form.
 *
 * Duplicates `LambderNoExtraKeys` (core/LambderCreateOptions.ts) on purpose: importing it
 * would pull the server's type graph (aws-lambda included) into the
 * browser-safe `lambder/mock`.
 */
export type LambderMockSurplusKeys<TOptions, TShape> =
    [TOptions] extends [object] ? Record<Exclude<keyof TOptions, keyof TShape>, never> : unknown;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/**
 * The context every mock guard and mock handler sees beside its own typed
 * fields: the API core's call context plus the request, a session
 * controller for the call, and the caller's abort signal.
 */
export type LambderMockCallContext<S = any> = LambderApiCallContext<S> & {
    apiName: string;
    request: LambderApiRequest;
    /** Create, rotate, refresh and end sessions, exactly as a server handler does through its own ctx.sessionController. */
    sessionController: LambderSessionController<S>;
    /**
     * Charges a named policy from code, as a server handler does through its
     * own ctx.rateLimit: a 429 refusal when it is over. The name is any
     * string and the key optional here; the charge checks both.
     */
    rateLimit: LambderContextRateLimit<Record<string, LambderApiRateLimitPolicyConfig>>;
    /** The same count, answered instead of thrown, as ctx.isRateLimited on the server. */
    isRateLimited: LambderContextRateLimitCheck<Record<string, LambderApiRateLimitPolicyConfig>>;
    signal: AbortSignal;
    /**
     * The envelope fields that travel beside the payload, the mock's stand-in
     * for the server's `res.api(payload, config)`: a mock handler returns its
     * payload, so this is where the rest of the envelope goes. `logList` is
     * the usual channel and lives on the context itself.
     */
    envelope: { message?: string };
};

/** The same, with the session present: what a `session: true` mock guard and a session endpoint's handler see. */
export type LambderMockSessionCallContext<S = any> = Omit<LambderMockCallContext<S>, "session"> & { session: LambderSessionRecord<S> };

/** What a mock handler for endpoint K receives. */
export type LambderMockContext<C, K extends keyof C, S, G> = Omit<LambderMockCallContext<S>, "apiName" | "session" | "guardData"> & {
    apiName: K;
    /** The payload as posted; never optional, the way a validated payload reaches a server handler. */
    payload: LambderMockInputOf<C, K>;
    /** The session on a session endpoint, null on a public one. */
    session: LambderContractMode<C, K> extends "session" ? LambderSessionRecord<S>
        : LambderContractMode<C, K> extends "public" ? null
        : LambderSessionRecord<S> | null;
    /** What the endpoint's guards returned, keyed by name, typed from the mock guard map and the endpoint's declaration. */
    guardData: LambderGuardDataOf<LambderGuardMetaMap<G>, LambderContractGuardsOf<C, K>>;
    /** The guard inputs the caller sent, typed by the contract; undefined for an endpoint that declares none. */
    guardInputs: [LambderContractGuardInputsOf<C, K>] extends [never] ? undefined : LambderContractGuardInputsOf<C, K>;
    /** The key the caller sent, when it sent a string; anything else is not a key and reaches a handler as undefined, having already been refused wherever it mattered. */
    idempotencyKey: string | undefined;
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * The guard map a mock app must declare: one guard per name any endpoint of
 * the contract declares, plus, for each guardInput-mode guard, a `guardInput`
 * schema whose input is what the contract says a client sends. A guard a
 * public endpoint names may not require a session. A missing name, a schema
 * that parses to something else, or such a session guard fails at the
 * `guards` option.
 */
export type LambderMockGuards<C, S = any> =
    // Pinned to the mock call contexts: a guard built with the server's
    // lambderGuard() reads ctx.ip, ctx.method and ctx.path, which a mock call
    // context lacks, so it is rejected here rather than silently authorizing
    // everything.
    { [N in LambderContractGuardNames<C>]: LambderApiGuard<any, any, any, LambderMockCallContext<S>, LambderMockSessionCallContext<S>> }
    & { [N in LambderContractGuardInputNames<C>]: { guardInput: z.ZodType<unknown, LambderContractGuardInput<C, N>> } }
    & { [N in LambderContractGuardNames<C, "public">]: { session?: false } };

// ---------------------------------------------------------------------------
// Entries, slices and the registry
// ---------------------------------------------------------------------------

export type LambderMockHandler<C, K extends keyof C, S, G> =
    (ctx: LambderMockContext<C, K, S, G>) => LambderMockOutputOf<C, K> | Promise<LambderMockOutputOf<C, K>>;

/**
 * The guards field of an entry: required whenever the contract declares any
 * guard for the endpoint, and type-equal to the server's own declaration.
 * The restatement is what tells the runtime which guards to run, so a guard
 * left out would let the mock answer 200 where the server answers
 * notAuthorized. Keyed on the guards rather than on guardInputs, since the
 * guards without a guardInput are the "may this role call it" ones.
 */
type LambderMockGuardsField<C, K extends keyof C> =
    [LambderContractGuardsOf<C, K>] extends [never]
        ? { guards?: never }
        : { guards: LambderContractGuardsOf<C, K> };

/**
 * The rate-limit field of an entry: required whenever the contract declares
 * one, absent otherwise. As with LambderMockGuardsField, the restatement is
 * the only thing that tells the runtime to apply the limit, so an entry that
 * left it out would answer 200 where the server answers 429.
 */
type LambderMockRateLimitField<C, K extends keyof C> =
    [LambderContractRateLimitOf<C, K>] extends [never]
        ? { rateLimit?: never }
        : { rateLimit: LambderContractRateLimitOf<C, K> };

/**
 * The idempotency field of an entry: required whenever the contract declares
 * one. An entry that leaves it out takes no claim and stores no record, so a
 * retry re-runs the handler and the mock answers 200 where the server answers
 * a replay or a 409.
 */
type LambderMockIdempotencyField<C, K extends keyof C> =
    [LambderContractIdempotencyOf<C, K>] extends [never]
        ? { idempotency?: never }
        : { idempotency: LambderContractIdempotencyOf<C, K> };

/**
 * What override() hands back: call restore() to put the original handler
 * back.
 *
 * Deliberately no `[Symbol.dispose]` for `using`: it is declared only in
 * `lib: ESNext`, so a consumer on `lib: ES2022` with skipLibCheck off would
 * get TS2550 from the published .d.ts just by importing the entry. A scoped
 * override is a try/finally, which needs no lib.
 */
export type LambderMockOverride = {
    restore(): void;
};

/**
 * What an entry's `input` schema must take and give: it takes exactly the
 * endpoint's contract input (the form a client posts), in both directions,
 * and what it parses to still reads as that input, which is how the mock's
 * handler is typed. `z.ZodType<Input>` alone is covariant, so a schema
 * taking a SUBTYPE (an extra required field, a literal where the contract
 * says string) would pass, and the mock would then answer 422 to payloads
 * the server accepts. A default passes (the parsed field is simply there);
 * a transform that changes a field's type does not, since the handler would
 * read it as the posted type.
 *
 * Intersected onto the schema rather than mapped to `never`, so the compiler
 * quotes the reason at the `input` property. `z.any()` passes both ways as
 * the one deliberate escape hatch; `z.unknown()` does not.
 */
type LambderMockInputPin<C, K extends keyof C, TSchema extends z.ZodType> =
    [z.input<TSchema>] extends [LambderMockInputOf<C, K>]
        ? ([LambderMockInputOf<C, K>] extends [z.input<TSchema>]
            ? ([z.output<TSchema>] extends [LambderMockInputOf<C, K>]
                ? unknown
                : { "LambderMockApp: this input schema transforms the payload into a type the mock handler is not typed for (it reads the payload as the endpoint's contract input)": LambderMockInputOf<C, K> })
            : { "LambderMockApp: this input schema takes less than the endpoint takes (an extra required field, or a narrower type), so the mock would answer 422 to payloads the server accepts": LambderMockInputOf<C, K> })
        : { "LambderMockApp: this input schema takes something else than the endpoint's contract input": LambderMockInputOf<C, K> };

/** An entry written in full: the declarations restated and pinned, plus the handler. */
export type LambderMockEntryOptions<C, K extends keyof C, S, G, TInputSchema extends z.ZodType = z.ZodType> =
    LambderMockGuardsField<C, K> & LambderMockRateLimitField<C, K> & LambderMockIdempotencyField<C, K> & {
    /**
     * A schema to validate the posted payload against, so the mock answers
     * 422 exactly as the server would. Optional, and the mock's own: the
     * contract is type-only, and importing the server's schemas would put the
     * whole endpoint surface into the browser bundle. Restate it for endpoints
     * whose rejection path a test exercises; without it a bad payload reaches
     * the handler. What it parses to is pinned to the contract's input (see
     * LambderMockInputPin).
     */
    input?: TInputSchema & LambderMockInputPin<C, K, TInputSchema>;
    handler: LambderMockHandler<C, K, S, G>;
};

/**
 * What publicApi/sessionApi accept: a bare handler only for an endpoint the
 * contract declares nothing for, the full options otherwise, so the form that
 * cannot carry a restatement is unavailable exactly where one is owed. Keyed
 * on all three declarations: keyed on guards alone, a guardless endpoint
 * could drop its rate limit and idempotency through the bare form.
 */
export type LambderMockEntryInput<C, K extends keyof C, S, G, TInputSchema extends z.ZodType = z.ZodType> =
    [LambderContractGuardsOf<C, K> | LambderContractRateLimitOf<C, K> | LambderContractIdempotencyOf<C, K>] extends [never]
        ? LambderMockHandler<C, K, S, G> | LambderMockEntryOptions<C, K, S, G, TInputSchema>
        : LambderMockEntryOptions<C, K, S, G, TInputSchema>;

/** One registry entry: the endpoint's definition as the pipeline runs it, and its handler (null when registered as not mocked). */
export type LambderMockEntry<C, K extends keyof C & string> = {
    readonly name: K;
    readonly mode: LambderApiMode;
    readonly definition: LambderApiDefinition;
    readonly handler: ((ctx: any) => Promise<unknown>) | null;
    readonly notMockedReason: string | null;
};

/** The endpoint names a mock app may register under each mode. */
export type LambderMockPublicNames<C> = LambderContractKeysWithMode<C, "public">;
export type LambderMockSessionNames<C> = LambderContractKeysWithMode<C, "session">;

/** A slice: the entries of one module, keyed by endpoint name. */
export type LambderMockSlice<C, K extends keyof C & string> = { readonly [P in K]: LambderMockEntry<C, P> };

/**
 * What restNotMocked(reason) hands register(): "every endpoint the slices
 * beside me leave out is not mocked, for this reason". A one-field object
 * rather than a slice, because it names no endpoint; every check below
 * filters it out before reading names, so it changes only completeness.
 */
export type LambderMockRestEntry = {
    readonly restNotMockedReason: string;
};

/**
 * The names one slice holds; distributes over a union of slices.
 *
 * A slice typed with an index signature (`Record<string, LambderMockEntry>`,
 * a list built in a loop) has `string` as its key type, which would pass the
 * completeness check while registering almost nothing, so it contributes
 * nothing here and LambderMockUncheckableSlices reports it. The rest entry
 * contributes nothing either: its one key is not an endpoint name, and
 * reading it would report "restNotMockedReason" as a stray or a duplicate.
 */
type LambderMockSliceNames<S> = S extends unknown
    ? (S extends LambderMockRestEntry ? never : (string extends keyof S ? never : keyof S & string))
    : never;

/**
 * Slices whose key set is an index signature rather than a finite list of
 * names. Walks the tuple rather than distributing over `Slices[number]`,
 * because the union loses which element held the index signature and the
 * error should name it; LambderMockUncountableSlices rejects the lists this
 * walk cannot cover.
 */
type LambderMockUncheckableSlices<Slices extends readonly unknown[]> =
    Slices extends readonly [infer Head, ...infer Tail]
        ? (string extends keyof Head ? Head : never) | LambderMockUncheckableSlices<Tail>
        : never;

/** Endpoints of the contract no slice covers. */
export type LambderMockMissingNames<C, Slices extends readonly unknown[]> =
    Exclude<keyof C & string, LambderMockSliceNames<Slices[number]>>;

/** True when one of register()'s arguments is the rest entry. */
type LambderMockHasRestEntry<Slices extends readonly unknown[]> =
    [Extract<Slices[number], LambderMockRestEntry>] extends [never] ? false : true;

/**
 * The endpoints register() would leave unanswered: the ones no slice covers,
 * unless a rest entry stands for them.
 *
 * Separate from LambderMockMissingNames, because an endpoint the rest entry
 * answers still has no mock of its own; the rest entry only changes whether
 * leaving it out is a mistake.
 */
type LambderMockUncoveredNames<C, Slices extends readonly unknown[]> =
    LambderMockHasRestEntry<Slices> extends true ? never : LambderMockMissingNames<C, Slices>;

/** Names the slices carry that the contract does not declare. */
export type LambderMockStrayNames<C, Slices extends readonly unknown[]> =
    Exclude<LambderMockSliceNames<Slices[number]>, keyof C & string>;

/** Endpoints covered by more than one slice. */
export type LambderMockDuplicateNames<Slices extends readonly unknown[]> =
    Slices extends readonly [infer Head, ...infer Tail]
        ? (LambderMockSliceNames<Head> & LambderMockSliceNames<Tail[number]>) | LambderMockDuplicateNames<Tail>
        : never;

/**
 * True for a slice list whose length the compiler does not know: an array
 * type rather than a tuple. Every check here walks a tuple, and an array
 * type quietly disables them all (completeness reduces to "the element type
 * mentions these names"), so the array form, such as a spread
 * `const slices = [userMocks, orderMocks]`, is refused.
 */
type LambderMockUncountableSlices<Slices extends readonly unknown[]> = number extends Slices["length"] ? true : false;

/**
 * What register() intersects its slices with: nothing when they cover the
 * contract exactly once each, otherwise a shape naming what is wrong, which
 * no slice list is assignable to. The key of that shape is the compiler's
 * error message.
 */
export type LambderMockRegistryCheck<C, Slices extends readonly unknown[]> =
    LambderMockUncountableSlices<Slices> extends true
        ? { "LambderMockApp: register() was given an array of slices rather than a fixed list, so it cannot see how many there are and cannot check the contract is covered. Pass the slices as arguments, register(a, b, c), or declare the list with `as const` before spreading it": Slices }
        : [LambderMockUncheckableSlices<Slices>] extends [never]
            ? ([LambderMockStrayNames<C, Slices>] extends [never]
                ? ([LambderMockUncoveredNames<C, Slices>] extends [never]
                    ? ([LambderMockDuplicateNames<Slices>] extends [never]
                        ? unknown
                        : { "LambderMockApp: these endpoints are mocked in more than one slice": LambderMockDuplicateNames<Slices> })
                    : { "LambderMockApp: these endpoints have no mock (add one, mockApp.notMocked with a reason, or mockApp.restNotMocked(reason) for everything left out)": LambderMockUncoveredNames<C, Slices> })
                : { "LambderMockApp: these names are not endpoints of the contract": LambderMockStrayNames<C, Slices> })
            : { "LambderMockApp: a slice is typed with an index signature, so register() cannot see which endpoints it covers. Build it with mockApp.apiSlice(...) or annotate it as LambderMockSlice": LambderMockUncheckableSlices<Slices> };

// ---------------------------------------------------------------------------
// Control surface and observation
// ---------------------------------------------------------------------------

/** A latency setting: milliseconds, a range to draw from, or a function of the api name. */
export type LambderMockLatency = number | { min: number; max: number } | ((apiName: string) => number);

/**
 * An injected failure. Each is rendered by the same function the pipeline
 * uses for the real thing, so an injected 429 carries the Retry-After a
 * real one does. `network` rejects the transport; `timeout` waits for the
 * caller's own abort (a call with no timeout configured waits for its
 * external signal, or for ever, which is what a timeout is).
 */
export type LambderMockFailure =
    | { reason: "network" }
    | { reason: "timeout" }
    | { reason: "server" }
    | { reason: "refusal"; message?: LambderAppRefusalMessage | string; statusCode?: LambderHttpStatusCode }
    | { reason: "notAuthorized"; message?: LambderAppRefusalMessage | string }
    | { reason: "sessionExpired" }
    | { reason: "versionExpired" }
    | { reason: "rateLimited"; retryAfterSeconds?: number; message?: LambderAppRefusalMessage };

/** Every sibling in the package spells this `reason`: an outcome's, a transport failure's, an invoke failure's. */
export type LambderMockFailureReason = LambderMockFailure["reason"];

/**
 * How one call ended, as the runtime saw it. `passthrough` is the MSW
 * adapter's: the runtime answered nothing and the request went on to MSW's
 * other handlers and the network.
 */
export type LambderMockOutcome =
    | "ok" | "refusal" | "notAuthorized" | "sessionExpired" | "versionExpired"
    | "rateLimited" | "replayed" | "validation" | "notMocked" | "unknownApi" | "crash" | "injected" | "passthrough";

export type LambderMockRequestEvent = {
    phase: "request";
    id: number;
    apiName: string;
    /** The endpoint's mode from the registry; null for a name the registry does not know. */
    mode: LambderApiMode | null;
    payload: unknown;
    guardInputs: Record<string, unknown> | undefined;
    /** Exactly as posted, so `unknown`: the key is client data and only the idempotency engine judges it. */
    idempotencyKey: unknown;
    version: string | null;
    /** The signature the caller sent for the endpoint; null when it carries no map. */
    signature: string | null;
    headers: Record<string, string>;
    /** True when the request carried a session cookie. */
    hasSessionCookie: boolean;
    at: number;
};

export type LambderMockResponseEvent = {
    phase: "response";
    id: number;
    apiName: string;
    mode: LambderApiMode | null;
    durationMs: number;
    /** Absent when the transport rejected (an injected network failure or timeout), and on a passthrough. */
    statusCode: number | null;
    /**
     * The answer's headers, with every Set-Cookie value replaced by
     * "[redacted]": the cookie's name and attributes still read (did this
     * call start a session, did it clear one), while the session token they
     * carry stays out of a log a dev panel renders and a test snapshots.
     */
    headers: Record<string, string[]>;
    /** The parsed envelope, when the answer was one. */
    envelope: LambderApiEnvelopeBody<unknown> | null;
    outcome: LambderMockOutcome;
    guardsRun: string[];
    /** The crash, or the injected transport failure. */
    error?: Error;
    at: number;
};

export type LambderMockCallEvent = LambderMockRequestEvent | LambderMockResponseEvent;

/** One completed call, for assertions and panels: the response event plus what was asked. */
export type LambderMockCallRecord = LambderMockResponseEvent & {
    payload: unknown;
    guardInputs: Record<string, unknown> | undefined;
};

export type LambderMockListener = (event: LambderMockCallEvent) => void;

/**
 * The mock's rate-limit policies, keyed by name. Bound to the mock's own call
 * context so a custom key handler is typed for the runtime that will actually
 * call it: a handler built with the server's lambderRateLimitKey() reads the
 * render context's ip/method/path, none of which the mock context has, so it
 * would compile here and then key every caller identically. Build these with
 * `rateLimitKey` from initLambderMock().
 */
export type LambderMockRateLimitPolicies<S = any> = Record<string, LambderApiRateLimitPolicyConfig<LambderMockCallContext<S>>>;

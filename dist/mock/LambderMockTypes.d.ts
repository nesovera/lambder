/**
 * The types of the mock runtime: what a registry entry is, what a handler
 * receives, how a registry is checked against a contract, and what the
 * subscription emits. Everything a consumer needs at runtime it restates in
 * the builders; these types pin every restatement to the contract type, so
 * the contract stays a type-only import in the consuming app.
 */
import type { z } from "zod";
import type { LambderApiMode, LambderContractGuardInput, LambderContractGuardInputNames, LambderContractGuardInputsOf, LambderContractGuardNames, LambderContractGuardsOf, LambderContractIdempotencyOf, LambderContractKeysWithMode, LambderContractMode, LambderContractRateLimitOf } from "../shared/wire/LambderApiContract.js";
import type { LambderApiGuard, LambderGuardDataOf, LambderGuardMetaMap } from "../api/LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig } from "../api/LambderApiRateLimits.js";
import type { LambderApiCallContext } from "../api/LambderApiCallContext.js";
import type { LambderApiRequest } from "../api/LambderApiRequest.js";
import type { LambderHttpStatusCode } from "../shared/wire/LambderHttpStatus.js";
import type { LambderApiDefinition } from "../api/LambderApiDefinition.js";
import type { LambderApiEnvelopeBody } from "../shared/wire/LambderApiContract.js";
import type { LambderAppRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import type LambderSessionController from "../session/LambderSessionController.js";
export type LambderMockInputOf<C, K extends keyof C> = C[K] extends {
    input: infer I;
} ? I : never;
export type LambderMockOutputOf<C, K extends keyof C> = C[K] extends {
    output: infer O;
} ? O : never;
/**
 * Maps every key an option object carries that its shape does not have to
 * `never`, so a typo is an error on the key itself.
 *
 * Needed once per nesting level: inferring a generic from an object literal
 * (`const G`, `const P` on create()) switches excess-property checking off for
 * the WHOLE literal, nested objects included, so `idempotency: { failOpn:
 * false }` compiled, was dropped in silence, and left the runtime on the
 * default. Intersected into a nested position rather than applied to the
 * option type as a whole, because the type variable has to stay naked
 * somewhere for the literal to be inferred from at all.
 *
 * `unknown` for anything that is not an object (`idempotency: true`), which
 * intersects away: `keyof boolean` is Boolean's own prototype members, and
 * mapping those to `never` would refuse the boolean form outright.
 *
 * The server's create() has the same construction in `LambderNoExtraKeys`
 * (core/Lambder.ts). It is written twice on purpose: `lambder/mock` is
 * browser-safe by its import graph, and reaching into core/ for a type alias
 * would pull the server's whole type graph (aws-lambda included) back into it.
 */
export type LambderMockSurplusKeys<TOptions, TShape> = [
    TOptions
] extends [object] ? Record<Exclude<keyof TOptions, keyof TShape>, never> : unknown;
/**
 * The context every mock guard and mock handler sees beside its own typed
 * fields: the API core's call context plus the request, a session
 * controller for the call, and the caller's abort signal.
 */
export type LambderMockCallContext<S = any> = LambderApiCallContext<S> & {
    apiName: string;
    request: LambderApiRequest;
    /** Create, rotate, refresh and end sessions, exactly as a server handler does through getSessionController(ctx). */
    sessions: LambderSessionController<S>;
    signal: AbortSignal;
    /**
     * The envelope fields that travel beside the payload, the mock's stand-in
     * for the server's `res.api(payload, config)`: a mock handler returns its
     * payload, so this is where the rest of the envelope goes. `logList` is
     * the usual channel and lives on the context itself.
     */
    envelope: {
        message?: string;
    };
};
/** The same, with the session present: what a `session: true` mock guard and a session endpoint's handler see. */
export type LambderMockSessionCallContext<S = any> = Omit<LambderMockCallContext<S>, "session"> & {
    session: LambderSessionRecord<S>;
};
/** What a mock handler for endpoint K receives. */
export type LambderMockContext<C, K extends keyof C, S, G> = Omit<LambderMockCallContext<S>, "apiName" | "session" | "guardData"> & {
    apiName: K;
    /** The payload as posted; never optional, the way a validated payload reaches a server handler. */
    payload: LambderMockInputOf<C, K>;
    /** The session on a session endpoint, null on a public one. */
    session: LambderContractMode<C, K> extends "session" ? LambderSessionRecord<S> : LambderContractMode<C, K> extends "public" ? null : LambderSessionRecord<S> | null;
    /** What the endpoint's guards returned, keyed by name, typed from the mock guard map and the endpoint's declaration. */
    guardData: LambderGuardDataOf<LambderGuardMetaMap<G>, LambderContractGuardsOf<C, K>>;
    /** The guard inputs the caller sent, typed by the contract; undefined for an endpoint that declares none. */
    guardInputs: [LambderContractGuardInputsOf<C, K>] extends [never] ? undefined : LambderContractGuardInputsOf<C, K>;
    /** The key the caller sent, when it sent a string; anything else is not a key and reaches a handler as undefined, having already been refused wherever it mattered. */
    idempotencyKey: string | undefined;
};
/**
 * The guard map a mock app must declare: one guard per name any endpoint of
 * the contract declares, and for every guard the contract knows in
 * guardInput mode, a `guardInput` schema whose output is what the server
 * inferred. A missing name or a schema that parses to something else fails
 * at the `guards` option.
 */
export type LambderMockGuards<C, S = any> = {
    [N in LambderContractGuardNames<C>]: LambderApiGuard<any, any, any, LambderMockCallContext<S>, LambderMockSessionCallContext<S>>;
} & {
    [N in LambderContractGuardInputNames<C>]: {
        guardInput: z.ZodType<LambderContractGuardInput<C, N>, any>;
    };
};
export type LambderMockHandler<C, K extends keyof C, S, G> = (ctx: LambderMockContext<C, K, S, G>) => LambderMockOutputOf<C, K> | Promise<LambderMockOutputOf<C, K>>;
/**
 * The guards field of an entry: required whenever the contract declares any
 * guard for the endpoint, and type-equal to the server's own declaration.
 *
 * Keyed on the guards themselves rather than on guardInputs, because the
 * restatement is the only thing that tells the runtime which guards to run:
 * a guard the entry leaves out simply does not run, and the mock answers 200
 * where the server answers notAuthorized. The guards that carry no
 * guardInput are exactly the "may this role call it" ones (session-only,
 * param-only), so keying on guardInputs made the authorization checks the
 * droppable half.
 */
type LambderMockGuardsField<C, K extends keyof C> = [
    LambderContractGuardsOf<C, K>
] extends [never] ? {
    guards?: never;
} : {
    guards: LambderContractGuardsOf<C, K>;
};
/**
 * The rate-limit field of an entry: required whenever the contract declares
 * one, absent otherwise. Same reasoning as LambderMockGuardsField, and the
 * argument transfers word for word: the restatement is the only thing that
 * tells the runtime to apply the limit, so an entry that leaves it out
 * answers 200 where the server answers 429.
 */
type LambderMockRateLimitField<C, K extends keyof C> = [
    LambderContractRateLimitOf<C, K>
] extends [never] ? {
    rateLimit?: never;
} : {
    rateLimit: LambderContractRateLimitOf<C, K>;
};
/**
 * The idempotency field of an entry: required whenever the contract declares
 * one. An entry that leaves it out takes no claim and stores no record, so a
 * retry re-runs the handler and the mock answers 200 where the server answers
 * a replay or a 409.
 */
type LambderMockIdempotencyField<C, K extends keyof C> = [
    LambderContractIdempotencyOf<C, K>
] extends [never] ? {
    idempotency?: never;
} : {
    idempotency: LambderContractIdempotencyOf<C, K>;
};
/**
 * What override() hands back: call restore() to put the original handler
 * back.
 *
 * Restore and nothing else. The handle also carried a `[Symbol.dispose]`
 * member, for `using`, and that member is declared in `lib: ESNext` alone: a
 * consumer on `lib: ES2022` (a Vue app's own setting, and the only consumer
 * this package has) got TS2550 "Property 'dispose' does not exist on type
 * 'SymbolConstructor'" out of the published .d.ts, from importing the entry at
 * all, whenever skipLibCheck was off. A scoped override is a try/finally,
 * which needs no lib.
 */
export type LambderMockOverride = {
    restore(): void;
};
/**
 * What an entry's `input` schema must parse to: the endpoint's contract
 * input, in both directions.
 *
 * One direction is not enough, and the missing one is the direction the drift
 * actually travels in. `z.ZodType<Input>` is covariant in its output, so a
 * schema parsing to a SUBTYPE of the contract input passed: an extra required
 * field, or a literal where the contract says string. Such a schema refuses
 * payloads the server accepts, and the mock then answers 422 to a call that
 * works against the real backend, which is the exact failure the schema was
 * added to reproduce, produced by the thing added to reproduce it. Requiring
 * assignability the other way as well makes the schema's output the contract's
 * input and nothing else.
 *
 * Intersected onto the schema rather than mapped to `never`, so the compiler
 * quotes the reason at the `input` property. `z.any()` passes in both
 * directions, which is the one deliberate escape hatch; `z.unknown()` does
 * not.
 */
type LambderMockInputPin<C, K extends keyof C, TSchema extends z.ZodType> = [
    z.output<TSchema>
] extends [LambderMockInputOf<C, K>] ? ([LambderMockInputOf<C, K>] extends [z.output<TSchema>] ? unknown : {
    "LambderMockApp: this input schema parses to less than the endpoint takes (an extra required field, or a narrower type), so the mock would answer 422 to payloads the server accepts": LambderMockInputOf<C, K>;
}) : {
    "LambderMockApp: this input schema parses to something else than the endpoint's contract input": LambderMockInputOf<C, K>;
};
/** An entry written in full: the declarations restated and pinned, plus the handler. */
export type LambderMockEntryOptions<C, K extends keyof C, S, G, TInputSchema extends z.ZodType = z.ZodType> = LambderMockGuardsField<C, K> & LambderMockRateLimitField<C, K> & LambderMockIdempotencyField<C, K> & {
    /**
     * A schema to validate the posted payload against, which makes the mock
     * answer 422 exactly as the server would. Optional, and deliberately the
     * mock's own: the contract is a type, so the server's schemas do not exist
     * at runtime on this side, and importing them would put the whole endpoint
     * surface into the browser bundle. Restate the shape for the endpoints
     * whose rejection path a test needs to exercise; leave it off and a bad
     * payload reaches the handler, as it does today.
     *
     * Pinned to the contract's input all the same: the schema is the mock's,
     * but what it parses to is the server's, in both directions (see
     * LambderMockInputPin).
     */
    input?: TInputSchema & LambderMockInputPin<C, K, TInputSchema>;
    handler: LambderMockHandler<C, K, S, G>;
};
/**
 * What publicApi/sessionApi accept: a bare handler only for an endpoint the
 * contract declares nothing for, the full options otherwise, so the form that
 * cannot carry a restatement is unavailable exactly where one is owed.
 *
 * All three declarations, not guards alone. The three fields above make each
 * restatement required INSIDE the options form, and the bare handler is the
 * form that has no fields at all, so keying this on guards left every
 * guardless endpoint free to drop its rate limit and its idempotency again:
 * the handler ran twice for one key and a perMin limit never answered 429,
 * which is the whole of what those two fields exist to prevent.
 */
export type LambderMockEntryInput<C, K extends keyof C, S, G, TInputSchema extends z.ZodType = z.ZodType> = [
    LambderContractGuardsOf<C, K> | LambderContractRateLimitOf<C, K> | LambderContractIdempotencyOf<C, K>
] extends [never] ? LambderMockHandler<C, K, S, G> | LambderMockEntryOptions<C, K, S, G, TInputSchema> : LambderMockEntryOptions<C, K, S, G, TInputSchema>;
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
export type LambderMockSlice<C, K extends keyof C & string> = {
    readonly [P in K]: LambderMockEntry<C, P>;
};
/**
 * What restNotMocked(reason) hands register(): "every endpoint the slices
 * beside me leave out is not mocked, for this reason".
 *
 * A one-field object rather than a slice, because it names no endpoint: it
 * answers the names nothing else claimed, and which those are is only known
 * once the other arguments have been read. Every check below filters it out
 * before it reads a name, so the field it does carry is neither a stray nor
 * half of a duplicate; the one clause it changes is completeness.
 */
export type LambderMockRestEntry = {
    readonly restNotMockedReason: string;
};
/**
 * The names one slice holds; distributes over a union of slices.
 *
 * A slice typed with an index signature (`Record<string, LambderMockEntry>`,
 * or a list built in a loop) holds `string` as its key type, which would
 * subtract every name from the missing list and pass the completeness check
 * while registering almost nothing. Such a slice names nothing the compiler
 * can check, so it contributes nothing here and LambderMockUncheckableSlices
 * reports it for what it is.
 *
 * The rest entry contributes nothing either, and for the opposite reason: the
 * one key it carries is not an endpoint name, so reading it would report
 * "restNotMockedReason" as a stray, and two rest entries as a duplicate of it.
 */
type LambderMockSliceNames<S> = S extends unknown ? (S extends LambderMockRestEntry ? never : (string extends keyof S ? never : keyof S & string)) : never;
/**
 * Slices whose key set is an index signature rather than a finite list of
 * names. Walks the tuple rather than distributing over `Slices[number]`,
 * because the union loses which element held the index signature and the
 * error should name it; LambderMockUncountableSlices rejects the lists this
 * walk cannot cover.
 */
type LambderMockUncheckableSlices<Slices extends readonly unknown[]> = Slices extends readonly [infer Head, ...infer Tail] ? (string extends keyof Head ? Head : never) | LambderMockUncheckableSlices<Tail> : never;
/** Endpoints of the contract no slice covers. */
export type LambderMockMissingNames<C, Slices extends readonly unknown[]> = Exclude<keyof C & string, LambderMockSliceNames<Slices[number]>>;
/** True when one of register()'s arguments is the rest entry. */
type LambderMockHasRestEntry<Slices extends readonly unknown[]> = [
    Extract<Slices[number], LambderMockRestEntry>
] extends [never] ? false : true;
/**
 * The endpoints register() would leave unanswered: the ones no slice covers,
 * unless a rest entry stands for them.
 *
 * The completeness clause and nothing else. An endpoint the rest entry answers
 * is still an endpoint with no mock of its own, which is what
 * LambderMockMissingNames says and why that one keeps its meaning; what the
 * rest entry changes is whether leaving it out is a mistake.
 */
type LambderMockUncoveredNames<C, Slices extends readonly unknown[]> = LambderMockHasRestEntry<Slices> extends true ? never : LambderMockMissingNames<C, Slices>;
/** Names the slices carry that the contract does not declare. */
export type LambderMockStrayNames<C, Slices extends readonly unknown[]> = Exclude<LambderMockSliceNames<Slices[number]>, keyof C & string>;
/** Endpoints covered by more than one slice. */
export type LambderMockDuplicateNames<Slices extends readonly unknown[]> = Slices extends readonly [infer Head, ...infer Tail] ? (LambderMockSliceNames<Head> & LambderMockSliceNames<Tail[number]>) | LambderMockDuplicateNames<Tail> : never;
/**
 * True for a slice list whose length the compiler does not know: an array
 * type rather than a tuple, `length: number`.
 *
 * Every check below is written over a tuple, and an array type quietly
 * disables all of them: the overlap and index-signature walks fall to their
 * `never` base case on the first step, and completeness reduces to "the
 * element type mentions these names", which one element satisfies as well as
 * twenty. `const slices = [userMocks, orderMocks]` spread into register() is
 * exactly that type, so the array form is refused rather than passed.
 */
type LambderMockUncountableSlices<Slices extends readonly unknown[]> = number extends Slices["length"] ? true : false;
/**
 * What register() intersects its slices with: nothing when they cover the
 * contract exactly once each, otherwise a shape naming what is wrong, which
 * no slice list is assignable to. The key of that shape is the compiler's
 * error message.
 */
export type LambderMockRegistryCheck<C, Slices extends readonly unknown[]> = LambderMockUncountableSlices<Slices> extends true ? {
    "LambderMockApp: register() was given an array of slices rather than a fixed list, so it cannot see how many there are and cannot check the contract is covered. Pass the slices as arguments, register(a, b, c), or declare the list with `as const` before spreading it": Slices;
} : [LambderMockUncheckableSlices<Slices>] extends [never] ? ([LambderMockStrayNames<C, Slices>] extends [never] ? ([LambderMockUncoveredNames<C, Slices>] extends [never] ? ([LambderMockDuplicateNames<Slices>] extends [never] ? unknown : {
    "LambderMockApp: these endpoints are mocked in more than one slice": LambderMockDuplicateNames<Slices>;
}) : {
    "LambderMockApp: these endpoints have no mock (add one, mockApp.notMocked with a reason, or mockApp.restNotMocked(reason) for everything left out)": LambderMockUncoveredNames<C, Slices>;
}) : {
    "LambderMockApp: these names are not endpoints of the contract": LambderMockStrayNames<C, Slices>;
}) : {
    "LambderMockApp: a slice is typed with an index signature, so register() cannot see which endpoints it covers. Build it with mockApp.apiSlice(...) or annotate it as LambderMockSlice": LambderMockUncheckableSlices<Slices>;
};
/** A latency setting: milliseconds, a range to draw from, or a function of the api name. */
export type LambderMockLatency = number | {
    min: number;
    max: number;
} | ((apiName: string) => number);
/**
 * An injected failure. Each is rendered by the same function the pipeline
 * uses for the real thing, so an injected 429 carries the Retry-After a
 * real one does. `network` rejects the transport; `timeout` waits for the
 * caller's own abort (a call with no timeout configured waits for its
 * external signal, or for ever, which is what a timeout is).
 */
export type LambderMockFailure = {
    reason: "network";
} | {
    reason: "timeout";
} | {
    reason: "server";
} | {
    reason: "refusal";
    message?: LambderAppRefusalMessage | string;
    statusCode?: LambderHttpStatusCode;
} | {
    reason: "notAuthorized";
    message?: LambderAppRefusalMessage | string;
} | {
    reason: "sessionExpired";
} | {
    reason: "versionExpired";
} | {
    reason: "rateLimited";
    retryAfterSeconds?: number;
    message?: LambderAppRefusalMessage;
};
/** Every sibling in the package spells this `reason`: an outcome's, a transport failure's, an invoke failure's. */
export type LambderMockFailureReason = LambderMockFailure["reason"];
/**
 * How one call ended, as the runtime saw it. `passthrough` is the MSW
 * adapter's: the runtime answered nothing and the request went on to MSW's
 * other handlers and the network.
 */
export type LambderMockOutcome = "ok" | "refusal" | "notAuthorized" | "sessionExpired" | "versionExpired" | "rateLimited" | "replayed" | "validation" | "notMocked" | "unknownApi" | "crash" | "injected" | "passthrough";
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
export {};

import type { LambderNonEmptyOptionMap } from "../shared/util/LambderTypeUtilities.js";
import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext, LambderApiCallTrace } from "./LambderApiCallContext.js";
import { parsePreflightSlice } from "./LambderApiValidationRefusal.js";
import type { LambderApiMode, LambderGuardNamesIn } from "../shared/wire/LambderApiContract.js";
import type { LambderDeclaredRefuse } from "../shared/wire/LambderApiRefusal.js";
import { assertRefusalCodesDeclared, type LambderHandlerRefusalsOf, type LambderRefusalDeclaration } from "./LambderApiRefusals.js";
import type { LambderGuardsOptionValue } from "../shared/wire/LambderApiOptionValues.js";
import { LAMBDER_RESPONSE_BRAND, isLambderResponseLike } from "../shared/util/LambderResponseBrand.js";

/**
 * What lambderGuard() returns for a handler that answers instead of
 * authorizing. Nothing accepts it, so the guards map is where the mistake
 * surfaces, named.
 */
type LambderGuardMustNotAnswer = {
    readonly "lambder: a guard authorizes, it does not answer. Say no with refuse() or by throwing a LambderApiRefusal.": never;
};

/**
 * Intersected into the builder's parameter so the mistake is reported at the
 * lambderGuard() call, not later where the guard is put into a map. For an
 * answering handler this is a required property no object literal can
 * satisfy, and the property name is the message.
 */
type LambderGuardAnswerCheck<TOutput> =
    // A guard that only ever throws returns never, and a naked never
    // distributes to never rather than picking a branch. `any` satisfies both
    // branches and would union the error in beside the guard; a handler typed
    // `any` has opted out of the check (the engine still throws at runtime).
    [TOutput] extends [never] ? unknown
        : 0 extends 1 & TOutput ? unknown
            // Extract rather than a bare `extends`: a naked conditional
            // distributes over a union, so for a handler that answers only
            // sometimes (LambderResponse | undefined) the undefined arm would
            // pick the harmless branch and the check would collapse to
            // `unknown`. That is the shape a real guard takes ("return a
            // response to deny, otherwise fall through").
            : [Extract<TOutput, { readonly [LAMBDER_RESPONSE_BRAND]: unknown }>] extends [never] ? unknown
                : LambderGuardMustNotAnswer;

/**
 * A built guard, unless its handler answers instead of authorizing. Applied
 * to the builder's RESULT rather than its parameters, so the handler's
 * unannotated arguments keep their types from the matching overload. A guard
 * that returns a response denies nothing at runtime (the value becomes
 * ctx.guardData[name] and the call carries on), so this makes the ordinary
 * spelling of that mistake a build error; the engine throws on the ones a
 * cast smuggles past. Defined via LambderGuardAnswerCheck so there is one
 * rule for what counts as answering.
 */
type LambderGuardOf<TOutput, TGuard> =
    LambderGuardAnswerCheck<TOutput> extends LambderGuardMustNotAnswer ? LambderGuardMustNotAnswer : TGuard;

/** One guard handler: the adapter's context, the validated input slice (undefined in the no-input mode), and the per-API parameter. */
type LambderGuardHandler<TCtx, TPayload, TParam, TOutput> =
    (ctx: TCtx, payload: TPayload, param: TParam) => TOutput | Promise<TOutput>;

// When a guard runs is part of what the generated options module records of
// it, so the vocabulary is declared with the entries and read from there.
import type { LambderGuardRunAt } from "../shared/wire/LambderApiOptionEntries.js";
export type { LambderGuardRunAt };

/** Where in the call a guard runs: see LambderGuardRunAt. */
export type LambderGuardPlacement = {
    /** Default: "beforeInputValidation". */
    runAt?: LambderGuardRunAt;
};

/** What a `guardInput` guard's value is to an idempotency key's request. */
export type LambderGuardInputUse = {
    /**
     * The value can differ between attempts of one operation: a single-use
     * proof (a captcha token, a one-time code) or a credential refreshed
     * between attempts (a short-lived token). A genuine retry may carry a new
     * one, so the value is left out of the fingerprint that tells one request
     * under an idempotency key from another; counted, it would turn the retry
     * into a 409 and the person's next attempt into a second run. Default:
     * false, the value counts, so the same key sent with
     * another value (another store, another tenant) is refused as another
     * request rather than replayed the first one's answer. Only a
     * `guardInput` guard takes it: an `apiInput` guard's value is the
     * payload's, which always counts.
     */
    singleUseInput?: boolean;
};

/**
 * The refusal codes a guard may refuse with, from the app's vocabulary (the
 * `refusals` option at creation). They join the codes of every API that
 * declares the guard, so each such API's contract lists them and its callers
 * narrow on them. Checked against the vocabulary at creation, since a guard
 * is built before the instance that knows it.
 */
export type LambderGuardRefusals<TRefusals extends readonly string[] = readonly string[]> = {
    refusals?: TRefusals;
};

/**
 * A named guard, run before the API's own input validation unless it says
 * otherwise (LambderGuardPlacement). Three input modes:
 *
 * - `apiInput`: the guard checks fields of the API's OWN payload. The slice
 *   is validated against the raw payload before `handler` runs and handed to
 *   it typed. The API's input schema still owns those fields: declaring the
 *   guard on an API whose schema lacks them is a compile error.
 * - `guardInput`: the guard has its own value the client sends SEPARATELY,
 *   via the caller's options.guardInputs[name]. The requirement lands on the
 *   API's contract (`guardInputs`), so the typed caller refuses to compile a
 *   call that omits it. The API payload and handler never see the value.
 * - neither: the guard reads only the context.
 *
 * A `guardInput` is part of what an idempotency key's request is, beside its
 * payload: the same key sent with another value (another store, another
 * tenant) is another request. A guard whose value can differ between
 * attempts of one operation (a captcha token, a one-time code, a short-lived
 * token refreshed in between) declares `singleUseInput: true`, and its value
 * is left out of that, since a genuine retry may carry a new one.
 *
 * Orthogonally, a guard may also:
 *
 * - declare `session: true`: the guard needs ctx.session, so it makes every
 *   endpoint declaring it a session endpoint (the session is read before the
 *   guards run, a call without one is answered sessionExpired, and the
 *   endpoint's handler receives the session-typed context), and it receives
 *   the session-typed context itself.
 * - take a PARAMETER: annotate a 3rd handler argument
 *   (`(ctx, payload, param: YourType) => ...`) and APIs pass the value in
 *   their declaration: `guards: { yourGuard: paramValue }`. The value is
 *   trusted registration-time code (never client data), typed per guard.
 * - RETURN a value: whatever the handler returns (awaited) is attached to
 *   the API handler's context as `ctx.guardData[guardName]`, fully typed.
 *   Guards that return nothing never appear in guardData.
 *
 * A guard says no by throwing refuse() or a LambderApiRefusal, rendered as
 * the structured refusal envelope. A validation failure of its input slice
 * answers like the API's own input validation (the app's
 * setApiInputValidationErrorHandler when set, else the standard 422). Guards
 * build no responses and hold no resolver, so the same engine runs them on
 * the server and in the mock runtime. Build with lambderGuard() so the
 * handler's payload/ctx/param types line up.
 *
 * TCtx and TSessionCtx are the two contexts an adapter runs guards on, and
 * an adapter's guards map pins them (the server's to the render contexts,
 * the mock's to the mock call contexts). Left open, the map would discard
 * the builder's binding: a server guard would compile into a mock guards map
 * and read `ctx.ip` as undefined, authorizing or refusing everything.
 */
export type LambderApiGuard<TInput extends z.ZodType = z.ZodType, TParam = any, TOutput = any, TCtx = any, TSessionCtx = TCtx> = LambderGuardPlacement & LambderGuardRefusals & (
    | { apiInput: TInput; guardInput?: undefined; singleUseInput?: undefined; session: true; handler: LambderGuardHandler<TSessionCtx, z.output<TInput>, TParam, TOutput> }
    | { apiInput: TInput; guardInput?: undefined; singleUseInput?: undefined; session?: false; handler: LambderGuardHandler<TCtx, z.output<TInput>, TParam, TOutput> }
    | ({ guardInput: TInput; apiInput?: undefined; session: true; handler: LambderGuardHandler<TSessionCtx, z.output<TInput>, TParam, TOutput> } & LambderGuardInputUse)
    | ({ guardInput: TInput; apiInput?: undefined; session?: false; handler: LambderGuardHandler<TCtx, z.output<TInput>, TParam, TOutput> } & LambderGuardInputUse)
    | { apiInput?: undefined; guardInput?: undefined; singleUseInput?: undefined; session: true; handler: LambderGuardHandler<TSessionCtx, undefined, TParam, TOutput> }
    | { apiInput?: undefined; guardInput?: undefined; singleUseInput?: undefined; session?: false; handler: LambderGuardHandler<TCtx, undefined, TParam, TOutput> }
);

/**
 * The refuse a guard's handler context carries when the guard is built from
 * an init with a declared vocabulary: typed to the guard's own refusals,
 * with data required where a code declares it, and never uncoded where the
 * app requires codes. A builder with no vocabulary type (the standalone
 * lambderGuard, the mock's) adds nothing to the context.
 */
type LambderGuardRefuse<TVocabulary, TRefusals extends readonly string[], TCodesRequired extends boolean> =
    [TVocabulary] extends [never] ? unknown
    : { refuse: LambderDeclaredRefuse<LambderHandlerRefusalsOf<TVocabulary, TRefusals[number] & keyof TVocabulary & string>, TCodesRequired> };

/**
 * A guard's refusals against the vocabulary of the init that builds it: a
 * code the vocabulary does not hold is refused on the `refusals` option, and
 * an init that declared no vocabulary refuses every code. A builder with no
 * vocabulary type checks nothing here; create() checks the guard against the
 * vocabulary then.
 */
type LambderGuardRefusalsKnownIn<TVocabulary, TRefusals extends readonly string[]> =
    [TVocabulary] extends [never] ? unknown
    : [Exclude<TRefusals[number], keyof TVocabulary & string>] extends [never] ? unknown
    : { refusals: readonly (keyof TVocabulary & string)[] };

/**
 * The builder's shape, generic over the two context types a guard may
 * receive: the plain one and the session-typed one. Ties the handler's
 * payload, context, param, and output types together inside one literal
 * and returns the exact shape so type extraction (mode, session, param,
 * output) works downstream. The param type is inferred from the handler's
 * 3rd argument annotation; the output from its return type. TVocabulary is
 * the app's refusal vocabulary where the init declared one, which types the
 * handler's ctx.refuse and checks the guard's refusals option.
 */
export type LambderGuardBuilder<TCtx, TSessionCtx, TVocabulary = never, TCodesRequired extends boolean = false> = {
    <TInput extends z.ZodType, TParam = undefined, TOutput = void, const TRefusals extends readonly string[] = readonly []>(guard: { apiInput: TInput; session: true; handler: (ctx: TSessionCtx & LambderGuardRefuse<TVocabulary, TRefusals, TCodesRequired>, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput> } & LambderGuardPlacement & LambderGuardRefusals<TRefusals> & LambderGuardRefusalsKnownIn<TVocabulary, TRefusals> & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, { refusals?: NoInfer<TRefusals>; apiInput: TInput; guardInput?: undefined; session: true; handler: (ctx: TSessionCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput> }>;
    <TInput extends z.ZodType, TParam = undefined, TOutput = void, const TRefusals extends readonly string[] = readonly []>(guard: { apiInput: TInput; handler: (ctx: TCtx & LambderGuardRefuse<TVocabulary, TRefusals, TCodesRequired>, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput> } & LambderGuardPlacement & LambderGuardRefusals<TRefusals> & LambderGuardRefusalsKnownIn<TVocabulary, TRefusals> & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, { refusals?: NoInfer<TRefusals>; apiInput: TInput; guardInput?: undefined; session?: undefined; handler: (ctx: TCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput> }>;
    <TInput extends z.ZodType, TParam = undefined, TOutput = void, const TRefusals extends readonly string[] = readonly []>(guard: { guardInput: TInput; session: true; handler: (ctx: TSessionCtx & LambderGuardRefuse<TVocabulary, TRefusals, TCodesRequired>, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput> } & LambderGuardInputUse & LambderGuardPlacement & LambderGuardRefusals<TRefusals> & LambderGuardRefusalsKnownIn<TVocabulary, TRefusals> & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, { refusals?: NoInfer<TRefusals>; guardInput: TInput; apiInput?: undefined; singleUseInput?: boolean; session: true; handler: (ctx: TSessionCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput> }>;
    <TInput extends z.ZodType, TParam = undefined, TOutput = void, const TRefusals extends readonly string[] = readonly []>(guard: { guardInput: TInput; handler: (ctx: TCtx & LambderGuardRefuse<TVocabulary, TRefusals, TCodesRequired>, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput> } & LambderGuardInputUse & LambderGuardPlacement & LambderGuardRefusals<TRefusals> & LambderGuardRefusalsKnownIn<TVocabulary, TRefusals> & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, { refusals?: NoInfer<TRefusals>; guardInput: TInput; apiInput?: undefined; singleUseInput?: boolean; session?: undefined; handler: (ctx: TCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput> }>;
    <TParam = undefined, TOutput = void, const TRefusals extends readonly string[] = readonly []>(guard: { session: true; handler: (ctx: TSessionCtx & LambderGuardRefuse<TVocabulary, TRefusals, TCodesRequired>, payload: undefined, param: TParam) => TOutput | Promise<TOutput> } & LambderGuardPlacement & LambderGuardRefusals<TRefusals> & LambderGuardRefusalsKnownIn<TVocabulary, TRefusals> & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, { refusals?: NoInfer<TRefusals>; apiInput?: undefined; guardInput?: undefined; session: true; handler: (ctx: TSessionCtx, payload: undefined, param: TParam) => TOutput | Promise<TOutput> }>;
    <TParam = undefined, TOutput = void, const TRefusals extends readonly string[] = readonly []>(guard: { handler: (ctx: TCtx & LambderGuardRefuse<TVocabulary, TRefusals, TCodesRequired>, payload: undefined, param: TParam) => TOutput | Promise<TOutput> } & LambderGuardPlacement & LambderGuardRefusals<TRefusals> & LambderGuardRefusalsKnownIn<TVocabulary, TRefusals> & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, { refusals?: NoInfer<TRefusals>; apiInput?: undefined; guardInput?: undefined; session?: undefined; handler: (ctx: TCtx, payload: undefined, param: TParam) => TOutput | Promise<TOutput> }>;
};

/**
 * A guard builder bound to a pair of context types. The server's
 * lambderGuard() is this bound to the render contexts; the mock runtime
 * binds it to its own handler contexts, so mock guards are the same shape
 * as server guards and run through the same engine.
 */
export const lambderGuardBuilder = <TCtx, TSessionCtx, TVocabulary = never, TCodesRequired extends boolean = false>(
    vocabulary?: ReadonlyMap<string, LambderRefusalDeclaration> | null,
): LambderGuardBuilder<TCtx, TSessionCtx, TVocabulary, TCodesRequired> =>
    ((guard: LambderApiGuard<any, any, any>) => {
        // An init's builder knows the vocabulary (null: the init declared
        // none) and refuses a guard naming a code outside it as it is built.
        // The standalone builder passes nothing, and create() checks then.
        if(vocabulary !== undefined) assertRefusalCodesDeclared("a guard", Array.isArray(guard.refusals) ? guard.refusals : [], vocabulary);
        return guard;
    }) as LambderGuardBuilder<TCtx, TSessionCtx, TVocabulary, TCodesRequired>;

/** The param type a guard's handler declares as its 3rd argument; undefined for paramless guards. */
type LambderGuardParamOf<G> =
    G extends { handler: (...args: infer A) => any }
        ? (A extends [any, any, infer P, ...any[]] ? P : undefined)
        : undefined;
/** What a guard's handler returns (awaited); void for check-only guards. */
type LambderGuardOutputOf<G> = G extends { handler: (...args: any[]) => infer R } ? Awaited<R> : never;

/**
 * Per-guard metadata carried on the Lambder instance: input mode, session
 * requirement, param type, output type. The input slices are recorded in
 * their input form (z.input), which is what a client sends and what an API's
 * posted payload is compared with; the guard's handler still receives the
 * parsed form.
 */
export type LambderGuardMeta<G> =
    (G extends { apiInput: infer S extends z.ZodType } ? { apiInput: z.input<S> }
    : G extends { guardInput: infer S extends z.ZodType } ? { guardInput: z.input<S> }
    : {})
    & (G extends { session: true } ? { session: true } : {})
    & { param: LambderGuardParamOf<G>; output: LambderGuardOutputOf<G>; refusals: LambderGuardRefusalNamesIn<G> };

/** The refusal codes a built guard declares, as a union; never for a guard that declares none. */
type LambderGuardRefusalNamesIn<G> = G extends { refusals?: infer R } ? (NonNullable<R> extends readonly (infer N extends string)[] ? N : never) : never;
export type LambderGuardMetaMap<TGuards> = { [K in keyof TGuards]: LambderGuardMeta<TGuards[K]> };

/**
 * Guard names an API may declare: every guard the instance holds, a session
 * guard included, which makes the API a session one (LambderApiModeOf).
 * Whether the API's input carries the fields an apiInput guard reads is
 * asked of the names it declared, once that input is known, by
 * LambderGuardNamesInputLacks.
 */
export type LambderAllowedGuardNames<TGuards> = keyof TGuards & string;

/**
 * The apiInput guards among `TNames` whose fields the API's payload does not
 * carry. defineApi asks this once the API's input is known, of
 * the names its guards option holds; see LambderPayloadSliceCheck.
 *
 * The payload is compared whole, not member by member: a bare `TPayload
 * extends R` would distribute over a union input, so a slice one member
 * carries would pass on an API whose other members lack it, and every
 * request of those members would be refused by the slice's parse.
 */
export type LambderGuardNamesInputLacks<TGuards, TNames, TPayload> = {
    [K in TNames & keyof TGuards]: TGuards[K] extends { apiInput: infer R } ? ([TPayload] extends [R] ? never : K) : never
}[TNames & keyof TGuards] & string;

/** The allowed guard names whose handler takes no param (usable in the string/array forms). */
export type LambderParamlessGuardNames<TGuards> = {
    [K in LambderAllowedGuardNames<TGuards> & keyof TGuards]:
        TGuards[K] extends { param: undefined } ? K & string : never
}[LambderAllowedGuardNames<TGuards> & keyof TGuards];

/** The map form's full shape: every declarable guard name, each carrying its own param type. */
type LambderGuardsMap<TGuards> = {
    readonly [K in LambderAllowedGuardNames<TGuards> & keyof TGuards]?:
        TGuards[K] extends { param: undefined } ? true : TGuards[K] extends { param: infer P } ? P : true };

/**
 * The per-API `guards` option: one paramless guard name, a non-empty ordered
 * list of paramless names, or a non-empty object map that can carry each
 * guard's param (`true` enables a paramless guard). Map entries run in
 * insertion order.
 *
 * Every form is non-empty by construction, so declaring the option is always
 * declaring a guard. See LambderNonEmptyOptionMap.
 *
 * It depends on the instance alone, never on the API's input, so the
 * compiler builds it once per instance rather than once per API; see
 * LambderPayloadSliceCheck for why, and for where the input is asked.
 */
export type LambderGuardsOption<TGuards> =
    | LambderParamlessGuardNames<TGuards>
    | readonly [LambderParamlessGuardNames<TGuards>,
        ...LambderParamlessGuardNames<TGuards>[]]
    | LambderNonEmptyOptionMap<LambderGuardsMap<TGuards>>;

/**
 * The typed ctx.guardData an API's handler sees: declared guards that return
 * a value, keyed by name. Check-only (void) guards never appear.
 */
export type LambderGuardDataOf<TGuards, TOpt> = {
    [K in LambderGuardNamesIn<TOpt> & keyof TGuards as
        [TGuards[K] extends { output: infer O } ? O : never] extends [void] ? never : K & string
    ]: TGuards[K] extends { output: infer O } ? O : never
};

type GuardInputsEntries<TGuards, TOpt> = {
    [K in Extract<LambderGuardNamesIn<TOpt>, keyof TGuards> as TGuards[K] extends { guardInput: any } ? K : never]:
        TGuards[K] extends { guardInput: infer V } ? V : never
};
/** The guardInputs map an API's contract requires clients to send; never when no declared guard uses guardInput mode. */
export type LambderGuardInputsOf<TGuards, TOpt> =
    keyof GuardInputsEntries<TGuards, TOpt> extends never ? never : GuardInputsEntries<TGuards, TOpt>;

/** The refusal codes an API's declared guards add to its own: a union of code names, never when none of them declares any. */
export type LambderGuardRefusalNamesOf<TGuards, TOpt> = {
    [K in LambderGuardNamesIn<TOpt> & keyof TGuards]: TGuards[K] extends { refusals: infer R } ? R : never
}[LambderGuardNamesIn<TOpt> & keyof TGuards];

/** Normalize the three guards-option forms into ordered { name, param } entries. Read by the engine, and by the signature digest for the names alone. */
export const toGuardEntries = (value?: LambderGuardsOptionValue): { name: string, param: unknown }[] => {
    if(value === undefined) return [];
    if(typeof value === "string") return [{ name: value, param: undefined }];
    if(Array.isArray(value)) return value.map((name) => ({ name: String(name), param: undefined }));
    // Object form: insertion order, params passed verbatim (paramless guards
    // are declared with `true` and their handlers take no param argument).
    return Object.entries(value).map(([name, param]) => ({ name, param }));
};

/**
 * One guard's input out of the map the client posted. The map is client
 * data, so a guard named for something Object.prototype carries
 * ("toString", "constructor") must read as absent when the client sent
 * nothing, not as the inherited function. Guard names are deliberately
 * unrestricted, so the read has to handle this.
 */
const readGuardInput = (guardInputs: Record<string, unknown> | undefined, name: string): unknown =>
    guardInputs !== undefined && Object.prototype.hasOwnProperty.call(guardInputs, name) ? guardInputs[name] : undefined;

/**
 * Runtime side of the guards subsystem: holds the defined guards, asserts
 * API registrations against them at startup, and executes an API's declared
 * guards during preflight. Held by LambderApiPipeline. Reads the
 * request and writes the call context, so it runs unchanged under the
 * server and the mock runtime.
 */
export class LambderApiGuardsEngine {
    // A Map, not an object: a plain object answers for "toString" and
    // "constructor" through its prototype, so an API declaring one of those as
    // a guard name would pass the registration check meant to catch exactly
    // that typo and then fail on every request. It would also refuse to
    // register a guard legitimately named one of them.
    private guards = new Map<string, LambderApiGuard<any, any, any>>();

    /** True once a guards map was configured. */
    get isConfigured(): boolean { return this.guards.size > 0; }

    /** Take the guards map given at creation; named like the other two engines' configure(). */
    configure(guards: Record<string, LambderApiGuard<any, any, any>>): void {
        // One configuration per instance, as in the rate-limit and idempotency
        // engines: a second map would silently merge into the first, and which
        // of two same-named guards ran would depend on call order.
        if(this.guards.size > 0) throw new Error("Lambder: guards were already configured.");
        // Declaring the option always declares a guard, the rule an API's own
        // `guards: {}` is held to. Otherwise the engine stays unconfigured and
        // every API declaring a guard is told no guards option was given,
        // which sends the reader to the wrong line.
        if(Object.keys(guards).length === 0){
            throw new Error("Lambder: the guards option was declared with no guards in it, which configures nothing. Name the guards APIs will declare, or leave the option off.");
        }
        for(const [name, guardDef] of Object.entries(guards)){
            if(this.guards.has(name)) throw new Error(`Lambder: guard "${name}" is already defined.`);
            if(typeof guardDef?.handler !== "function") throw new Error(`Lambder: guard "${name}" has no handler function.`);
            if(guardDef.apiInput && guardDef.guardInput) throw new Error(`Lambder: guard "${name}" declares both apiInput and guardInput; pick one.`);
            const refusals = guardDef.refusals as unknown;
            if(refusals !== undefined && (!Array.isArray(refusals) || refusals.some((code) => typeof code !== "string" || code === ""))){
                throw new Error(`Lambder: guard "${name}" has a refusals option that is not a list of refusal codes.`);
            }
            const runAt = guardDef.runAt as LambderGuardRunAt | undefined;
            if(runAt !== undefined && runAt !== "beforeInputValidation" && runAt !== "afterInputValidation"){
                throw new Error(`Lambder: guard "${name}" has runAt "${String(runAt)}"; use "beforeInputValidation" (default) or "afterInputValidation".`);
            }
            const singleUseInput = guardDef.singleUseInput as unknown;
            if(singleUseInput !== undefined && typeof singleUseInput !== "boolean"){
                throw new Error(`Lambder: guard "${name}" has singleUseInput ${String(singleUseInput)}; write true for a value a retry carries fresh, or leave it off.`);
            }
            if(singleUseInput && !guardDef.guardInput){
                throw new Error(`Lambder: guard "${name}" declares singleUseInput without a guardInput. Only a value the client sends beside the payload can be left out of an idempotent request's fingerprint; a slice of the payload always counts.`);
            }
            this.guards.set(name, guardDef);
        }
    }

    /** Startup validation of one API registration's guards option. */
    assertRegistration(apiName: string, mode: LambderApiMode, guardsOption?: LambderGuardsOptionValue): void {
        const entries = toGuardEntries(guardsOption);
        // The runtime half of LambderNonEmptyOptionMap on the guards option.
        // `guards: {}` and `guards: []` would satisfy the require*ApiGuards
        // field check while running nothing, turning a mandatory authorization
        // declaration into an optional one. The type rejects both; a plain-JS
        // caller, a cast, or a spread that produced an empty object lands here.
        if(guardsOption !== undefined && entries.length === 0){
            throw new Error(
                `Lambder: API "${apiName}" declares an empty guards option, which authorizes nothing. ` +
                `Name the guard that authorizes it, or omit the option entirely.`
            );
        }
        for(const { name } of entries){
            const guardDef = this.guards.get(name);
            if(!guardDef){
                throw new Error(`Lambder: API "${apiName}" references unknown guard "${name}". Declare it in the guards option at creation.`);
            }
            if(guardDef.session && mode !== "session"){
                throw new Error(`Lambder: API "${apiName}" uses guard "${name}" (session: true) but is registered as public. An endpoint declaring a session guard is a session endpoint.`);
            }
        }
    }

    /**
     * The posted guard inputs an idempotency fingerprint holds for an API
     * declaring `guardsOption`: the value of each of its `guardInput` guards
     * by name, except a guard's declared singleUseInput. Read as posted, as
     * the payload is, before any guard parses it; a guard the client sent
     * nothing for is left out. A null-prototype map, so a guard named
     * "__proto__" is a key like any other.
     */
    fingerprintedInputsOf(request: LambderApiRequest, guardsOption: LambderGuardsOptionValue | undefined): Record<string, unknown> {
        const inputs: Record<string, unknown> = Object.create(null);
        for(const { name } of toGuardEntries(guardsOption)){
            const guardDef = this.guards.get(name);
            if(!guardDef?.guardInput || guardDef.singleUseInput) continue;
            const input = readGuardInput(request.guardInputs, name);
            if(input !== undefined) inputs[name] = input;
        }
        return inputs;
    }

    /**
     * Run the API's guards that run at `runAt` (see LambderGuardRunAt) in
     * declared order. Refusals throw; outputs land on ctx.guardData; the
     * trace names every guard reached.
     */
    async run(
        request: LambderApiRequest,
        ctx: LambderApiCallContext,
        guardsOption: LambderGuardsOptionValue | undefined,
        trace: LambderApiCallTrace,
        runAt: LambderGuardRunAt,
    ): Promise<void> {
        for(const { name, param } of toGuardEntries(guardsOption)){
            const guardDef = this.guards.get(name);
            if(!guardDef) throw new Error(`Lambder: guard "${name}" is not configured. Declare it in the guards option at creation.`);
            if((guardDef.runAt ?? "beforeInputValidation") !== runAt) continue;
            // Recorded before anything this guard does can refuse, including
            // the slice parse below (a guard that rejects its own input answers
            // 422), so the guard that said no is the last name on the list.
            trace.guardsRun.push(name);
            let payload: unknown;
            if(guardDef.apiInput){
                payload = await parsePreflightSlice(guardDef.apiInput, request.payload);
            }else if(guardDef.guardInput){
                payload = await parsePreflightSlice(guardDef.guardInput, readGuardInput(request.guardInputs, name));
            }
            // A guard's return value becomes the handler's typed
            // ctx.guardData[name]; check-only guards return undefined.
            const output = await guardDef.handler(ctx as never, payload as never, param as never);
            if(isLambderResponseLike(output)){
                throw new Error(
                    `Lambder: guard "${name}" returned a LambderResponse. A guard authorizes, it does not answer: ` +
                    `say no with refuse() or by throwing a LambderApiRefusal. Returning a response denies nothing, ` +
                    `because the value would be attached to ctx.guardData and the call would continue.`
                );
            }
            if(output !== undefined){
                ctx.guardData[name] = output;
            }
        }
    }
}

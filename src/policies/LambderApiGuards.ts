import type { z } from "zod";
import type { LambderRenderContext, LambderSessionRenderContext } from "../core/LambderContext.js";
import type LambderResolver from "../core/LambderResolver.js";

/**
 * A named guard, run before the API's own input validation. Three input
 * modes:
 *
 * - `apiInput`: the guard checks fields of the API's OWN payload. The slice
 *   is validated against the raw payload before `handler` runs and handed to
 *   it typed. The API's input schema stays the owner of those fields:
 *   declaring the guard on an API whose schema does not carry them is a
 *   compile error.
 * - `guardInput`: the guard has its own value the client sends SEPARATELY,
 *   outside the API payload, via the caller's options.guardInputs[name].
 *   The requirement lands on the API's contract (`guardInputs`), so the
 *   typed caller refuses to compile a call that does not send it. The API
 *   payload and handler never see the value.
 * - neither: the guard reads only the context.
 *
 * Orthogonally, a guard may also:
 *
 * - declare `session: true`: the guard needs ctx.session, so it is only
 *   declarable on addSessionApi (compile error and startup assert on public
 *   APIs) and its handler receives the session-typed context.
 * - take a PARAMETER: annotate a 4th handler argument
 *   (`(ctx, payload, res, param: YourType) => ...`) and APIs pass the value
 *   in their declaration: `guards: { yourGuard: paramValue }`. The value is
 *   trusted registration-time code (never client data), typed per guard.
 * - RETURN a value: whatever the handler returns (awaited) is attached to
 *   the API handler's context as `ctx.guardData[guardName]`, fully typed.
 *   Guards that return nothing never appear in guardData.
 *
 * A validation failure answers the standard 422 shape, and the handler
 * refuses by throwing (typically refuse()/LambderApiError). Build with
 * lambderGuard() so the handler's payload/ctx/param types line up.
 */
export type LambderApiGuard<TInput extends z.ZodTypeAny = z.ZodTypeAny, TParam = any, TOutput = any> =
    | { apiInput: TInput; guardInput?: undefined; session?: boolean; handler: (ctx: any, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> }
    | { guardInput: TInput; apiInput?: undefined; session?: boolean; handler: (ctx: any, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> }
    | { apiInput?: undefined; guardInput?: undefined; session?: boolean; handler: (ctx: any, payload: undefined, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> };

type GuardCtx = LambderRenderContext;
type GuardSessionCtx = LambderSessionRenderContext<any, any>;

/**
 * Builder that ties the handler's payload, context, param, and output types
 * together inside one literal. Returns the exact shape so type extraction
 * (mode, session, param, output) works downstream. The param type is
 * inferred from the handler's 4th argument annotation; the output from its
 * return type.
 */
export function lambderGuard<TInput extends z.ZodTypeAny, TParam = undefined, TOutput = void>(guard: { apiInput: TInput; session: true; handler: (ctx: GuardSessionCtx, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> }): { apiInput: TInput; guardInput?: undefined; session: true; handler: (ctx: GuardSessionCtx, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> };
export function lambderGuard<TInput extends z.ZodTypeAny, TParam = undefined, TOutput = void>(guard: { apiInput: TInput; handler: (ctx: GuardCtx, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> }): { apiInput: TInput; guardInput?: undefined; session?: undefined; handler: (ctx: GuardCtx, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> };
export function lambderGuard<TInput extends z.ZodTypeAny, TParam = undefined, TOutput = void>(guard: { guardInput: TInput; session: true; handler: (ctx: GuardSessionCtx, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> }): { guardInput: TInput; apiInput?: undefined; session: true; handler: (ctx: GuardSessionCtx, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> };
export function lambderGuard<TInput extends z.ZodTypeAny, TParam = undefined, TOutput = void>(guard: { guardInput: TInput; handler: (ctx: GuardCtx, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> }): { guardInput: TInput; apiInput?: undefined; session?: undefined; handler: (ctx: GuardCtx, payload: z.output<TInput>, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> };
export function lambderGuard<TParam = undefined, TOutput = void>(guard: { session: true; handler: (ctx: GuardSessionCtx, payload: undefined, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> }): { apiInput?: undefined; guardInput?: undefined; session: true; handler: (ctx: GuardSessionCtx, payload: undefined, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> };
export function lambderGuard<TParam = undefined, TOutput = void>(guard: { handler: (ctx: GuardCtx, payload: undefined, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> }): { apiInput?: undefined; guardInput?: undefined; session?: undefined; handler: (ctx: GuardCtx, payload: undefined, res: LambderResolver, param: TParam) => TOutput | Promise<TOutput> };
export function lambderGuard(guard: LambderApiGuard<any, any, any>): LambderApiGuard<any, any, any> { return guard; }

/** The param type a guard's handler declares as its 4th argument; undefined for paramless guards. */
type LambderGuardParamOf<G> =
    G extends { handler: (...args: infer A) => any }
        ? (A extends [any, any, any, infer P, ...any[]] ? P : undefined)
        : undefined;
/** What a guard's handler returns (awaited); void for check-only guards. */
type LambderGuardOutputOf<G> = G extends { handler: (...args: any[]) => infer R } ? Awaited<R> : never;

/** Per-guard metadata carried on the Lambder instance: input mode, session requirement, param type, output type. */
export type LambderGuardMeta<G> =
    (G extends { apiInput: infer S extends z.ZodTypeAny } ? { apiInput: z.output<S> }
    : G extends { guardInput: infer S extends z.ZodTypeAny } ? { guardInput: z.output<S> }
    : {})
    & (G extends { session: true } ? { session: true } : {})
    & { param: LambderGuardParamOf<G>; output: LambderGuardOutputOf<G> };
export type LambderGuardMetaMap<TGuards> = { [K in keyof TGuards]: LambderGuardMeta<TGuards[K]> };

/** Guard names referenced by a guards option, whichever of its three forms is used. */
type NamesIn<TOpt> =
    TOpt extends string ? TOpt
    : TOpt extends readonly (infer N extends string)[] ? N
    : TOpt extends object ? keyof TOpt & string
    : never;

type LambderGuardNameIfPayloadOk<TGuards, K extends keyof TGuards, TPayload> =
    TGuards[K] extends { apiInput: infer R } ? (TPayload extends R ? K : never) : K;

/**
 * Guard names an API may declare: apiInput-mode guards only when the API's
 * payload carries their fields, session guards only on session APIs.
 */
export type LambderAllowedGuardNames<TGuards, TPayload, TIncludeSession extends boolean = true> = {
    [K in keyof TGuards]:
        TGuards[K] extends { session: true }
            ? (TIncludeSession extends true ? LambderGuardNameIfPayloadOk<TGuards, K, TPayload> : never)
            : LambderGuardNameIfPayloadOk<TGuards, K, TPayload>
}[keyof TGuards] & string;

/** The allowed guard names whose handler takes no param (usable in the string/array forms). */
export type LambderParamlessGuardNames<TGuards, TPayload, TIncludeSession extends boolean> = {
    [K in LambderAllowedGuardNames<TGuards, TPayload, TIncludeSession> & keyof TGuards]:
        TGuards[K] extends { param: undefined } ? K & string : never
}[LambderAllowedGuardNames<TGuards, TPayload, TIncludeSession> & keyof TGuards];

/**
 * The per-API `guards` option: one paramless guard name, an ordered list of
 * paramless names, or an object map that can carry each guard's param
 * (`true` enables a paramless guard). Map entries run in insertion order.
 */
export type LambderGuardsOption<TGuards, TPayload, TIncludeSession extends boolean> =
    | LambderParamlessGuardNames<TGuards, TPayload, TIncludeSession>
    | readonly LambderParamlessGuardNames<TGuards, TPayload, TIncludeSession>[]
    | { readonly [K in LambderAllowedGuardNames<TGuards, TPayload, TIncludeSession> & keyof TGuards]?:
          TGuards[K] extends { param: undefined } ? true : TGuards[K] extends { param: infer P } ? P : true };

/**
 * The typed ctx.guardData an API's handler sees: declared guards that return
 * a value, keyed by name. Check-only (void) guards never appear.
 */
export type LambderGuardDataOf<TGuards, TOpt> = {
    [K in NamesIn<TOpt> & keyof TGuards as
        [TGuards[K] extends { output: infer O } ? O : never] extends [void] ? never : K & string
    ]: TGuards[K] extends { output: infer O } ? O : never
};

type GuardInputsEntries<TGuards, TOpt> = {
    [K in Extract<NamesIn<TOpt>, keyof TGuards> as TGuards[K] extends { guardInput: any } ? K : never]:
        TGuards[K] extends { guardInput: infer V } ? V : never
};
/** The guardInputs map an API's contract requires clients to send; never when no declared guard uses guardInput mode. */
export type LambderGuardInputsOf<TGuards, TOpt> =
    keyof GuardInputsEntries<TGuards, TOpt> extends never ? never : GuardInputsEntries<TGuards, TOpt>;

/** The guards option's runtime shape: a name, ordered names, or a name-to-param map. */
export type LambderGuardsOptionValue = string | readonly string[] | Readonly<Record<string, unknown>>;

/** Normalize the three guards-option forms into ordered { name, param } entries. */
const toGuardEntries = (value?: LambderGuardsOptionValue): { name: string, param: unknown }[] => {
    if(value === undefined) return [];
    if(typeof value === "string") return [{ name: value, param: undefined }];
    if(Array.isArray(value)) return value.map((name) => ({ name: String(name), param: undefined }));
    // Object form: insertion order, params passed verbatim (paramless guards
    // are declared with `true` and their handlers take no param argument).
    return Object.entries(value).map(([name, param]) => ({ name, param }));
};

/**
 * Validate a preflight input slice (an apiInput slice of the raw payload, or
 * a guardInput value from the raw guardInputs map). Runs before the API's
 * own validation; failures answer the same 422 shape as regular input
 * validation. Shared with the rate-limit engine's apiInput-keyed policies.
 */
export const parsePreflightSlice = (input: z.ZodTypeAny, value: unknown, resolver: LambderResolver): unknown => {
    const parsed = input.safeParse(value);
    if(!parsed.success){
        throw resolver.json({ error: "Input validation failed", zodError: parsed.error }, { statusCode: 422 });
    }
    return parsed.data;
};

/**
 * Runtime side of the guards subsystem: holds the defined guards, asserts
 * API registrations against them at startup, and executes an API's declared
 * guards during preflight. Composed into LambderApiPolicyEngine.
 */
export class LambderApiGuardsEngine {
    private guards: Record<string, LambderApiGuard<any, any, any>> = {};

    addGuards(guards: Record<string, LambderApiGuard<any, any, any>>): void {
        for(const [name, guardDef] of Object.entries(guards)){
            if(this.guards[name]) throw new Error(`Lambder: guard "${name}" is already defined.`);
            if(typeof guardDef?.handler !== "function") throw new Error(`Lambder: guard "${name}" has no handler function.`);
            if(guardDef.apiInput && guardDef.guardInput) throw new Error(`Lambder: guard "${name}" declares both apiInput and guardInput; pick one.`);
            this.guards[name] = guardDef;
        }
    }

    /** Startup validation of one API registration's guards option. */
    assertRegistration(apiName: string, mode: "public" | "session", guardsOption?: LambderGuardsOptionValue): void {
        for(const { name } of toGuardEntries(guardsOption)){
            const guardDef = this.guards[name];
            if(!guardDef){
                throw new Error(`Lambder: API "${apiName}" references unknown guard "${name}". Declare it in the guards option at creation.`);
            }
            if(guardDef.session && mode !== "session"){
                throw new Error(`Lambder: API "${apiName}" uses guard "${name}" (session: true), which requires addSessionApi.`);
            }
        }
    }

    /** Run the API's guards in declared order. Refusals throw; outputs land on ctx.guardData. */
    async run(ctx: LambderRenderContext, resolver: LambderResolver, guardsOption?: LambderGuardsOptionValue): Promise<void> {
        for(const { name, param } of toGuardEntries(guardsOption)){
            const guardDef = this.guards[name];
            if(!guardDef) throw new Error(`Lambder: guard "${name}" is not configured.`);
            const post = ctx.post as Record<string, unknown> | undefined;
            let payload: unknown;
            if(guardDef.apiInput){
                payload = parsePreflightSlice(guardDef.apiInput, post?.payload, resolver);
            }else if(guardDef.guardInput){
                payload = parsePreflightSlice(guardDef.guardInput, (post?.guardInputs as Record<string, unknown> | undefined)?.[name], resolver);
            }
            // A guard's return value becomes the handler's typed
            // ctx.guardData[name]; check-only guards return undefined.
            const output = await guardDef.handler(ctx as never, payload as never, resolver, param as never);
            if(output !== undefined){
                (ctx.guardData as Record<string, unknown>)[name] = output;
            }
        }
    }
}

import type { LambderNonEmptyOptionMap } from "../shared/util/LambderTypeUtilities.js";
import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext, LambderApiCallTrace } from "./LambderApiCallContext.js";
import type { LambderApiMode, LambderGuardNamesIn } from "../shared/wire/LambderApiContract.js";
import type { LambderGuardsOptionValue } from "../shared/wire/LambderApiOptionValues.js";
import { LAMBDER_RESPONSE_BRAND } from "../shared/util/LambderResponseBrand.js";
/**
 * What lambderGuard() returns for a handler that answers instead of
 * authorizing. Nothing accepts it, so the guards map is where the mistake
 * surfaces, named.
 */
type LambderGuardMustNotAnswer = {
    readonly "lambder: a guard authorizes, it does not answer. Say no with refuse() or by throwing a LambderApiRefusal.": never;
};
/**
 * Intersected into the builder's parameter so the mistake is reported where
 * it is written, at the lambderGuard() call, rather than further away where
 * the guard is put into a map. An answering handler makes this a required
 * property no object literal can satisfy, and the property name is the
 * message.
 */
type LambderGuardAnswerCheck<TOutput> = [
    TOutput
] extends [never] ? unknown : 0 extends 1 & TOutput ? unknown : [Extract<TOutput, {
    readonly [LAMBDER_RESPONSE_BRAND]: unknown;
}>] extends [never] ? unknown : LambderGuardMustNotAnswer;
/**
 * A built guard, unless its handler answers instead of authorizing. Applied
 * to the builder's RESULT rather than to its parameters, so the handler's
 * unannotated arguments keep taking their types from the overload that
 * matched and only the returned shape changes. A guard that hands back a
 * response denies nothing at runtime (the value would become
 * ctx.guardData[name] and the call would carry on), so it must not reach a
 * guards map: this turns the ordinary spelling of that mistake into a build
 * error, and the engine throws on the ones a cast smuggles past.
 *
 * Defined in terms of LambderGuardAnswerCheck so the two cannot drift: one
 * rule for what counts as answering, read twice.
 */
type LambderGuardOf<TOutput, TGuard> = LambderGuardAnswerCheck<TOutput> extends LambderGuardMustNotAnswer ? LambderGuardMustNotAnswer : TGuard;
/** One guard handler: the adapter's context, the validated input slice (undefined in the no-input mode), and the per-API parameter. */
type LambderGuardHandler<TCtx, TPayload, TParam, TOutput> = (ctx: TCtx, payload: TPayload, param: TParam) => TOutput | Promise<TOutput>;
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
 * - take a PARAMETER: annotate a 3rd handler argument
 *   (`(ctx, payload, param: YourType) => ...`) and APIs pass the value in
 *   their declaration: `guards: { yourGuard: paramValue }`. The value is
 *   trusted registration-time code (never client data), typed per guard.
 * - RETURN a value: whatever the handler returns (awaited) is attached to
 *   the API handler's context as `ctx.guardData[guardName]`, fully typed.
 *   Guards that return nothing never appear in guardData.
 *
 * A guard says no by throwing: refuse() or a LambderApiRefusal, which the
 * pipeline renders as the structured refusal envelope. A validation failure
 * of its input slice answers like the API's own input validation (the app's
 * setApiInputValidationErrorHandler when set, else the standard 422). Guards
 * build no responses and hold no resolver, which is what lets the same
 * engine run them on the server and in the mock runtime. Build with
 * lambderGuard() so the handler's payload/ctx/param types line up.
 *
 * TCtx and TSessionCtx are the two contexts an adapter runs guards on, and
 * an adapter's guards map pins them (the server's to the render contexts,
 * the mock's to the mock call contexts). Left open, the binding the builder
 * establishes was thrown away at the map: a guard written for the server
 * compiled into a mock guards map and then read `ctx.ip` as undefined, so it
 * authorized or refused everything.
 */
export type LambderApiGuard<TInput extends z.ZodType = z.ZodType, TParam = any, TOutput = any, TCtx = any, TSessionCtx = TCtx> = {
    apiInput: TInput;
    guardInput?: undefined;
    session: true;
    handler: LambderGuardHandler<TSessionCtx, z.output<TInput>, TParam, TOutput>;
} | {
    apiInput: TInput;
    guardInput?: undefined;
    session?: false;
    handler: LambderGuardHandler<TCtx, z.output<TInput>, TParam, TOutput>;
} | {
    guardInput: TInput;
    apiInput?: undefined;
    session: true;
    handler: LambderGuardHandler<TSessionCtx, z.output<TInput>, TParam, TOutput>;
} | {
    guardInput: TInput;
    apiInput?: undefined;
    session?: false;
    handler: LambderGuardHandler<TCtx, z.output<TInput>, TParam, TOutput>;
} | {
    apiInput?: undefined;
    guardInput?: undefined;
    session: true;
    handler: LambderGuardHandler<TSessionCtx, undefined, TParam, TOutput>;
} | {
    apiInput?: undefined;
    guardInput?: undefined;
    session?: false;
    handler: LambderGuardHandler<TCtx, undefined, TParam, TOutput>;
};
/**
 * The builder's shape, generic over the two context types a guard may
 * receive: the plain one and the session-typed one. Ties the handler's
 * payload, context, param, and output types together inside one literal
 * and returns the exact shape so type extraction (mode, session, param,
 * output) works downstream. The param type is inferred from the handler's
 * 3rd argument annotation; the output from its return type.
 */
export type LambderGuardBuilder<TCtx, TSessionCtx> = {
    <TInput extends z.ZodType, TParam = undefined, TOutput = void>(guard: {
        apiInput: TInput;
        session: true;
        handler: (ctx: TSessionCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput>;
    } & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, {
        apiInput: TInput;
        guardInput?: undefined;
        session: true;
        handler: (ctx: TSessionCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput>;
    }>;
    <TInput extends z.ZodType, TParam = undefined, TOutput = void>(guard: {
        apiInput: TInput;
        handler: (ctx: TCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput>;
    } & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, {
        apiInput: TInput;
        guardInput?: undefined;
        session?: undefined;
        handler: (ctx: TCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput>;
    }>;
    <TInput extends z.ZodType, TParam = undefined, TOutput = void>(guard: {
        guardInput: TInput;
        session: true;
        handler: (ctx: TSessionCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput>;
    } & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, {
        guardInput: TInput;
        apiInput?: undefined;
        session: true;
        handler: (ctx: TSessionCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput>;
    }>;
    <TInput extends z.ZodType, TParam = undefined, TOutput = void>(guard: {
        guardInput: TInput;
        handler: (ctx: TCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput>;
    } & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, {
        guardInput: TInput;
        apiInput?: undefined;
        session?: undefined;
        handler: (ctx: TCtx, payload: z.output<TInput>, param: TParam) => TOutput | Promise<TOutput>;
    }>;
    <TParam = undefined, TOutput = void>(guard: {
        session: true;
        handler: (ctx: TSessionCtx, payload: undefined, param: TParam) => TOutput | Promise<TOutput>;
    } & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, {
        apiInput?: undefined;
        guardInput?: undefined;
        session: true;
        handler: (ctx: TSessionCtx, payload: undefined, param: TParam) => TOutput | Promise<TOutput>;
    }>;
    <TParam = undefined, TOutput = void>(guard: {
        handler: (ctx: TCtx, payload: undefined, param: TParam) => TOutput | Promise<TOutput>;
    } & LambderGuardAnswerCheck<TOutput>): LambderGuardOf<TOutput, {
        apiInput?: undefined;
        guardInput?: undefined;
        session?: undefined;
        handler: (ctx: TCtx, payload: undefined, param: TParam) => TOutput | Promise<TOutput>;
    }>;
};
/**
 * A guard builder bound to a pair of context types. The server's
 * lambderGuard() is this bound to the render contexts; the mock runtime
 * binds it to its own handler contexts, so mock guards are the same shape
 * as server guards and run through the same engine.
 */
export declare const lambderGuardBuilder: <TCtx, TSessionCtx>() => LambderGuardBuilder<TCtx, TSessionCtx>;
/** The param type a guard's handler declares as its 3rd argument; undefined for paramless guards. */
type LambderGuardParamOf<G> = G extends {
    handler: (...args: infer A) => any;
} ? (A extends [any, any, infer P, ...any[]] ? P : undefined) : undefined;
/** What a guard's handler returns (awaited); void for check-only guards. */
type LambderGuardOutputOf<G> = G extends {
    handler: (...args: any[]) => infer R;
} ? Awaited<R> : never;
/** Per-guard metadata carried on the Lambder instance: input mode, session requirement, param type, output type. */
export type LambderGuardMeta<G> = (G extends {
    apiInput: infer S extends z.ZodType;
} ? {
    apiInput: z.output<S>;
} : G extends {
    guardInput: infer S extends z.ZodType;
} ? {
    guardInput: z.output<S>;
} : {}) & (G extends {
    session: true;
} ? {
    session: true;
} : {}) & {
    param: LambderGuardParamOf<G>;
    output: LambderGuardOutputOf<G>;
};
export type LambderGuardMetaMap<TGuards> = {
    [K in keyof TGuards]: LambderGuardMeta<TGuards[K]>;
};
type LambderGuardNameIfPayloadOk<TGuards, K extends keyof TGuards, TPayload> = TGuards[K] extends {
    apiInput: infer R;
} ? (TPayload extends R ? K : never) : K;
/**
 * Guard names an API may declare: apiInput-mode guards only when the API's
 * payload carries their fields, session guards only on session APIs.
 */
export type LambderAllowedGuardNames<TGuards, TPayload, TIncludeSession extends boolean = true> = {
    [K in keyof TGuards]: TGuards[K] extends {
        session: true;
    } ? (TIncludeSession extends true ? LambderGuardNameIfPayloadOk<TGuards, K, TPayload> : never) : LambderGuardNameIfPayloadOk<TGuards, K, TPayload>;
}[keyof TGuards] & string;
/** The allowed guard names whose handler takes no param (usable in the string/array forms). */
export type LambderParamlessGuardNames<TGuards, TPayload, TIncludeSession extends boolean> = {
    [K in LambderAllowedGuardNames<TGuards, TPayload, TIncludeSession> & keyof TGuards]: TGuards[K] extends {
        param: undefined;
    } ? K & string : never;
}[LambderAllowedGuardNames<TGuards, TPayload, TIncludeSession> & keyof TGuards];
/** The map form's full shape: every declarable guard name, each carrying its own param type. */
type LambderGuardsMap<TGuards, TPayload, TIncludeSession extends boolean> = {
    readonly [K in LambderAllowedGuardNames<TGuards, TPayload, TIncludeSession> & keyof TGuards]?: TGuards[K] extends {
        param: undefined;
    } ? true : TGuards[K] extends {
        param: infer P;
    } ? P : true;
};
/**
 * The per-API `guards` option: one paramless guard name, a non-empty ordered
 * list of paramless names, or a non-empty object map that can carry each
 * guard's param (`true` enables a paramless guard). Map entries run in
 * insertion order.
 *
 * Every form is non-empty by construction, so declaring the option is always
 * declaring a guard. See LambderNonEmptyOptionMap.
 */
export type LambderGuardsOption<TGuards, TPayload, TIncludeSession extends boolean> = LambderParamlessGuardNames<TGuards, TPayload, TIncludeSession> | readonly [
    LambderParamlessGuardNames<TGuards, TPayload, TIncludeSession>,
    ...LambderParamlessGuardNames<TGuards, TPayload, TIncludeSession>[]
] | LambderNonEmptyOptionMap<LambderGuardsMap<TGuards, TPayload, TIncludeSession>>;
/**
 * The typed ctx.guardData an API's handler sees: declared guards that return
 * a value, keyed by name. Check-only (void) guards never appear.
 */
export type LambderGuardDataOf<TGuards, TOpt> = {
    [K in LambderGuardNamesIn<TOpt> & keyof TGuards as [
        TGuards[K] extends {
            output: infer O;
        } ? O : never
    ] extends [void] ? never : K & string]: TGuards[K] extends {
        output: infer O;
    } ? O : never;
};
type GuardInputsEntries<TGuards, TOpt> = {
    [K in Extract<LambderGuardNamesIn<TOpt>, keyof TGuards> as TGuards[K] extends {
        guardInput: any;
    } ? K : never]: TGuards[K] extends {
        guardInput: infer V;
    } ? V : never;
};
/** The guardInputs map an API's contract requires clients to send; never when no declared guard uses guardInput mode. */
export type LambderGuardInputsOf<TGuards, TOpt> = keyof GuardInputsEntries<TGuards, TOpt> extends never ? never : GuardInputsEntries<TGuards, TOpt>;
/**
 * Runtime side of the guards subsystem: holds the defined guards, asserts
 * API registrations against them at startup, and executes an API's declared
 * guards during preflight. Composed into LambderApiPolicyEngine. Reads the
 * request and writes the call context, so it runs unchanged under the
 * server and the mock runtime.
 */
export declare class LambderApiGuardsEngine {
    private guards;
    /** True once a guards map was configured. */
    get isConfigured(): boolean;
    /** Take the guards map given at creation; named like the other two engines' configure(). */
    configure(guards: Record<string, LambderApiGuard<any, any, any>>): void;
    /** Startup validation of one API registration's guards option. */
    assertRegistration(apiName: string, mode: LambderApiMode, guardsOption?: LambderGuardsOptionValue): void;
    /**
     * Run the API's guards in declared order. Refusals throw; outputs land on
     * ctx.guardData. Each guard is recorded on the trace as it returns, so a
     * call that a later guard refused still reports the ones that passed.
     */
    run(request: LambderApiRequest, ctx: LambderApiCallContext, guardsOption: LambderGuardsOptionValue | undefined, trace: LambderApiCallTrace): Promise<void>;
}
export {};

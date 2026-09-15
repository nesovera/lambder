import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type { LambderRateLimitOptionValue, LambderRateLimitOverride } from "../shared/wire/LambderApiOptionValues.js";
import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext } from "./LambderApiCallContext.js";
import { type LambderRateLimiter, type LambderRateLimitPolicy } from "../shared/contracts/LambderRateLimiter.js";
import { LambderApiRefusal, type LambderAppRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import type { LambderNonEmptyOptionMap } from "../shared/util/LambderTypeUtilities.js";
/** Refusal a rate-limited request answers unless the policy or the API's override names its own. */
export declare const DEFAULT_RATE_LIMIT_REFUSAL: {
    type: "warning";
    code: "lambder/rate-limited";
    content: string;
};
/**
 * The refusal a rate-limited call answers with: a 429 envelope carrying the
 * framework code (a policy's own message inherits it unless it sets a more
 * specific one) and a Retry-After header. The engine throws it; the mock
 * runtime's failure injection throws the same one, so an injected rate
 * limit is indistinguishable from a real one.
 */
export declare const rateLimitRefusal: (detail: string, retryAfterSeconds: number, message?: LambderAppRefusalMessage) => LambderApiRefusal;
/**
 * A custom rate-limit key. `apiInput` names the fields of the API's OWN
 * payload the key derives from: the slice is validated against the raw
 * payload before `handler` runs (failures answer like regular input
 * validation, through setApiInputValidationErrorHandler when set) and the
 * handler receives it typed. Referencing the policy from an API whose input
 * schema does not carry those fields is a compile error, so the API's schema
 * stays the single owner of the field. Build with lambderRateLimitKey() so
 * the handler's payload type follows `apiInput`. The context is the
 * adapter's (the render context on the server); the engine reads nothing
 * from it itself.
 *
 * ONE member, with `apiInput` optional, rather than a union of the two
 * shapes: a union with a function member in each arm defeats contextual
 * typing, so annotating a policies map with LambderRateLimitPer or
 * LambderApiRateLimitPolicyConfig left `ctx` implicitly any and the
 * annotation did not compile at all. The builder's overloads are where the
 * apiInput/payload correlation is kept.
 */
export type LambderRateLimitKeyFn<TInput extends z.ZodType = z.ZodType, TCtx = any> = {
    apiInput?: TInput;
    handler: (ctx: TCtx, payload: z.output<TInput>) => string | Promise<string>;
};
/**
 * Builder that ties the handler's payload type to the `apiInput` schema
 * inside one literal. Returns the exact union member so type extraction can
 * see the schema.
 */
export type LambderRateLimitKeyBuilder<TCtx> = {
    <TInput extends z.ZodType>(key: {
        apiInput: TInput;
        handler: (ctx: TCtx, payload: z.output<TInput>) => string | Promise<string>;
    }): {
        apiInput: TInput;
        handler: (ctx: TCtx, payload: z.output<TInput>) => string | Promise<string>;
    };
    (key: {
        handler: (ctx: TCtx, payload: undefined) => string | Promise<string>;
    }): {
        apiInput?: undefined;
        handler: (ctx: TCtx, payload: undefined) => string | Promise<string>;
    };
};
/**
 * A key builder bound to a context type, the counterpart of
 * lambderGuardBuilder. The server's lambderRateLimitKey() is this bound to
 * the render context; the mock runtime binds it to its own call context and
 * exposes it as `rateLimitKey`.
 *
 * Bound rather than left open because the engine hands the handler whatever
 * context the adapter runs on, and the two adapters run on different ones. A
 * single builder pinned to the server's context type compiled against the
 * mock and then handed the handler a context with no `ip`, `method` or
 * `path`, so every caller collapsed onto one counter and the limit a test was
 * written to prove silently proved nothing.
 */
export declare const lambderRateLimitKeyBuilder: <TCtx>() => LambderRateLimitKeyBuilder<TCtx>;
/** What one rate-limit counter tracks: the client IP, the session identity, or a custom payload-derived key. */
export type LambderRateLimitPer<TCtx = any> = "ip" | "session" | LambderRateLimitKeyFn<any, TCtx>;
/**
 * What one budget spans:
 *
 * - "perApi" (default): every API referencing the policy gets its own
 *   counter, so the windows are a per-API ceiling (three APIs referencing a
 *   60/min policy allow one subject 180/min in total). An API may tune the
 *   windows in its declaration: `rateLimit: { name: { perMin: 20 } }`.
 * - "perPolicy": every API referencing the policy shares ONE counter, so the
 *   windows are one combined budget (e.g. one per-email allowance across
 *   send, register, and reset). The policy IS the group: to give user APIs
 *   and report APIs separate shared budgets, declare two policies.
 */
export type LambderRateLimitBudget = "perApi" | "perPolicy";
/**
 * A named rate-limit policy: fixed windows, the key one counter tracks, and
 * what one budget spans.
 *
 * Generic over the context a custom key handler receives, so the adapter's
 * policies map pins it: the server's is the render context, the mock's is the
 * mock call context. Left open, a handler written for one adapter compiled
 * against the other and then read fields that were not there.
 */
export type LambderApiRateLimitPolicyConfig<TCtx = any> = LambderRateLimitPolicy & {
    per: LambderRateLimitPer<TCtx>;
    /** Whether the windows are a per-API ceiling (default) or one budget shared by every referencing API. See LambderRateLimitBudget. */
    budget?: LambderRateLimitBudget;
    /** Envelope errorMessage for refused requests; inherits code "lambder/rate-limited" unless it sets its own. Default: a warning saying too many requests. */
    errorMessage?: LambderAppRefusalMessage;
};
export type LambderApiRateLimitsConfig<TPolicies extends Record<string, LambderApiRateLimitPolicyConfig<any>>> = {
    /** Your limiter instance (LambderDdbRateLimiter, LambderMemoryRateLimiter, or your own); its table and keyPrefix apply as configured on it. */
    limiter: LambderRateLimiter;
    /** Named policies referenced (typed) from addApi/addSessionApi. */
    policies: TPolicies;
    /**
     * Let the request through when the limiter itself fails (the table is
     * down, an IAM action is missing), instead of failing the request.
     * Default: true, and the failure is logged either way.
     *
     * It lives here rather than on a limiter implementation because it is a
     * decision about the REQUEST, not about a store: a custom limiter had no
     * fail-open at all, and two limiters could answer the same outage
     * differently. Set it to false on an app where an unmetered request is
     * worse than a refused one.
     */
    failOpen?: boolean;
};
/**
 * Policy names an API may reference: session-keyed policies only on session
 * APIs, and apiInput-keyed policies only when the API's payload carries the
 * key's fields.
 */
export type LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession extends boolean> = {
    [K in keyof TPolicies]: TPolicies[K] extends {
        per: "session";
    } ? (TIncludeSession extends true ? K : never) : TPolicies[K] extends {
        per: {
            apiInput: infer S extends z.ZodType;
        };
    } ? (TPayload extends z.output<S> ? K : never) : K;
}[keyof TPolicies] & string;
type LambderRateLimitOverrideFor<TPolicy> = TPolicy extends {
    budget: "perPolicy";
} ? Pick<LambderRateLimitOverride, "errorMessage"> : LambderRateLimitOverride;
/** The map form's full shape: every referable policy name, each carrying its own override. */
type LambderRateLimitMap<TPolicies, TPayload, TIncludeSession extends boolean> = {
    readonly [K in LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession> & keyof TPolicies]?: true | LambderRateLimitOverrideFor<TPolicies[K]>;
};
/**
 * The per-API `rateLimit` option: one policy name, a non-empty ordered list
 * of names, or a non-empty object map that can carry each policy's override
 * (`true` applies the policy as declared). Map entries are checked in
 * insertion order.
 *
 * Every form is non-empty by construction, the same machinery the guards
 * option uses (LambderNonEmptyOptionMap): `rateLimit: {}`, `rateLimit: []`
 * and `rateLimit: { policy: undefined }` announce a limit and enforce none.
 */
export type LambderRateLimitOption<TPolicies, TPayload, TIncludeSession extends boolean> = LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession> | readonly [
    LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>,
    ...LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>[]
] | LambderNonEmptyOptionMap<LambderRateLimitMap<TPolicies, TPayload, TIncludeSession>>;
/**
 * When in a call a policy can be checked. A `per: "ip"` counter is known from
 * the request alone, so it runs before the session read and bounds how often
 * one address may make the session store look a token up. Everything else
 * runs after: `per: "session"` needs the session, and a custom key handler is
 * app code that may read ctx.session too.
 */
type LambderRateLimitPhase = "beforeSession" | "afterSession";
/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPolicyEngine. Reads the request's ip and the context's session
 * and nothing else, so it runs unchanged under the server and the mock
 * runtime.
 */
export declare class LambderApiRateLimitsEngine {
    private limiter;
    private failOpen;
    private policies;
    /** True once rateLimits were configured. */
    get isConfigured(): boolean;
    configure(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void;
    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName: string, mode: LambderApiMode, rateLimitOption?: LambderRateLimitOptionValue): void;
    /**
     * Check the API's policies in declared order; the first exceeded one
     * refuses with a 429 envelope and a Retry-After header. Attempts count,
     * not successes: every counter checked before the refusing one (and every
     * counter, when a later guard or validation refuses) keeps its increment,
     * so list first the policy you want charged on refusals.
     *
     * Run twice per call, once per phase: the policies whose key needs no
     * session are checked BEFORE the session is read, so a flood of requests
     * carrying bogus session cookies is refused without touching the session
     * store; the rest are checked after it, since `per: "session"` and a
     * custom key handler may both read ctx.session. Declared order is kept
     * inside each phase.
     */
    run(apiName: string, request: LambderApiRequest, ctx: LambderApiCallContext, rateLimitOption: LambderRateLimitOptionValue | undefined, phase: LambderRateLimitPhase): Promise<void>;
    private resolveKey;
}
export {};

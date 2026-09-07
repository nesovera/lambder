import type { z } from "zod";
import type { LambderRenderContext } from "../core/LambderContext.js";
import type LambderResolver from "../core/LambderResolver.js";
import { type LambderRateLimitPolicy, type LambderDdbRateLimiter } from "../stores/LambderDdbRateLimiter.js";
import { type LambderRefusalMessage } from "../shared/LambderApiError.js";
import { type LambderInputValidationRefusal } from "./LambderApiGuards.js";
/**
 * A custom rate-limit key. `apiInput` names the fields of the API's OWN
 * payload the key derives from: the slice is validated against the raw
 * payload before `handler` runs (failures answer like regular input
 * validation, through setApiInputValidationErrorHandler when set) and the
 * handler receives it typed. Referencing the policy from an API whose input
 * schema does not carry those fields is a compile error, so the API's schema
 * stays the single owner of the field. Build with lambderRateLimitKey() so
 * the handler's payload type follows `apiInput`.
 */
export type LambderRateLimitKeyFn<TInput extends z.ZodTypeAny = z.ZodTypeAny> = {
    apiInput: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string>;
} | {
    apiInput?: undefined;
    handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string>;
};
/**
 * Builder that ties the handler's payload type to the `apiInput` schema
 * inside one literal. Returns the exact union member so type extraction can
 * see the schema.
 */
export declare function lambderRateLimitKey<TInput extends z.ZodTypeAny>(key: {
    apiInput: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string>;
}): {
    apiInput: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string>;
};
export declare function lambderRateLimitKey(key: {
    handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string>;
}): {
    apiInput?: undefined;
    handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string>;
};
/** What one rate-limit counter tracks: the client IP, the session identity, or a custom payload-derived key. */
export type LambderRateLimitPer = "ip" | "session" | LambderRateLimitKeyFn<any>;
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
/** A named rate-limit policy: fixed windows, the key one counter tracks, and what one budget spans. */
export type LambderApiRateLimitPolicyConfig = LambderRateLimitPolicy & {
    per: LambderRateLimitPer;
    /** Whether the windows are a per-API ceiling (default) or one budget shared by every referencing API. See LambderRateLimitBudget. */
    budget?: LambderRateLimitBudget;
    /** Envelope errorMessage for refused requests; inherits code "lambder/rate-limited" unless it sets its own. Default: a warning saying too many requests. */
    errorMessage?: LambderRefusalMessage;
};
export type LambderApiRateLimitsConfig<TPolicies extends Record<string, LambderApiRateLimitPolicyConfig>> = {
    /** Your limiter instance; its table, keyPrefix and failOpen apply as configured on it. */
    limiter: LambderDdbRateLimiter;
    /** Named policies referenced (typed) from addApi/addSessionApi. */
    policies: TPolicies;
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
            apiInput: infer S extends z.ZodTypeAny;
        };
    } ? (TPayload extends z.output<S> ? K : never) : K;
}[keyof TPolicies] & string;
/**
 * What an API may override on a policy it references, in the map form of the
 * rateLimit option. Windows merge over the policy's own (a tighter burst keeps
 * the policy's daily cap) and are only overridable on "perApi" budgets: a
 * shared counter has one set of numbers. errorMessage is per-API text, so it
 * is overridable on either budget.
 */
export type LambderRateLimitOverride = LambderRateLimitPolicy & {
    errorMessage?: LambderRefusalMessage;
};
type LambderRateLimitOverrideFor<TPolicy> = TPolicy extends {
    budget: "perPolicy";
} ? Pick<LambderRateLimitOverride, "errorMessage"> : LambderRateLimitOverride;
/**
 * The per-API `rateLimit` option: one policy name, an ordered list of names,
 * or an object map that can carry each policy's override (`true` applies the
 * policy as declared). Map entries are checked in insertion order.
 */
export type LambderRateLimitOption<TPolicies, TPayload, TIncludeSession extends boolean> = LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession> | readonly LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>[] | {
    readonly [K in LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession> & keyof TPolicies]?: true | LambderRateLimitOverrideFor<TPolicies[K]>;
};
/** The rateLimit option's runtime shape: a name, ordered names, or a name-to-override map (LambderRateLimitOption narrows the names and overrides per policy). */
export type LambderRateLimitOptionValue = string | readonly string[] | Readonly<Record<string, true | LambderRateLimitOverride | undefined>>;
/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPolicyEngine.
 */
export declare class LambderApiRateLimitsEngine {
    private readonly onInvalidInput;
    private limiter;
    private policies;
    constructor(onInvalidInput: LambderInputValidationRefusal);
    configure(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void;
    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName: string, mode: "public" | "session", rateLimitOption?: LambderRateLimitOptionValue): void;
    /**
     * Check the API's policies in declared order; the first exceeded one
     * refuses with a 429 envelope and a Retry-After header. Attempts count,
     * not successes: every counter checked before the refusing one (and every
     * counter, when a later guard or validation refuses) keeps its increment,
     * so list first the policy you want charged on refusals.
     */
    run(apiName: string, ctx: LambderRenderContext, resolver: LambderResolver, rateLimitOption?: LambderRateLimitOptionValue): Promise<void>;
    private resolveKey;
}
export {};

import type { z } from "zod";
import type { LambderRenderContext } from "../core/LambderContext.js";
import type LambderResolver from "../core/LambderResolver.js";
import { RATE_LIMIT_WINDOWS, type LambderRateLimitPolicy, type LambderRateLimitWindow, type LambderDdbRateLimiter } from "../stores/LambderDdbRateLimiter.js";
import { LambderApiError, LAMBDER_REFUSAL_CODES, type LambderRefusalMessage } from "../shared/LambderApiError.js";
import { parsePreflightSlice, type LambderInputValidationRefusal } from "./LambderApiGuards.js";

const RATE_LIMIT_WINDOW_KEYS: readonly LambderRateLimitWindow[] = RATE_LIMIT_WINDOWS.map((window) => window.key);

/** Refusal a rate-limited request answers unless the policy or the API's override names its own. */
const DEFAULT_RATE_LIMIT_REFUSAL = { type: "warning", code: LAMBDER_REFUSAL_CODES.rateLimited, content: "Too many requests. Please try again later." } satisfies LambderRefusalMessage;

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
export type LambderRateLimitKeyFn<TInput extends z.ZodType = z.ZodType> =
    | { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> }
    | { apiInput?: undefined; handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> };

/**
 * Builder that ties the handler's payload type to the `apiInput` schema
 * inside one literal. Returns the exact union member so type extraction can
 * see the schema.
 */
export function lambderRateLimitKey<TInput extends z.ZodType>(key: { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> }): { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> };
export function lambderRateLimitKey(key: { handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> }): { apiInput?: undefined; handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> };
export function lambderRateLimitKey(key: LambderRateLimitKeyFn<any>): LambderRateLimitKeyFn<any> { return key; }

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
    [K in keyof TPolicies]:
        TPolicies[K] extends { per: "session" }
            ? (TIncludeSession extends true ? K : never)
            : TPolicies[K] extends { per: { apiInput: infer S extends z.ZodType } }
                ? (TPayload extends z.output<S> ? K : never)
                : K
}[keyof TPolicies] & string;

/**
 * What an API may override on a policy it references, in the map form of the
 * rateLimit option. Windows merge over the policy's own (a tighter burst keeps
 * the policy's daily cap) and are only overridable on "perApi" budgets: a
 * shared counter has one set of numbers. errorMessage is per-API text, so it
 * is overridable on either budget.
 */
export type LambderRateLimitOverride = LambderRateLimitPolicy & { errorMessage?: LambderRefusalMessage };

type LambderRateLimitOverrideFor<TPolicy> =
    TPolicy extends { budget: "perPolicy" } ? Pick<LambderRateLimitOverride, "errorMessage"> : LambderRateLimitOverride;

/**
 * The per-API `rateLimit` option: one policy name, an ordered list of names,
 * or an object map that can carry each policy's override (`true` applies the
 * policy as declared). Map entries are checked in insertion order.
 */
export type LambderRateLimitOption<TPolicies, TPayload, TIncludeSession extends boolean> =
    | LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>
    | readonly LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>[]
    | { readonly [K in LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession> & keyof TPolicies]?: true | LambderRateLimitOverrideFor<TPolicies[K]> };

/** The rateLimit option's runtime shape: a name, ordered names, or a name-to-override map (LambderRateLimitOption narrows the names and overrides per policy). */
export type LambderRateLimitOptionValue = string | readonly string[] | Readonly<Record<string, true | LambderRateLimitOverride | undefined>>;

type LambderRateLimitEntry = { name: string, override?: LambderRateLimitOverride };

/** Normalize the three rateLimit-option forms into ordered entries; an explicit `undefined` map value declares nothing. */
const toRateLimitEntries = (value?: LambderRateLimitOptionValue): LambderRateLimitEntry[] => {
    if(value === undefined) return [];
    if(typeof value === "string") return [{ name: value }];
    if(Array.isArray(value)) return value.map((name: string) => ({ name }));
    return Object.entries(value).flatMap(([name, override]): LambderRateLimitEntry[] =>
        override === undefined ? [] : override === true ? [{ name }] : [{ name, override }]);
};

const hasWindowOverride = (override: LambderRateLimitOverride): boolean =>
    RATE_LIMIT_WINDOW_KEYS.some((key) => override[key] !== undefined);

/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPolicyEngine.
 */
export class LambderApiRateLimitsEngine {
    private limiter: LambderDdbRateLimiter | null = null;
    private policies: Record<string, LambderApiRateLimitPolicyConfig> = {};

    constructor(private readonly onInvalidInput: LambderInputValidationRefusal){}

    configure(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void {
        if(this.limiter) throw new Error("Lambder: rateLimits were already configured.");
        for(const [name, policy] of Object.entries(config.policies)){
            const per = policy.per as LambderRateLimitPer | undefined;
            if(!per || (per !== "ip" && per !== "session" && typeof per.handler !== "function")){
                throw new Error(`Lambder: rate-limit policy "${name}" needs per: "ip", "session", or a { apiInput?, handler } key.`);
            }
            if(!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])){
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
            const budget = policy.budget as LambderRateLimitBudget | undefined;
            if(budget !== undefined && budget !== "perApi" && budget !== "perPolicy"){
                throw new Error(`Lambder: rate-limit policy "${name}" has budget "${String(budget)}"; use "perApi" (default: each referencing API counts separately) or "perPolicy" (one counter shared by every referencing API).`);
            }
        }
        this.limiter = config.limiter;
        this.policies = { ...config.policies };
    }

    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName: string, mode: "public" | "session", rateLimitOption?: LambderRateLimitOptionValue): void {
        for(const { name, override } of toRateLimitEntries(rateLimitOption)){
            const policy = this.policies[name];
            if(!policy){
                throw new Error(`Lambder: API "${apiName}" references unknown rate-limit policy "${name}". Declare it in the rateLimits option at creation.`);
            }
            if(policy.per === "session" && mode !== "session"){
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which requires addSessionApi.`);
            }
            if(override && policy.budget === "perPolicy" && hasWindowOverride(override)){
                throw new Error(`Lambder: API "${apiName}" overrides the windows of rate-limit policy "${name}", whose budget is "perPolicy": one counter shared by every referencing API has one set of limits. Declare a separate policy instead.`);
            }
        }
    }

    /**
     * Check the API's policies in declared order; the first exceeded one
     * refuses with a 429 envelope and a Retry-After header. Attempts count,
     * not successes: every counter checked before the refusing one (and every
     * counter, when a later guard or validation refuses) keeps its increment,
     * so list first the policy you want charged on refusals.
     */
    async run(apiName: string, ctx: LambderRenderContext, resolver: LambderResolver, rateLimitOption?: LambderRateLimitOptionValue): Promise<void> {
        for(const { name, override } of toRateLimitEntries(rateLimitOption)){
            const policy = this.policies[name];
            if(!policy || !this.limiter) throw new Error(`Lambder: rate-limit policy "${name}" is not configured.`);
            const key = await this.resolveKey(ctx, resolver, policy.per);
            // "perPolicy" shares one counter across every API referencing the
            // policy; "perApi" keys each API separately, which is also what
            // lets an API override the windows without colliding.
            const trackerKey = policy.budget === "perPolicy"
                ? `policy|${name}|${key}`
                : `api|${apiName}|${name}|${key}`;
            const limits: LambderRateLimitPolicy = {};
            for(const windowKey of RATE_LIMIT_WINDOW_KEYS){
                const limit = override?.[windowKey] ?? policy[windowKey];
                if(limit !== undefined) limits[windowKey] = limit;
            }
            const exceeded = await this.limiter.isRateLimited(trackerKey, limits);
            if(exceeded){
                const retryAfterSeconds = Math.max(1, exceeded.resetAt - Math.floor(Date.now() / 1000));
                // A policy's (or override's) own message inherits the framework
                // code unless it sets a more specific one of its own.
                const message = override?.errorMessage ?? policy.errorMessage;
                throw new LambderApiError(`Rate limited: "${apiName}" exceeded policy "${name}" (${exceeded.window}: ${exceeded.limit}).`, {
                    errorMessage: message ? { code: LAMBDER_REFUSAL_CODES.rateLimited, ...message } satisfies LambderRefusalMessage : DEFAULT_RATE_LIMIT_REFUSAL,
                    statusCode: 429,
                    headers: { "Retry-After": String(retryAfterSeconds) },
                });
            }
        }
    }

    private async resolveKey(ctx: LambderRenderContext, resolver: LambderResolver, per: LambderRateLimitPer): Promise<string> {
        if(per === "ip") return `ip:${ctx.ip}`;
        if(per === "session"){
            const sessionKey = (ctx.session as { sessionKey?: string } | null)?.sessionKey;
            if(!sessionKey) throw new Error('Lambder: rate-limit per "session" evaluated without a session on the context.');
            return `session:${sessionKey}`;
        }
        const payload = per.apiInput
            ? await parsePreflightSlice(per.apiInput, (ctx.post as Record<string, unknown> | undefined)?.payload, ctx, resolver, this.onInvalidInput)
            : undefined;
        return `custom:${await per.handler(ctx, payload as never)}`;
    }
}

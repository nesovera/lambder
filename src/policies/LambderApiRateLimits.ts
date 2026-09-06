import type { z } from "zod";
import type { LambderRenderContext } from "../core/LambderContext.js";
import type LambderResolver from "../core/LambderResolver.js";
import type { LambderRateLimitPolicy, LambderDdbRateLimiter } from "../stores/LambderDdbRateLimiter.js";
import { LambderApiError } from "../shared/LambderApiError.js";
import { parsePreflightSlice } from "./LambderApiGuards.js";

const RATE_LIMIT_WINDOW_KEYS: (keyof LambderRateLimitPolicy)[] = ["perMin", "per10Min", "perHour", "perDay", "perWeek", "perMonth"];

/**
 * A custom rate-limit key. `apiInput` names the fields of the API's OWN
 * payload the key derives from: the slice is validated against the raw
 * payload before `handler` runs (failures answer the standard 422 validation
 * shape) and the handler receives it typed. Referencing the policy from an
 * API whose input schema does not carry those fields is a compile error, so
 * the API's schema stays the single owner of the field. Build with
 * lambderRateLimitKey() so the handler's payload type follows `apiInput`.
 */
export type LambderRateLimitKeyFn<TInput extends z.ZodTypeAny = z.ZodTypeAny> =
    | { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> }
    | { apiInput?: undefined; handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> };

/**
 * Builder that ties the handler's payload type to the `apiInput` schema
 * inside one literal. Returns the exact union member so type extraction can
 * see the schema.
 */
export function lambderRateLimitKey<TInput extends z.ZodTypeAny>(key: { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> }): { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> };
export function lambderRateLimitKey(key: { handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> }): { apiInput?: undefined; handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> };
export function lambderRateLimitKey(key: LambderRateLimitKeyFn<any>): LambderRateLimitKeyFn<any> { return key; }

/** What one rate-limit counter tracks: the client IP, the session identity, or a custom payload-derived key. */
export type LambderRateLimitPer = "ip" | "session" | LambderRateLimitKeyFn<any>;

/** A named rate-limit policy: fixed windows plus the key one counter tracks. */
export type LambderApiRateLimitPolicyConfig = LambderRateLimitPolicy & {
    per: LambderRateLimitPer;
    /**
     * What one counter spans. "api" (default): each API referencing the
     * policy gets its own counter, so the windows are a per-API budget.
     * "policy": every API referencing the policy shares one counter, so the
     * windows are one combined budget (e.g. one per-email allowance across
     * send, register, and reset endpoints).
     */
    scope?: "api" | "policy";
    /** Envelope errorMessage for refused requests. Default: a generic too-many-requests message. */
    errorMessage?: any;
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
            : TPolicies[K] extends { per: { apiInput: infer S extends z.ZodTypeAny } }
                ? (TPayload extends z.output<S> ? K : never)
                : K
}[keyof TPolicies] & string;

const toList = (value?: string | readonly string[]): readonly string[] =>
    value === undefined ? [] : typeof value === "string" ? [value] : value;

/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPolicyEngine.
 */
export class LambderApiRateLimitsEngine {
    private limiter: LambderDdbRateLimiter | null = null;
    private policies: Record<string, LambderApiRateLimitPolicyConfig> = {};

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
        }
        this.limiter = config.limiter;
        this.policies = { ...config.policies };
    }

    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName: string, mode: "public" | "session", rateLimitOption?: string | readonly string[]): void {
        for(const name of toList(rateLimitOption)){
            const policy = this.policies[name];
            if(!policy){
                throw new Error(`Lambder: API "${apiName}" references unknown rate-limit policy "${name}". Declare it in the rateLimits option at creation.`);
            }
            if(policy.per === "session" && mode !== "session"){
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which requires addSessionApi.`);
            }
        }
    }

    /** Check the API's policies in declared order; the first exceeded one refuses with a 429 envelope. */
    async run(apiName: string, ctx: LambderRenderContext, resolver: LambderResolver, rateLimitOption?: string | readonly string[]): Promise<void> {
        for(const name of toList(rateLimitOption)){
            const policy = this.policies[name];
            if(!policy || !this.limiter) throw new Error(`Lambder: rate-limit policy "${name}" is not configured.`);
            const key = await this.resolveKey(ctx, resolver, policy.per);
            // scope "policy" shares one counter across every API referencing
            // the policy; the default gives each API its own budget.
            const trackerKey = policy.scope === "policy"
                ? `policy|${name}|${key}`
                : `api|${apiName}|${name}|${key}`;
            const limited = await this.limiter.isRateLimited(trackerKey, policy);
            if(limited){
                throw new LambderApiError(`Rate limited: "${apiName}" exceeded policy "${name}".`, {
                    errorMessage: policy.errorMessage ?? "Too many requests. Please try again later.",
                    statusCode: 429,
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
            ? parsePreflightSlice(per.apiInput, (ctx.post as Record<string, unknown> | undefined)?.payload, resolver)
            : undefined;
        return `custom:${await per.handler(ctx, payload as never)}`;
    }
}

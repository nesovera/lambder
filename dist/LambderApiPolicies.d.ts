import type { LambderRenderContext } from "./LambderContext.js";
import type LambderResolver from "./LambderResolver.js";
import type { LambderRateLimitPolicy, LambderDdbRateLimiter } from "./LambderDdbRateLimiter.js";
import type { LambderDdbIdempotency } from "./LambderDdbIdempotency.js";
import { LambderResponse } from "./LambderResponse.js";
/**
 * What one rate-limit counter tracks: the client IP, the session identity, or
 * a custom key derived from the request (e.g. a normalized email). Custom
 * functions run before input validation, so they read the raw payload.
 */
export type LambderRateLimitPer = "ip" | "session" | ((ctx: LambderRenderContext) => string | Promise<string>);
/** A named rate-limit policy: fixed windows plus the key one counter tracks. */
export type LambderApiRateLimitPolicyConfig = LambderRateLimitPolicy & {
    per: LambderRateLimitPer;
    /** Envelope errorMessage for refused requests. Default: a generic too-many-requests message. */
    errorMessage?: any;
};
export type LambderApiRateLimitsConfig<TPolicies extends Record<string, LambderApiRateLimitPolicyConfig>> = {
    /** Your limiter instance; its table, keyPrefix and failOpen apply as configured on it. */
    limiter: LambderDdbRateLimiter;
    /** Named policies referenced (typed) from addApi/addSessionApi. */
    policies: TPolicies;
};
export type LambderApiIdempotencyConfig = {
    /** Your idempotency store instance; may share the rate limiter's table (distinct key prefix). */
    store: LambderDdbIdempotency;
    /** Seconds a stored response replays for. Default: 86400 (24h). Per-API override: idempotency: { ttlSeconds }. */
    defaultTtlSeconds?: number;
    /** Skip idempotency (execute normally) when DynamoDB errors, instead of failing the request. Default: true. */
    failOpen?: boolean;
};
/**
 * A named guard, run before input validation. Refuse by throwing (typically a
 * LambderApiError, or res.die.*); return normally to let the request through.
 * ctx.apiPayload is unvalidated at this point.
 */
export type LambderApiGuardFunction = (ctx: LambderRenderContext, res: LambderResolver) => void | Promise<void>;
/** Names of policies usable on public APIs: everything not keyed per "session". */
export type LambderPublicRateLimitNames<TPolicies> = {
    [K in keyof TPolicies]: TPolicies[K] extends {
        per: "session";
    } ? never : K;
}[keyof TPolicies] & string;
/** Declarative per-API options carried in the addApi/addSessionApi schema object. */
export type LambderApiRegistrationOptions<TRateLimitName extends string, TGuardName extends string, TIdempotencyEnabled extends boolean> = {
    /** Named rate limits, checked in declared order before guards and validation; the first exceeded one refuses (429 envelope). */
    rateLimit?: TRateLimitName | readonly TRateLimitName[];
    /** Named guards, run in declared order before input validation; refuse by throwing. */
    guards?: TGuardName | readonly TGuardName[];
    /** Replay-protect this API per client idempotencyKey. Requires enableApiIdempotency() first. */
    idempotency?: TIdempotencyEnabled extends true ? (boolean | {
        ttlSeconds?: number;
    }) : never;
};
/**
 * Runtime side of the declarative API options: holds what the enable/define
 * calls declared, asserts registrations against it at startup, and executes
 * rate limits, guards, and idempotency around handlers at request time.
 * Internal to Lambder; apps interact through enableApiRateLimits(),
 * enableApiIdempotency(), defineApiGuards() and the per-API options.
 */
export declare class LambderApiPolicyEngine {
    private limiter;
    private rateLimitPolicies;
    private guards;
    private idempotencyStore;
    private idempotencyDefaultTtlSeconds;
    private idempotencyFailOpen;
    setRateLimits(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void;
    addGuards(guards: Record<string, LambderApiGuardFunction>): void;
    setIdempotency(config: LambderApiIdempotencyConfig): void;
    /** Startup validation of one API registration's declarative options. */
    assertRegistration(apiName: string, mode: "public" | "session", options: {
        rateLimit?: string | readonly string[];
        guards?: string | readonly string[];
        idempotency?: unknown;
    }): void;
    /** Rate limits then guards, in declared order. Refusals throw (LambderApiError or a guard's own throw). */
    runPreflight(apiName: string, ctx: LambderRenderContext, resolver: LambderResolver, options: {
        rateLimit?: string | readonly string[];
        guards?: string | readonly string[];
    }): Promise<void>;
    private resolveRateLimitKey;
    /**
     * Idempotency wrapper around validation-passed handler execution. Without
     * a client idempotencyKey the handler just runs; with one, the scope
     * (identity + api + key) is claimed atomically: duplicates of an
     * in-flight original refuse with 409, replays of a completed one return
     * the stored response verbatim, and a crashed original releases its claim
     * so a retry actually retries.
     */
    withIdempotency(apiName: string, ctx: LambderRenderContext, config: boolean | {
        ttlSeconds?: number;
    }, exec: () => Promise<LambderResponse>): Promise<LambderResponse>;
}

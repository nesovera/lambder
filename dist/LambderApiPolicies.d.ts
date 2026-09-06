import type { z } from "zod";
import type { LambderRenderContext } from "./LambderContext.js";
import type LambderResolver from "./LambderResolver.js";
import type { LambderRateLimitPolicy, LambderDdbRateLimiter } from "./LambderDdbRateLimiter.js";
import type { LambderDdbIdempotency } from "./LambderDdbIdempotency.js";
import { LambderResponse } from "./LambderResponse.js";
/**
 * A custom rate-limit key: `input` names the payload fields the key needs.
 * The slice is validated against the raw payload before `handler` runs (a
 * failure answers the standard 422 validation shape), and the requirement is
 * merged into the contract input of every API that references the policy, so
 * clients are forced by the compiler to send those fields. Build with
 * lambderRateLimitKey() so the handler's payload type follows `input`.
 */
export type LambderRateLimitKeyFn<TInput extends z.ZodTypeAny = z.ZodTypeAny> = {
    input: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string>;
} | {
    input?: undefined;
    handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string>;
};
/**
 * Builder that ties the handler's payload type to the `input` schema inside
 * one literal. Returns the exact union member (not the union), so requirement
 * extraction can see the `input` type.
 */
export declare function lambderRateLimitKey<TInput extends z.ZodTypeAny>(key: {
    input: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string>;
}): {
    input: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string>;
};
export declare function lambderRateLimitKey(key: {
    handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string>;
}): {
    input?: undefined;
    handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string>;
};
/** What one rate-limit counter tracks: the client IP, the session identity, or a custom payload-derived key. */
export type LambderRateLimitPer = "ip" | "session" | LambderRateLimitKeyFn<any>;
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
 * A named guard, run before the API's own input validation. `input` names the
 * payload fields the guard requires: the slice is validated against the raw
 * payload before `handler` runs (a failure answers the standard 422
 * validation shape), the handler receives it typed, and the requirement is
 * merged into the contract input of every API that declares the guard, so
 * clients are forced by the compiler to send those fields. The handler
 * refuses by throwing (typically refuse()/LambderApiError). Build with
 * lambderGuard() so the handler's payload type follows `input`.
 */
export type LambderApiGuard<TInput extends z.ZodTypeAny = z.ZodTypeAny> = {
    input: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
} | {
    input?: undefined;
    handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void>;
};
/**
 * Builder that ties the handler's payload type to the `input` schema inside
 * one literal. Returns the exact union member (not the union), so requirement
 * extraction can see the `input` type.
 */
export declare function lambderGuard<TInput extends z.ZodTypeAny>(guard: {
    input: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
}): {
    input: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
};
export declare function lambderGuard(guard: {
    handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void>;
}): {
    input?: undefined;
    handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void>;
};
/** Names of policies usable on public APIs: everything not keyed per "session". */
export type LambderPublicRateLimitNames<TPolicies> = {
    [K in keyof TPolicies]: TPolicies[K] extends {
        per: "session";
    } ? never : K;
}[keyof TPolicies] & string;
/** Payload fields a guard requires; {} when it declares no input. */
export type LambderGuardPayload<G> = G extends {
    input: infer S extends z.ZodTypeAny;
} ? z.output<S> : {};
/** Guard name to required-payload map, accumulated on the Lambder instance by defineApiGuards. */
export type LambderGuardPayloadMap<TGuards> = {
    [K in keyof TGuards]: LambderGuardPayload<TGuards[K]>;
};
/** Payload fields a policy's custom key requires; {} for "ip"/"session" or keys with no input. */
export type LambderPolicyPayload<P> = P extends {
    per: {
        input: infer S extends z.ZodTypeAny;
    };
} ? z.output<S> : {};
type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type NamesIn<TOpt> = TOpt extends readonly (infer N extends string)[] ? N : TOpt extends string ? TOpt : never;
/** Intersection of the payload requirements of the referenced guards; never when none are declared. */
export type LambderGuardsRequirement<TGuardPayloads, TOpt> = [
    NamesIn<TOpt>
] extends [never] ? never : UnionToIntersection<TGuardPayloads[Extract<NamesIn<TOpt>, keyof TGuardPayloads>]>;
/** Intersection of the payload requirements of the referenced rate-limit policies; never when none are declared. */
export type LambderPoliciesRequirement<TPolicies, TOpt> = [
    NamesIn<TOpt>
] extends [never] ? never : UnionToIntersection<LambderPolicyPayload<TPolicies[Extract<NamesIn<TOpt>, keyof TPolicies>]>>;
/** Contract-input merge: the API's own input plus everything its rate limits and guards force clients to send. */
export type LambderMergedInput<TIn, TReqA, TReqB> = ([TReqA] extends [never] ? TIn : TIn & TReqA) extends infer TMid ? ([TReqB] extends [never] ? TMid : TMid & TReqB) : never;
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
    addGuards(guards: Record<string, LambderApiGuard<any>>): void;
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
    /**
     * Validate a preflight input slice against the raw payload. Runs before
     * the API's own validation, so guard/key requirements hold even when the
     * API schema does not declare (and would strip) those fields. Failures
     * answer the same 422 shape as regular input validation.
     */
    private parseSlice;
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
export {};

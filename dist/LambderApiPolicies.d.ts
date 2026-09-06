import type { z } from "zod";
import type { LambderRenderContext } from "./LambderContext.js";
import type LambderResolver from "./LambderResolver.js";
import type { LambderRateLimitPolicy, LambderDdbRateLimiter } from "./LambderDdbRateLimiter.js";
import type { LambderDdbIdempotency } from "./LambderDdbIdempotency.js";
import { LambderResponse } from "./LambderResponse.js";
/**
 * A custom rate-limit key. `apiInput` names the fields of the API's OWN
 * payload the key derives from: the slice is validated against the raw
 * payload before `handler` runs (failures answer the standard 422 validation
 * shape) and the handler receives it typed. Referencing the policy from an
 * API whose input schema does not carry those fields is a compile error, so
 * the API's schema stays the single owner of the field. Build with
 * lambderRateLimitKey() so the handler's payload type follows `apiInput`.
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
 * A named guard, run before the API's own input validation. Two modes:
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
 *
 * Either way a validation failure answers the standard 422 shape, and the
 * handler refuses by throwing (typically refuse()/LambderApiError). Build
 * with lambderGuard() so the handler's payload type follows the schema.
 */
export type LambderApiGuard<TInput extends z.ZodTypeAny = z.ZodTypeAny> = {
    apiInput: TInput;
    guardInput?: undefined;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
} | {
    guardInput: TInput;
    apiInput?: undefined;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
} | {
    apiInput?: undefined;
    guardInput?: undefined;
    handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void>;
};
/**
 * Builder that ties the handler's payload type to the schema inside one
 * literal. Returns the exact union member so mode/type extraction works.
 */
export declare function lambderGuard<TInput extends z.ZodTypeAny>(guard: {
    apiInput: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
}): {
    apiInput: TInput;
    guardInput?: undefined;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
};
export declare function lambderGuard<TInput extends z.ZodTypeAny>(guard: {
    guardInput: TInput;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
}): {
    guardInput: TInput;
    apiInput?: undefined;
    handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void>;
};
export declare function lambderGuard(guard: {
    handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void>;
}): {
    apiInput?: undefined;
    guardInput?: undefined;
    handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void>;
};
/** Per-guard metadata carried on the Lambder instance: mode plus payload type. */
export type LambderGuardMeta<G> = G extends {
    apiInput: infer S extends z.ZodTypeAny;
} ? {
    apiInput: z.output<S>;
} : G extends {
    guardInput: infer S extends z.ZodTypeAny;
} ? {
    guardInput: z.output<S>;
} : {};
export type LambderGuardMetaMap<TGuards> = {
    [K in keyof TGuards]: LambderGuardMeta<TGuards[K]>;
};
type NamesIn<TOpt> = TOpt extends readonly (infer N extends string)[] ? N : TOpt extends string ? TOpt : never;
/** Guard names an API may declare: apiInput-mode guards only when the API's payload carries their fields. */
export type LambderAllowedGuardNames<TGuards, TPayload> = {
    [K in keyof TGuards]: TGuards[K] extends {
        apiInput: infer R;
    } ? (TPayload extends R ? K : never) : K;
}[keyof TGuards] & string;
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
type GuardInputsEntries<TGuards, TOpt> = {
    [K in Extract<NamesIn<TOpt>, keyof TGuards> as TGuards[K] extends {
        guardInput: any;
    } ? K : never]: TGuards[K] extends {
        guardInput: infer V;
    } ? V : never;
};
/** The guardInputs map an API's contract requires clients to send; never when no declared guard uses guardInput mode. */
export type LambderGuardInputsOf<TGuards, TOpt> = keyof GuardInputsEntries<TGuards, TOpt> extends never ? never : GuardInputsEntries<TGuards, TOpt>;
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
     * Validate a preflight input slice (an apiInput slice of the raw payload,
     * or a guardInput value from the raw guardInputs map). Runs before the
     * API's own validation; failures answer the same 422 shape as regular
     * input validation.
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

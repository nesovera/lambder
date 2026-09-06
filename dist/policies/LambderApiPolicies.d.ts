import type { LambderRenderContext } from "../core/LambderContext.js";
import type LambderResolver from "../core/LambderResolver.js";
import type { LambderResponse } from "../core/LambderResponse.js";
import { type LambderApiGuard, type LambderGuardsOptionValue } from "./LambderApiGuards.js";
import { type LambderApiRateLimitPolicyConfig, type LambderApiRateLimitsConfig } from "./LambderApiRateLimits.js";
import { type LambderApiIdempotencyConfig } from "./LambderApiIdempotency.js";
/** The declarative options one API registration may carry. */
type LambderApiPolicyOptions = {
    rateLimit?: string | readonly string[];
    guards?: LambderGuardsOptionValue;
    idempotency?: unknown;
};
/**
 * Runtime side of the declarative API options: composes the three policy
 * subsystems (rate limits in ./LambderApiRateLimits.ts, guards in
 * ./LambderApiGuards.ts, idempotency in ./LambderApiIdempotency.ts), asserts
 * registrations against them at startup, and executes them around handlers
 * at request time. Internal to Lambder; apps interact through
 * the create() options (rateLimits, guards, idempotency) and the
 * per-API options.
 */
export declare class LambderApiPolicyEngine {
    private rateLimits;
    private guards;
    private idempotency;
    setRateLimits(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void;
    addGuards(guards: Record<string, LambderApiGuard<any, any, any>>): void;
    setIdempotency(config: LambderApiIdempotencyConfig): void;
    /** Startup validation of one API registration's declarative options. */
    assertRegistration(apiName: string, mode: "public" | "session", options: LambderApiPolicyOptions): void;
    /** Rate limits then guards, in declared order. Refusals throw (LambderApiError or a guard's own throw). */
    runPreflight(apiName: string, ctx: LambderRenderContext, resolver: LambderResolver, options: LambderApiPolicyOptions): Promise<void>;
    /** Idempotency replay fast path, run before the preflight: see LambderApiIdempotencyEngine.findReplay. */
    findReplay(apiName: string, ctx: LambderRenderContext): Promise<LambderResponse | null>;
    /** Idempotency claim/replay wrapper around handler execution: see LambderApiIdempotencyEngine.withIdempotency. */
    withIdempotency(apiName: string, ctx: LambderRenderContext, config: boolean | {
        ttlSeconds?: number;
    }, exec: () => Promise<LambderResponse>): Promise<LambderResponse>;
}
export {};

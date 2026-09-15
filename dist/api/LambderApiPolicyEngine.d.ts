import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext, LambderApiCallTrace } from "./LambderApiCallContext.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
import type { LambderApiDefinition } from "./LambderApiDefinition.js";
import { type LambderApiGuard } from "./LambderApiGuards.js";
import { type LambderApiRateLimitPolicyConfig, type LambderApiRateLimitsConfig } from "./LambderApiRateLimits.js";
import { type LambderApiIdempotencyConfig } from "./LambderApiIdempotency.js";
/**
 * Runtime side of the declarative API options: composes the three policy
 * subsystems (rate limits in ./LambderApiRateLimits.ts, guards in
 * ./LambderApiGuards.ts, idempotency in ./LambderApiIdempotency.ts), asserts
 * registrations against them at startup, and executes them around handlers
 * at request time. Owned by LambderApiPipeline; apps interact through the
 * create() options (rateLimits, guards, idempotency) and the per-API
 * options.
 */
export declare class LambderApiPolicyEngine {
    private rateLimits;
    private guards;
    private idempotency;
    /** True once any of the three subsystems was configured. */
    get isConfigured(): boolean;
    configureRateLimits(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void;
    configureGuards(guards: Record<string, LambderApiGuard<any, any, any>>): void;
    configureIdempotency(config: LambderApiIdempotencyConfig): void;
    /** Startup validation of one API's declarative options. */
    assertRegistration(definition: LambderApiDefinition): void;
    /** The rate-limit policies that can be checked before the session is read: see LambderApiRateLimitsEngine.run. */
    runSessionlessRateLimits(request: LambderApiRequest, ctx: LambderApiCallContext, definition: LambderApiDefinition): Promise<void>;
    /** The remaining rate limits, then guards, in declared order. Refusals throw; the trace records each guard as it runs. */
    runPreflight(request: LambderApiRequest, ctx: LambderApiCallContext, definition: LambderApiDefinition, trace: LambderApiCallTrace): Promise<void>;
    /** Idempotency replay fast path, run before the preflight: see LambderApiIdempotencyEngine.findReplay. */
    findReplay(request: LambderApiRequest, ctx: LambderApiCallContext, definition: LambderApiDefinition, trace: LambderApiCallTrace): Promise<LambderApiAnswer | null>;
    /** Idempotency claim/replay wrapper around handler execution: see LambderApiIdempotencyEngine.withIdempotency. */
    withIdempotency(request: LambderApiRequest, ctx: LambderApiCallContext, definition: LambderApiDefinition, trace: LambderApiCallTrace, exec: () => Promise<LambderApiAnswer>): Promise<LambderApiAnswer>;
}

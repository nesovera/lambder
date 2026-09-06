import type { LambderRenderContext } from "../core/LambderContext.js";
import type LambderResolver from "../core/LambderResolver.js";
import type { LambderResponse } from "../core/LambderResponse.js";
import { LambderApiGuardsEngine, type LambderApiGuard, type LambderGuardsOptionValue } from "./LambderApiGuards.js";
import { LambderApiRateLimitsEngine, type LambderApiRateLimitPolicyConfig, type LambderApiRateLimitsConfig } from "./LambderApiRateLimits.js";
import { LambderApiIdempotencyEngine, type LambderApiIdempotencyConfig } from "./LambderApiIdempotency.js";

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
export class LambderApiPolicyEngine {
    private rateLimits = new LambderApiRateLimitsEngine();
    private guards = new LambderApiGuardsEngine();
    private idempotency = new LambderApiIdempotencyEngine();

    setRateLimits(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void {
        this.rateLimits.configure(config);
    }

    addGuards(guards: Record<string, LambderApiGuard<any, any, any>>): void {
        this.guards.addGuards(guards);
    }

    setIdempotency(config: LambderApiIdempotencyConfig): void {
        this.idempotency.configure(config);
    }

    /** Startup validation of one API registration's declarative options. */
    assertRegistration(apiName: string, mode: "public" | "session", options: LambderApiPolicyOptions): void {
        this.rateLimits.assertRegistration(apiName, mode, options.rateLimit);
        this.guards.assertRegistration(apiName, mode, options.guards);
        if(options.idempotency !== undefined && !this.idempotency.isConfigured){
            throw new Error(`Lambder: API "${apiName}" declares idempotency but no idempotency store was configured at creation.`);
        }
    }

    /** Rate limits then guards, in declared order. Refusals throw (LambderApiError or a guard's own throw). */
    async runPreflight(
        apiName: string,
        ctx: LambderRenderContext,
        resolver: LambderResolver,
        options: LambderApiPolicyOptions,
    ): Promise<void> {
        await this.rateLimits.run(apiName, ctx, resolver, options.rateLimit);
        await this.guards.run(ctx, resolver, options.guards);
    }

    /** Idempotency replay fast path, run before the preflight: see LambderApiIdempotencyEngine.findReplay. */
    async findReplay(apiName: string, ctx: LambderRenderContext): Promise<LambderResponse | null> {
        return await this.idempotency.findReplay(apiName, ctx);
    }

    /** Idempotency claim/replay wrapper around handler execution: see LambderApiIdempotencyEngine.withIdempotency. */
    async withIdempotency(
        apiName: string,
        ctx: LambderRenderContext,
        config: boolean | { ttlSeconds?: number },
        exec: () => Promise<LambderResponse>,
    ): Promise<LambderResponse> {
        return await this.idempotency.withIdempotency(apiName, ctx, config, exec);
    }
}

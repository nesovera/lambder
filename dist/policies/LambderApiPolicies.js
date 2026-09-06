import { LambderApiGuardsEngine } from "./LambderApiGuards.js";
import { LambderApiRateLimitsEngine } from "./LambderApiRateLimits.js";
import { LambderApiIdempotencyEngine } from "./LambderApiIdempotency.js";
/**
 * Runtime side of the declarative API options: composes the three policy
 * subsystems (rate limits in ./LambderApiRateLimits.ts, guards in
 * ./LambderApiGuards.ts, idempotency in ./LambderApiIdempotency.ts), asserts
 * registrations against them at startup, and executes them around handlers
 * at request time. Internal to Lambder; apps interact through
 * enableApiRateLimits(), enableApiIdempotency(), defineApiGuards() and the
 * per-API options.
 */
export class LambderApiPolicyEngine {
    rateLimits = new LambderApiRateLimitsEngine();
    guards = new LambderApiGuardsEngine();
    idempotency = new LambderApiIdempotencyEngine();
    setRateLimits(config) {
        this.rateLimits.configure(config);
    }
    addGuards(guards) {
        this.guards.addGuards(guards);
    }
    setIdempotency(config) {
        this.idempotency.configure(config);
    }
    /** Startup validation of one API registration's declarative options. */
    assertRegistration(apiName, mode, options) {
        this.rateLimits.assertRegistration(apiName, mode, options.rateLimit);
        this.guards.assertRegistration(apiName, mode, options.guards);
        if (options.idempotency !== undefined && !this.idempotency.isConfigured) {
            throw new Error(`Lambder: API "${apiName}" declares idempotency but enableApiIdempotency() was not called first.`);
        }
    }
    /** Rate limits then guards, in declared order. Refusals throw (LambderApiError or a guard's own throw). */
    async runPreflight(apiName, ctx, resolver, options) {
        await this.rateLimits.run(apiName, ctx, resolver, options.rateLimit);
        await this.guards.run(ctx, resolver, options.guards);
    }
    /** Idempotency replay fast path, run before the preflight: see LambderApiIdempotencyEngine.findReplay. */
    async findReplay(apiName, ctx) {
        return await this.idempotency.findReplay(apiName, ctx);
    }
    /** Idempotency claim/replay wrapper around handler execution: see LambderApiIdempotencyEngine.withIdempotency. */
    async withIdempotency(apiName, ctx, config, exec) {
        return await this.idempotency.withIdempotency(apiName, ctx, config, exec);
    }
}

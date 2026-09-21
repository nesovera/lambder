import { LambderApiGuardsEngine } from "./LambderApiGuards.js";
import { LambderApiRateLimitsEngine } from "./LambderApiRateLimits.js";
import { LambderApiIdempotencyEngine } from "./LambderApiIdempotency.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
/** An API that asks for idempotency: declared, and not the explicit `false` opt-out. */
const usesIdempotency = (definition) => definition.idempotency !== undefined && definition.idempotency !== false;
/**
 * Runtime side of the declarative API options: composes the three policy
 * subsystems (rate limits in ./LambderApiRateLimits.ts, guards in
 * ./LambderApiGuards.ts, idempotency in ./LambderApiIdempotency.ts), asserts
 * registrations against them at startup, and executes them around handlers
 * at request time. Owned by LambderApiPipeline; apps interact through the
 * create() options (rateLimits, guards, idempotency) and the per-API
 * options.
 */
export class LambderApiPolicyEngine {
    rateLimits = new LambderApiRateLimitsEngine();
    guards = new LambderApiGuardsEngine();
    idempotency = new LambderApiIdempotencyEngine();
    /** True once any of the three subsystems was configured. */
    get isConfigured() {
        return this.rateLimits.isConfigured || this.guards.isConfigured || this.idempotency.isConfigured;
    }
    configureRateLimits(config) {
        this.rateLimits.configure(config);
    }
    configureGuards(guards) {
        this.guards.configure(guards);
    }
    configureIdempotency(config) {
        this.idempotency.configure(config);
    }
    /** The backend swap, handed on to the two subsystems that hold a store. Each answers whether it had a place for one. */
    [LAMBDER_BACKEND_SWAP](backends) {
        return {
            rateLimits: backends.rateLimiter ? this.rateLimits[LAMBDER_BACKEND_SWAP](backends.rateLimiter) : false,
            idempotency: backends.idempotencyStore ? this.idempotency[LAMBDER_BACKEND_SWAP](backends.idempotencyStore) : false,
        };
    }
    /** Startup validation of one API's declarative options. */
    assertRegistration(definition) {
        const { name, mode } = definition;
        // Each subsystem reports its own absence. One combined message would
        // tell an API that declares guards on an instance with no guards map
        // that none of the three was configured, which reads as a question
        // about all three when only one of them is missing.
        if (definition.rateLimit !== undefined && !this.rateLimits.isConfigured) {
            throw new Error(`Lambder: API "${name}" declares rateLimit but no rateLimits option was configured at creation.`);
        }
        if (definition.guards !== undefined && !this.guards.isConfigured) {
            throw new Error(`Lambder: API "${name}" declares guards but no guards option was configured at creation.`);
        }
        this.rateLimits.assertRegistration(name, mode, definition.rateLimit);
        this.guards.assertRegistration(name, mode, definition.guards);
        // `idempotency: false` is an explicit opt-out, not a use: it asks for
        // nothing and so needs no store behind it.
        if (usesIdempotency(definition)) {
            if (!this.idempotency.isConfigured) {
                throw new Error(`Lambder: API "${name}" declares idempotency but no idempotency store was configured at creation.`);
            }
            this.idempotency.assertRegistration(name, definition.idempotency);
        }
    }
    /** The rate-limit policies that can be checked before the session is read: see LambderApiRateLimitsEngine.run. */
    async runSessionlessRateLimits(request, ctx, definition) {
        await this.rateLimits.run(definition.name, request, ctx, definition.rateLimit, "beforeSession");
    }
    /** The remaining rate limits, then guards, in declared order. Refusals throw; the trace records each guard as it runs. */
    async runPreflight(request, ctx, definition, trace) {
        await this.rateLimits.run(definition.name, request, ctx, definition.rateLimit, "afterSession");
        await this.guards.run(request, ctx, definition.guards, trace);
    }
    /** Idempotency replay fast path, run before the preflight: see LambderApiIdempotencyEngine.findReplay. */
    async findReplay(request, ctx, definition, trace) {
        if (!definition.idempotency)
            return null;
        return await this.idempotency.findReplay(definition.name, request, ctx, trace);
    }
    /** Idempotency claim/replay wrapper around handler execution: see LambderApiIdempotencyEngine.withIdempotency. */
    async withIdempotency(request, ctx, definition, trace, exec) {
        if (!definition.idempotency)
            return await exec();
        return await this.idempotency.withIdempotency(definition.name, request, ctx, definition.idempotency, trace, exec);
    }
}

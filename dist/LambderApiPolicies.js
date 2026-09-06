import { LambderApiError } from "./LambderApiError.js";
import { LambderResponse } from "./LambderResponse.js";
/** A crashed original must not block retries forever: pending claims expire on their own. */
const IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
/** Responses above this size skip replay storage (DynamoDB item limit is 400KB). */
const IDEMPOTENCY_MAX_STORED_BODY_BYTES = 350_000;
const RATE_LIMIT_WINDOW_KEYS = ["perMin", "per10Min", "perHour", "perDay", "perWeek", "perMonth"];
const toList = (value) => value === undefined ? [] : typeof value === "string" ? [value] : value;
/**
 * Runtime side of the declarative API options: holds what the enable/define
 * calls declared, asserts registrations against it at startup, and executes
 * rate limits, guards, and idempotency around handlers at request time.
 * Internal to Lambder; apps interact through enableApiRateLimits(),
 * enableApiIdempotency(), defineApiGuards() and the per-API options.
 */
export class LambderApiPolicyEngine {
    limiter = null;
    rateLimitPolicies = {};
    guards = {};
    idempotencyStore = null;
    idempotencyDefaultTtlSeconds = 24 * 3600;
    idempotencyFailOpen = true;
    setRateLimits(config) {
        if (this.limiter)
            throw new Error("Lambder: enableApiRateLimits() was already called.");
        for (const [name, policy] of Object.entries(config.policies)) {
            if (!policy.per)
                throw new Error(`Lambder: rate-limit policy "${name}" is missing its "per" key source.`);
            if (!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])) {
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
        }
        this.limiter = config.limiter;
        this.rateLimitPolicies = { ...config.policies };
    }
    addGuards(guards) {
        for (const [name, guardFn] of Object.entries(guards)) {
            if (this.guards[name])
                throw new Error(`Lambder: guard "${name}" is already defined.`);
            this.guards[name] = guardFn;
        }
    }
    setIdempotency(config) {
        if (this.idempotencyStore)
            throw new Error("Lambder: enableApiIdempotency() was already called.");
        this.idempotencyStore = config.store;
        this.idempotencyDefaultTtlSeconds = config.defaultTtlSeconds ?? 24 * 3600;
        this.idempotencyFailOpen = config.failOpen ?? true;
    }
    /** Startup validation of one API registration's declarative options. */
    assertRegistration(apiName, mode, options) {
        for (const name of toList(options.rateLimit)) {
            const policy = this.rateLimitPolicies[name];
            if (!policy) {
                throw new Error(`Lambder: API "${apiName}" references unknown rate-limit policy "${name}". Declare it via enableApiRateLimits() before registering the API.`);
            }
            if (policy.per === "session" && mode !== "session") {
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which requires addSessionApi.`);
            }
        }
        for (const name of toList(options.guards)) {
            if (!this.guards[name]) {
                throw new Error(`Lambder: API "${apiName}" references unknown guard "${name}". Define it via defineApiGuards() before registering the API.`);
            }
        }
        if (options.idempotency !== undefined && !this.idempotencyStore) {
            throw new Error(`Lambder: API "${apiName}" declares idempotency but enableApiIdempotency() was not called first.`);
        }
    }
    /** Rate limits then guards, in declared order. Refusals throw (LambderApiError or a guard's own throw). */
    async runPreflight(apiName, ctx, resolver, options) {
        for (const name of toList(options.rateLimit)) {
            const policy = this.rateLimitPolicies[name];
            if (!policy || !this.limiter)
                throw new Error(`Lambder: rate-limit policy "${name}" is not configured.`);
            const key = await this.resolveRateLimitKey(ctx, policy.per);
            const limited = await this.limiter.isRateLimited(`api|${apiName}|${name}|${key}`, policy);
            if (limited) {
                throw new LambderApiError(`Rate limited: "${apiName}" exceeded policy "${name}".`, {
                    errorMessage: policy.errorMessage ?? "Too many requests. Please try again later.",
                    statusCode: 429,
                });
            }
        }
        for (const name of toList(options.guards)) {
            const guardFn = this.guards[name];
            if (!guardFn)
                throw new Error(`Lambder: guard "${name}" is not configured.`);
            await guardFn(ctx, resolver);
        }
    }
    async resolveRateLimitKey(ctx, per) {
        if (per === "ip")
            return `ip:${ctx.ip}`;
        if (per === "session") {
            const sessionKey = ctx.session?.sessionKey;
            if (!sessionKey)
                throw new Error('Lambder: rate-limit per "session" evaluated without a session on the context.');
            return `session:${sessionKey}`;
        }
        return `custom:${await per(ctx)}`;
    }
    /**
     * Idempotency wrapper around validation-passed handler execution. Without
     * a client idempotencyKey the handler just runs; with one, the scope
     * (identity + api + key) is claimed atomically: duplicates of an
     * in-flight original refuse with 409, replays of a completed one return
     * the stored response verbatim, and a crashed original releases its claim
     * so a retry actually retries.
     */
    async withIdempotency(apiName, ctx, config, exec) {
        const store = this.idempotencyStore;
        const rawKey = ctx.post?.idempotencyKey;
        if (!store || rawKey === undefined || rawKey === null)
            return await exec();
        if (typeof rawKey !== "string" || rawKey.length < 1 || rawKey.length > 200) {
            throw new LambderApiError("Invalid idempotency key.", { statusCode: 400 });
        }
        const ttlSeconds = (typeof config === "object" ? config.ttlSeconds : undefined) ?? this.idempotencyDefaultTtlSeconds;
        // Scoped per identity so clients cannot collide with or poison each other's keys.
        const sessionKey = ctx.session?.sessionKey;
        const scopeKey = `${sessionKey ? `s:${sessionKey}` : `ip:${ctx.ip}`}|${apiName}|${rawKey}`;
        let begun;
        try {
            begun = await store.begin(scopeKey, { pendingTtlSeconds: IDEMPOTENCY_PENDING_TTL_SECONDS });
        }
        catch (err) {
            if (this.idempotencyFailOpen)
                return await exec();
            throw err;
        }
        if (begun.state === "pending") {
            throw new LambderApiError(`Duplicate request for "${apiName}": the original is still processing.`, {
                statusCode: 409,
                errorMessage: "This request is already being processed.",
            });
        }
        if (begun.state === "done") {
            return new LambderResponse({
                statusCode: begun.statusCode,
                headers: begun.contentType ? { "Content-Type": begun.contentType } : {},
                body: begun.body,
            });
        }
        const ownerToken = begun.ownerToken;
        // Store the response for replays when it qualifies, release the claim
        // otherwise. Settle failures only surface when failing closed.
        const settleClaim = async (response) => {
            const cacheable = response.statusCode < 500
                && typeof response.body === "string"
                && !response.isBodyBase64
                && response.body.length <= IDEMPOTENCY_MAX_STORED_BODY_BYTES;
            try {
                if (cacheable) {
                    await store.complete(scopeKey, ownerToken, {
                        statusCode: response.statusCode,
                        contentType: response.getHeader("Content-Type")?.[0] ?? null,
                        body: response.body,
                        ttlSeconds,
                    });
                }
                else {
                    await store.abandon(scopeKey, ownerToken);
                }
            }
            catch (storeErr) {
                if (!this.idempotencyFailOpen)
                    throw storeErr;
            }
        };
        try {
            const response = await exec();
            await settleClaim(response);
            return response;
        }
        catch (err) {
            // A thrown LambderResponse IS the response (res.die.*, throw
            // res.api(...)): settle the claim like a returned one so its side
            // effect replays, then rethrow so the pipeline emits it.
            if (err instanceof LambderResponse) {
                await settleClaim(err);
                throw err;
            }
            // A real crash (or a refusal like LambderApiError) releases the
            // claim so a retry actually retries.
            try {
                await store.abandon(scopeKey, ownerToken);
            }
            catch (cleanupErr) {
                if (!this.idempotencyFailOpen)
                    throw cleanupErr;
            }
            throw err;
        }
    }
}

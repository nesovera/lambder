import { RATE_LIMIT_WINDOWS } from "../stores/LambderDdbRateLimiter.js";
import { LambderApiError } from "../shared/LambderApiError.js";
import { parsePreflightSlice } from "./LambderApiGuards.js";
const RATE_LIMIT_WINDOW_KEYS = RATE_LIMIT_WINDOWS.map((window) => window.key);
/** Refusal a rate-limited request answers unless the policy or the API's override names its own. */
const DEFAULT_RATE_LIMIT_REFUSAL = { type: "warning", content: "Too many requests. Please try again later." };
export function lambderRateLimitKey(key) { return key; }
/** Normalize the three rateLimit-option forms into ordered entries; an explicit `undefined` map value declares nothing. */
const toRateLimitEntries = (value) => {
    if (value === undefined)
        return [];
    if (typeof value === "string")
        return [{ name: value }];
    if (Array.isArray(value))
        return value.map((name) => ({ name }));
    return Object.entries(value).flatMap(([name, override]) => override === undefined ? [] : override === true ? [{ name }] : [{ name, override }]);
};
const hasWindowOverride = (override) => RATE_LIMIT_WINDOW_KEYS.some((key) => override[key] !== undefined);
/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPolicyEngine.
 */
export class LambderApiRateLimitsEngine {
    onInvalidInput;
    limiter = null;
    policies = {};
    constructor(onInvalidInput) {
        this.onInvalidInput = onInvalidInput;
    }
    configure(config) {
        if (this.limiter)
            throw new Error("Lambder: rateLimits were already configured.");
        for (const [name, policy] of Object.entries(config.policies)) {
            const per = policy.per;
            if (!per || (per !== "ip" && per !== "session" && typeof per.handler !== "function")) {
                throw new Error(`Lambder: rate-limit policy "${name}" needs per: "ip", "session", or a { apiInput?, handler } key.`);
            }
            if (!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])) {
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
            const budget = policy.budget;
            if (budget !== "perApi" && budget !== "perPolicy") {
                throw new Error(`Lambder: rate-limit policy "${name}" needs budget: "perApi" (each referencing API counts separately) or "perPolicy" (one counter shared by every referencing API).`);
            }
        }
        this.limiter = config.limiter;
        this.policies = { ...config.policies };
    }
    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName, mode, rateLimitOption) {
        for (const { name, override } of toRateLimitEntries(rateLimitOption)) {
            const policy = this.policies[name];
            if (!policy) {
                throw new Error(`Lambder: API "${apiName}" references unknown rate-limit policy "${name}". Declare it in the rateLimits option at creation.`);
            }
            if (policy.per === "session" && mode !== "session") {
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which requires addSessionApi.`);
            }
            if (override && policy.budget === "perPolicy" && hasWindowOverride(override)) {
                throw new Error(`Lambder: API "${apiName}" overrides the windows of rate-limit policy "${name}", whose budget is "perPolicy": one counter shared by every referencing API has one set of limits. Declare a separate policy instead.`);
            }
        }
    }
    /**
     * Check the API's policies in declared order; the first exceeded one
     * refuses with a 429 envelope and a Retry-After header. Attempts count,
     * not successes: every counter checked before the refusing one (and every
     * counter, when a later guard or validation refuses) keeps its increment,
     * so list first the policy you want charged on refusals.
     */
    async run(apiName, ctx, resolver, rateLimitOption) {
        for (const { name, override } of toRateLimitEntries(rateLimitOption)) {
            const policy = this.policies[name];
            if (!policy || !this.limiter)
                throw new Error(`Lambder: rate-limit policy "${name}" is not configured.`);
            const key = await this.resolveKey(ctx, resolver, policy.per);
            // "perPolicy" shares one counter across every API referencing the
            // policy; "perApi" keys each API separately, which is also what
            // lets an API override the windows without colliding.
            const trackerKey = policy.budget === "perPolicy"
                ? `policy|${name}|${key}`
                : `api|${apiName}|${name}|${key}`;
            const limits = {};
            for (const windowKey of RATE_LIMIT_WINDOW_KEYS) {
                const limit = override?.[windowKey] ?? policy[windowKey];
                if (limit !== undefined)
                    limits[windowKey] = limit;
            }
            const exceeded = await this.limiter.isRateLimited(trackerKey, limits);
            if (exceeded) {
                const retryAfterSeconds = Math.max(1, exceeded.resetAt - Math.floor(Date.now() / 1000));
                throw new LambderApiError(`Rate limited: "${apiName}" exceeded policy "${name}" (${exceeded.window}: ${exceeded.limit}).`, {
                    errorMessage: override?.errorMessage ?? policy.errorMessage ?? DEFAULT_RATE_LIMIT_REFUSAL,
                    statusCode: 429,
                    headers: { "Retry-After": String(retryAfterSeconds) },
                });
            }
        }
    }
    async resolveKey(ctx, resolver, per) {
        if (per === "ip")
            return `ip:${ctx.ip}`;
        if (per === "session") {
            const sessionKey = ctx.session?.sessionKey;
            if (!sessionKey)
                throw new Error('Lambder: rate-limit per "session" evaluated without a session on the context.');
            return `session:${sessionKey}`;
        }
        const payload = per.apiInput
            ? await parsePreflightSlice(per.apiInput, ctx.post?.payload, ctx, resolver, this.onInvalidInput)
            : undefined;
        return `custom:${await per.handler(ctx, payload)}`;
    }
}

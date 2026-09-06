import { LambderApiError } from "../shared/LambderApiError.js";
import { parsePreflightSlice } from "./LambderApiGuards.js";
const RATE_LIMIT_WINDOW_KEYS = ["perMin", "per10Min", "perHour", "perDay", "perWeek", "perMonth"];
export function lambderRateLimitKey(key) { return key; }
const toList = (value) => value === undefined ? [] : typeof value === "string" ? [value] : value;
/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPolicyEngine.
 */
export class LambderApiRateLimitsEngine {
    limiter = null;
    policies = {};
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
        }
        this.limiter = config.limiter;
        this.policies = { ...config.policies };
    }
    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName, mode, rateLimitOption) {
        for (const name of toList(rateLimitOption)) {
            const policy = this.policies[name];
            if (!policy) {
                throw new Error(`Lambder: API "${apiName}" references unknown rate-limit policy "${name}". Declare it in the rateLimits option at creation.`);
            }
            if (policy.per === "session" && mode !== "session") {
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which requires addSessionApi.`);
            }
        }
    }
    /** Check the API's policies in declared order; the first exceeded one refuses with a 429 envelope. */
    async run(apiName, ctx, resolver, rateLimitOption) {
        for (const name of toList(rateLimitOption)) {
            const policy = this.policies[name];
            if (!policy || !this.limiter)
                throw new Error(`Lambder: rate-limit policy "${name}" is not configured.`);
            const key = await this.resolveKey(ctx, resolver, policy.per);
            // scope "policy" shares one counter across every API referencing
            // the policy; the default gives each API its own budget.
            const trackerKey = policy.scope === "policy"
                ? `policy|${name}|${key}`
                : `api|${apiName}|${name}|${key}`;
            const limited = await this.limiter.isRateLimited(trackerKey, policy);
            if (limited) {
                throw new LambderApiError(`Rate limited: "${apiName}" exceeded policy "${name}".`, {
                    errorMessage: policy.errorMessage ?? "Too many requests. Please try again later.",
                    statusCode: 429,
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
            ? parsePreflightSlice(per.apiInput, ctx.post?.payload, resolver)
            : undefined;
        return `custom:${await per.handler(ctx, payload)}`;
    }
}

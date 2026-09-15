import { joinKeyFields } from "../shared/util/LambderKeyFields.js";
import { sha256HexOf } from "../shared/util/LambderTextDigest.js";
import { RATE_LIMIT_WINDOWS, } from "../shared/contracts/LambderRateLimiter.js";
import { LambderApiRefusal, LAMBDER_REFUSAL_CODES } from "../shared/wire/LambderApiRefusal.js";
import { parsePreflightSlice } from "./LambderApiValidationRefusal.js";
import { assertNonNegativeInteger } from "../shared/util/LambderOptionChecks.js";
const RATE_LIMIT_WINDOW_KEYS = RATE_LIMIT_WINDOWS.map((window) => window.key);
/** Refusal a rate-limited request answers unless the policy or the API's override names its own. */
export const DEFAULT_RATE_LIMIT_REFUSAL = { type: "warning", code: LAMBDER_REFUSAL_CODES.rateLimited, content: "Too many requests. Please try again later." };
/**
 * The refusal a rate-limited call answers with: a 429 envelope carrying the
 * framework code (a policy's own message inherits it unless it sets a more
 * specific one) and a Retry-After header. The engine throws it; the mock
 * runtime's failure injection throws the same one, so an injected rate
 * limit is indistinguishable from a real one.
 */
export const rateLimitRefusal = (detail, retryAfterSeconds, message) => new LambderApiRefusal(detail, {
    errorMessage: message ? { code: LAMBDER_REFUSAL_CODES.rateLimited, ...message } : DEFAULT_RATE_LIMIT_REFUSAL,
    statusCode: 429,
    headers: { "Retry-After": String(Math.max(1, Math.floor(retryAfterSeconds))) },
});
/**
 * A key builder bound to a context type, the counterpart of
 * lambderGuardBuilder. The server's lambderRateLimitKey() is this bound to
 * the render context; the mock runtime binds it to its own call context and
 * exposes it as `rateLimitKey`.
 *
 * Bound rather than left open because the engine hands the handler whatever
 * context the adapter runs on, and the two adapters run on different ones. A
 * single builder pinned to the server's context type compiled against the
 * mock and then handed the handler a context with no `ip`, `method` or
 * `path`, so every caller collapsed onto one counter and the limit a test was
 * written to prove silently proved nothing.
 */
export const lambderRateLimitKeyBuilder = () => ((key) => key);
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
/**
 * A limiter is handed only limits it can act on, so no implementation has to
 * invent an answer for a nonsense one: that is where two limiters drift apart,
 * one refusing the first attempt against a negative cap and the other allowing
 * it. Zero is legal and leaves the window
 * unenforced, which is why this is the non-negative check and not the
 * positive one.
 */
const assertWindowLimits = (subject, windows) => {
    for (const key of RATE_LIMIT_WINDOW_KEYS) {
        const limit = windows[key];
        if (limit === undefined)
            continue;
        assertNonNegativeInteger(limit, `${subject} caps ${key} at ${String(limit)}; a window's limit`);
    }
};
const hasWindowOverride = (override) => RATE_LIMIT_WINDOW_KEYS.some((key) => override[key] !== undefined);
const phaseOf = (per) => per === "ip" ? "beforeSession" : "afterSession";
/**
 * The ceiling on the variable half of a tracker key, in UTF-8 bytes, past
 * which that half is replaced by its own digest. 1024 sits comfortably inside
 * every store's key limit (a DynamoDB partition key is 2048 bytes, and the
 * limiter's own prefix plus the api and policy names are joined in front of
 * this half).
 *
 * The bound lives in the engine rather than in a limiter because a store that
 * REFUSES an over-long key refuses it by throwing, and a throw from a limiter
 * is exactly what failOpen swallows: a custom key derived from a payload field
 * (the documented shape, an email address) that a caller posts 3,000
 * characters long makes every window of every policy fail the same way, and
 * the request goes through unmetered with the limit silently off. Folding the
 * over-long half into a digest keeps distinct callers on distinct counters,
 * and a key that fits stays readable in the table.
 *
 * `per: "ip"` needs none of this: normalizeClientIp already caps an address at
 * 45 characters, whichever header or gateway field named it.
 */
const MAX_TRACKER_KEY_PART_BYTES = 1024;
/**
 * The variable half of a tracker key, bounded: `<kind>:<value>` while the
 * value fits, `<kind>:h:<sha256 hex>` once it does not. The api and policy
 * names are joined around it afterwards, so an over-long key still says which
 * policy it belongs to.
 */
const boundTrackerKeyPart = async (kind, value) => new TextEncoder().encode(value).length > MAX_TRACKER_KEY_PART_BYTES
    ? `${kind}:h:${await sha256HexOf(value)}`
    : `${kind}:${value}`;
/** The windows one check ran against, for a log line that must not carry the tracker key. */
const describeWindows = (limits) => RATE_LIMIT_WINDOW_KEYS.filter((key) => limits[key] !== undefined).map((key) => `${key}: ${String(limits[key])}`).join(", ") || "no window";
/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPolicyEngine. Reads the request's ip and the context's session
 * and nothing else, so it runs unchanged under the server and the mock
 * runtime.
 */
export class LambderApiRateLimitsEngine {
    limiter = null;
    failOpen = true;
    // A Map for the same reason the guard registry is one: a plain object
    // answers for "toString" and "constructor" through its prototype, so a
    // policy named one of those would slip past the registration check and
    // fail on every request instead.
    policies = new Map();
    /** True once rateLimits were configured. */
    get isConfigured() { return this.limiter !== null; }
    configure(config) {
        if (this.limiter)
            throw new Error("Lambder: rateLimits were already configured.");
        // The same rule the guards option follows, and the one an API's own
        // `rateLimit: {}` is already held to: declaring the option is
        // declaring a limit. An empty map configured a limiter with nothing to
        // enforce and reported every API that named a policy as if the option
        // had never been given, which sends the reader to the wrong line.
        if (Object.keys(config.policies).length === 0) {
            throw new Error("Lambder: the rateLimits option was declared with no policies in it, which configures nothing. Name the policies APIs will declare, or leave the option off.");
        }
        for (const [name, policy] of Object.entries(config.policies)) {
            const per = policy.per;
            if (!per || (per !== "ip" && per !== "session" && typeof per.handler !== "function")) {
                throw new Error(`Lambder: rate-limit policy "${name}" needs per: "ip", "session", or a { apiInput?, handler } key.`);
            }
            if (!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])) {
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
            assertWindowLimits(`rate-limit policy "${name}"`, policy);
            const budget = policy.budget;
            if (budget !== undefined && budget !== "perApi" && budget !== "perPolicy") {
                throw new Error(`Lambder: rate-limit policy "${name}" has budget "${String(budget)}"; use "perApi" (default: each referencing API counts separately) or "perPolicy" (one counter shared by every referencing API).`);
            }
        }
        this.limiter = config.limiter;
        this.failOpen = config.failOpen ?? true;
        this.policies = new Map(Object.entries(config.policies));
    }
    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName, mode, rateLimitOption) {
        const entries = toRateLimitEntries(rateLimitOption);
        // The same rule the guards option follows: declaring the option is
        // declaring a limit. `{}`, `[]` and `{ name: undefined }` are
        // present-but-empty, and would otherwise register an API that
        // announces a rate limit and enforces none.
        if (rateLimitOption !== undefined && entries.length === 0) {
            throw new Error(`Lambder: API "${apiName}" declares an empty rateLimit option, which limits nothing. ` +
                `Name the policy that limits it, or omit the option entirely.`);
        }
        for (const { name, override } of entries) {
            const policy = this.policies.get(name);
            if (!policy) {
                throw new Error(`Lambder: API "${apiName}" references unknown rate-limit policy "${name}". Declare it in the rateLimits option at creation.`);
            }
            if (policy.per === "session" && mode !== "session") {
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which requires addSessionApi.`);
            }
            if (override)
                assertWindowLimits(`API "${apiName}" override of rate-limit policy "${name}"`, override);
            if (override && hasWindowOverride(override) && !RATE_LIMIT_WINDOW_KEYS.some((key) => (override[key] ?? policy[key]))) {
                throw new Error(`Lambder: API "${apiName}" overrides rate-limit policy "${name}" down to no enforced window, which limits nothing. ` +
                    `A policy is required to declare a window; an override may not take the last one away.`);
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
     *
     * Run twice per call, once per phase: the policies whose key needs no
     * session are checked BEFORE the session is read, so a flood of requests
     * carrying bogus session cookies is refused without touching the session
     * store; the rest are checked after it, since `per: "session"` and a
     * custom key handler may both read ctx.session. Declared order is kept
     * inside each phase.
     */
    async run(apiName, request, ctx, rateLimitOption, phase) {
        for (const { name, override } of toRateLimitEntries(rateLimitOption)) {
            const policy = this.policies.get(name);
            if (!policy || !this.limiter)
                throw new Error(`Lambder: rate-limit policy "${name}" is not configured. Declare it in the rateLimits option at creation.`);
            if (phaseOf(policy.per) !== phase)
                continue;
            const key = await this.resolveKey(request, ctx, policy.per);
            // "perPolicy" shares one counter across every API referencing the
            // policy; "perApi" keys each API separately, which is also what
            // lets an API override the windows without colliding.
            const trackerKey = policy.budget === "perPolicy"
                ? joinKeyFields("policy", name, key)
                : joinKeyFields("api", apiName, name, key);
            const limits = {};
            for (const windowKey of RATE_LIMIT_WINDOW_KEYS) {
                const limit = override?.[windowKey] ?? policy[windowKey];
                if (limit !== undefined)
                    limits[windowKey] = limit;
            }
            let exceeded;
            try {
                exceeded = await this.limiter.isRateLimited(trackerKey, limits);
            }
            catch (limiterErr) {
                if (!this.failOpen)
                    throw limiterErr;
                // The policy and its windows, never the tracker key: the key
                // carries whatever a custom handler returned, which the docs'
                // own example makes an email address, and a log line is not
                // the place for it.
                console.error(`Lambder rate limits: policy "${name}" (${describeWindows(limits)}) could not be checked for API "${apiName}"; ` +
                    "the request is being allowed through. Set rateLimits.failOpen: false to refuse instead.", limiterErr);
                continue;
            }
            if (exceeded) {
                const retryAfterSeconds = Math.max(1, exceeded.resetAt - Math.floor(Date.now() / 1000));
                throw rateLimitRefusal(`Rate limited: "${apiName}" exceeded policy "${name}" (${exceeded.window}: ${exceeded.limit}).`, retryAfterSeconds, override?.errorMessage ?? policy.errorMessage);
            }
        }
    }
    async resolveKey(request, ctx, per) {
        if (per === "ip")
            return `ip:${request.ip}`;
        if (per === "session") {
            const sessionKey = ctx.session?.sessionKey;
            if (!sessionKey)
                throw new Error('Lambder: rate-limit per "session" evaluated without a session on the context.');
            return await boundTrackerKeyPart("session", sessionKey);
        }
        const payload = per.apiInput ? parsePreflightSlice(per.apiInput, request.payload) : undefined;
        return await boundTrackerKeyPart("custom", await per.handler(ctx, payload));
    }
}

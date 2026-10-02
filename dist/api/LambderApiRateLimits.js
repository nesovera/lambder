import { joinKeyFields } from "../shared/util/joinKeyFields.js";
import { RATE_LIMIT_WINDOWS, } from "../shared/contracts/LambderRateLimiter.js";
import { LambderApiRefusal, LAMBDER_REFUSAL_CODES } from "../shared/wire/LambderApiRefusal.js";
import { parsePreflightSlice } from "./LambderApiValidationRefusal.js";
import { assertNonNegativeInteger } from "../shared/util/LambderOptionChecks.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
import { DEFAULT_IPV6_RATE_LIMIT_PREFIX, rateLimitSubjectOf } from "../shared/util/LambderClientIp.js";
const RATE_LIMIT_WINDOW_KEYS = RATE_LIMIT_WINDOWS.map((window) => window.key);
/** The words a rate-limited call answers with unless the policy or the API's override writes its own (the `refusal` option of each). */
export const DEFAULT_RATE_LIMIT_REFUSAL = { type: "warning", content: "Too many requests. Please try again later." };
/**
 * The refusal a rate-limited call answers with: a 429 envelope carrying the
 * framework code, the words a policy or an API wrote, the policy's name and
 * the seconds to wait as its data, and a Retry-After header of those same
 * seconds. The engine throws it; the mock runtime's failure injection throws
 * the same one, so an injected rate limit is indistinguishable from a real
 * one.
 *
 * Only the words are read off the message, so one that carries a code or
 * data anyway (a plain-JS caller, a cast) cannot replace them: a rate limit
 * is never a code an endpoint declares, and the pipeline sends one only with
 * the data a client narrows it by.
 */
export const rateLimitRefusal = (detail, data, message = DEFAULT_RATE_LIMIT_REFUSAL) => {
    // The header carries whole seconds of at least one, and the data says the
    // same number: a client reading either waits as long.
    if (!Number.isFinite(data.retryAfterSeconds))
        throw new Error(`Lambder: a rate-limit refusal waits a finite number of seconds, got ${String(data.retryAfterSeconds)}.`);
    const retryAfterSeconds = Math.max(1, Math.floor(data.retryAfterSeconds));
    return new LambderApiRefusal(detail, {
        refusal: {
            type: message.type,
            ...(message.title !== undefined ? { title: message.title } : {}),
            content: message.content,
            code: LAMBDER_REFUSAL_CODES.rateLimited,
            data: { policy: data.policy, retryAfterSeconds },
        },
        statusCode: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
    });
};
/**
 * A rate-limit message carries no code of its own and no data: both are the
 * framework's, which rateLimitRefusal sets, and a code there would read as
 * one the app chose for clients to branch on when it never reaches them.
 */
const assertRateLimitMessage = (where, message) => {
    if (message === undefined)
        return;
    const { code, data } = message;
    if (code !== undefined) {
        throw new Error(`Lambder: ${where} sets a refusal code. A rate-limit refusal is always "${LAMBDER_REFUSAL_CODES.rateLimited}", so an endpoint never has to declare it; write the type, title and content only.`);
    }
    if (data !== undefined) {
        throw new Error(`Lambder: ${where} sets refusal data. A rate-limit refusal carries the framework's: the policy that refused and the seconds to wait.`);
    }
};
/**
 * A key builder bound to a context type, the counterpart of
 * lambderGuardBuilder. The server's lambderRateLimitKey() is this bound to
 * the render context; the mock runtime binds it to its own call context and
 * exposes it as `rateLimitKey`.
 *
 * Bound rather than left open because the engine hands the handler whatever
 * context the adapter runs on, and the two adapters differ. A builder pinned
 * to the server's context type would compile against the mock, then receive
 * a context with no `ip`, `method` or `path`: every caller would share one
 * counter and a test of the limit would silently prove nothing.
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
 * invent an answer for a nonsense one (where two limiters would drift apart,
 * one refusing the first attempt against a negative cap and one allowing it).
 * Zero is legal and leaves the window unenforced, hence non-negative rather
 * than positive.
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
const phaseOf = (per, chargeAt) => {
    if (per === "ip")
        return "beforeSession";
    if (per === "session")
        return "beforeGuards";
    return chargeAt ?? "afterGuards";
};
/** The windows one check ran against, for a log line that must not carry the tracker key. */
const describeWindows = (limits) => RATE_LIMIT_WINDOW_KEYS.filter((key) => limits[key] !== undefined).map((key) => `${key}: ${String(limits[key])}`).join(", ") || "no window";
/** The windows a check runs against: the policy's own, each replaced by the API's override where it names one. */
const windowsOf = (policy, override) => {
    const limits = {};
    for (const windowKey of RATE_LIMIT_WINDOW_KEYS) {
        const limit = override?.[windowKey] ?? policy[windowKey];
        if (limit !== undefined)
            limits[windowKey] = limit;
    }
    return limits;
};
/**
 * The counter one check charges. "perPolicy" shares one counter across every
 * API referencing the policy; "perApi" keys each API separately, which is
 * also what lets an API override the windows without colliding. A charge
 * made outside an API call (a route's handler) has no API to be counted
 * under, so it counts against the policy's shared counter.
 */
const trackerKeyOf = (name, policy, apiName, key) => policy.budget === "perPolicy" || apiName === null
    ? joinKeyFields("policy", name, key)
    : joinKeyFields("api", apiName, name, key);
/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPipeline. Reads the request (its ip, and a key's payload
 * slice) and hands the context to a custom key's handler, reading nothing
 * of the context itself but its session, so it runs unchanged under the
 * server and the mock runtime.
 *
 * The caller's half of every tracker key (the address, the session key, a
 * custom key) reaches the limiter as a digest (LambderKeyFieldDigest), so a
 * table read names the API and the policy and never who was counted.
 */
export class LambderApiRateLimitsEngine {
    keyFieldDigest;
    limiter = null;
    failOpen = true;
    ipv6PrefixLength = DEFAULT_IPV6_RATE_LIMIT_PREFIX;
    // A Map, not a plain object: an object answers for "toString" and
    // "constructor" through its prototype, so a policy named one of those
    // would slip past the registration check and fail on every request.
    policies = new Map();
    /**
     * The limiter failures already logged. A limiter answering a run of
     * requests with one continuing failure throws the same error for each
     * (see LambderRateLimiter), and a flood of a few thousand requests a
     * second would otherwise be as many identical log lines.
     */
    loggedFailures = new WeakSet();
    constructor(keyFieldDigest) {
        this.keyFieldDigest = keyFieldDigest;
    }
    /** True once rateLimits were configured. */
    get isConfigured() { return this.limiter !== null; }
    configure(config) {
        if (this.limiter)
            throw new Error("Lambder: rateLimits were already configured.");
        // Declaring the option is declaring a limit, as for the guards option
        // and an API's own `rateLimit: {}`. An empty map would configure a
        // limiter with nothing to enforce, and every API naming a policy would
        // be reported as if the option were missing: the wrong line to fix.
        if (Object.keys(config.policies).length === 0) {
            throw new Error("Lambder: the rateLimits option was declared with no policies in it, which configures nothing. Name the policies APIs will declare, or leave the option off.");
        }
        for (const [name, policy] of Object.entries(config.policies)) {
            const per = policy.per;
            if (per !== undefined && per !== "ip" && per !== "session" && typeof per?.handler !== "function") {
                throw new Error(`Lambder: rate-limit policy "${name}" has a per that is not "ip", "session", or a { apiInput?, handler } key. Leave per out for a policy the handler charges with its own key.`);
            }
            if (!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])) {
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
            assertWindowLimits(`rate-limit policy "${name}"`, policy);
            const chargeAt = policy.chargeAt;
            if (chargeAt !== undefined) {
                if (chargeAt !== "beforeGuards" && chargeAt !== "afterGuards") {
                    throw new Error(`Lambder: rate-limit policy "${name}" has chargeAt "${String(chargeAt)}"; use "afterGuards" (default) or "beforeGuards".`);
                }
                if (per === undefined || per === "ip" || per === "session") {
                    throw new Error(`Lambder: rate-limit policy "${name}" sets chargeAt, which only a policy keyed by a { apiInput?, handler } key takes: per "ip" and per "session" each run at one fixed place, and a policy without per is charged by the code that names it.`);
                }
            }
            assertRateLimitMessage(`rate-limit policy "${name}"`, policy.refusal);
            const budget = policy.budget;
            if (budget !== undefined && budget !== "perApi" && budget !== "perPolicy") {
                throw new Error(`Lambder: rate-limit policy "${name}" has budget "${String(budget)}"; use "perApi" (default: each referencing API counts separately) or "perPolicy" (one counter shared by every referencing API).`);
            }
        }
        const ipv6PrefixLength = config.ipv6PrefixLength ?? DEFAULT_IPV6_RATE_LIMIT_PREFIX;
        if (!Number.isInteger(ipv6PrefixLength) || ipv6PrefixLength < 1 || ipv6PrefixLength > 128) {
            throw new Error(`Lambder: rateLimits.ipv6PrefixLength must be a whole number from 1 to 128, got ${String(ipv6PrefixLength)}.`);
        }
        this.limiter = config.limiter;
        this.failOpen = config.failOpen ?? true;
        this.ipv6PrefixLength = ipv6PrefixLength;
        this.policies = new Map(Object.entries(config.policies));
    }
    /**
     * Puts the engine over another limiter, for `lambder/testing`; the named
     * policies and failOpen stay as configured. False when rateLimits were
     * never configured: there is nothing for a limiter to sit under.
     */
    [LAMBDER_BACKEND_SWAP](limiter) {
        if (!this.limiter)
            return false;
        this.limiter = limiter;
        return true;
    }
    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName, mode, rateLimitOption) {
        const entries = toRateLimitEntries(rateLimitOption);
        // Declaring the option is declaring a limit, as for guards: `{}`,
        // `[]` and `{ name: undefined }` would register an API that
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
            if (policy.per === undefined) {
                throw new Error(`Lambder: API "${apiName}" references rate-limit policy "${name}", which declares no per: its key is the one a handler passes to ctx.rateLimit("${name}", key), so the request alone cannot be counted against it.`);
            }
            if (policy.per === "session" && mode !== "session") {
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which counts per session, and none of its guards needs a session.`);
            }
            if (override)
                assertWindowLimits(`API "${apiName}" override of rate-limit policy "${name}"`, override);
            if (override)
                assertRateLimitMessage(`API "${apiName}" override of rate-limit policy "${name}"`, override.refusal);
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
     * Runs once per phase (see LambderRateLimitPhase), keeping declared order
     * within each: `per: "ip"` before the session read, so a flood of bogus
     * session cookies never reaches the session store; `per: "session"` after
     * it; a custom key after the guards unless its policy's `chargeAt` says
     * "beforeGuards", so a caller they refuse cannot spend somebody else's
     * budget.
     */
    async run(apiName, request, ctx, rateLimitOption, phase) {
        for (const { name, override } of toRateLimitEntries(rateLimitOption)) {
            // Registration refused an unknown policy and one without per.
            const policy = this.policies.get(name);
            const per = policy.per;
            if (phaseOf(per, policy.chargeAt) !== phase)
                continue;
            const key = await this.resolveKey(name, request, ctx, per);
            const limits = windowsOf(policy, override);
            const exceeded = await this.countAttempt(name, trackerKeyOf(name, policy, apiName, key), limits, `API "${apiName}"`);
            if (exceeded) {
                throw rateLimitRefusal(`Rate limited: "${apiName}" exceeded policy "${name}" (${exceeded.window}: ${exceeded.limit}).`, { policy: name, retryAfterSeconds: this.retryAfterOf(exceeded) }, override?.refusal ?? policy.refusal);
            }
        }
    }
    /**
     * One policy charged by code rather than by a declaration, for
     * `ctx.rateLimit` and `ctx.isRateLimited`. Counters, failOpen, key
     * digests and refusal are those of a declared limit; only who knows the
     * key differs. A policy without `per` takes the key the code passes, a
     * `per: "ip"` or `per: "session"` one reads it off the request, and one
     * keyed by an API payload is refused, since only its APIs know the key.
     */
    async chargePolicy(name, subject) {
        if (!this.limiter)
            throw new Error(`Lambder: charging rate-limit policy "${name}" needs the rateLimits option at creation.`);
        const policy = this.policies.get(name);
        if (!policy)
            throw new Error(`Lambder: unknown rate-limit policy "${name}". Declare it in the rateLimits option at creation.`);
        const key = await this.chargeKeyOf(name, policy, subject);
        const limits = windowsOf(policy);
        const where = subject.apiName === null ? "a route" : `API "${subject.apiName}"`;
        const exceeded = await this.countAttempt(name, trackerKeyOf(name, policy, subject.apiName, key), limits, where);
        if (!exceeded)
            return { checkResult: false, refusal: null };
        const retryAfterSeconds = this.retryAfterOf(exceeded);
        return {
            checkResult: { ...exceeded, retryAfterSeconds },
            refusal: rateLimitRefusal(`Rate limited: ${where} exceeded policy "${name}" (${exceeded.window}: ${exceeded.limit}).`, { policy: name, retryAfterSeconds }, policy.refusal),
        };
    }
    /**
     * Seconds until the refusing window resets, read against the limiter's
     * own clock when it keeps one: `resetAt` is a second on that clock, and a
     * limiter under a test clock would otherwise be told a Retry-After
     * measured from another time entirely.
     */
    retryAfterOf(exceeded) {
        const nowMilliseconds = this.limiter?.clockMilliseconds?.() ?? Date.now();
        return Math.max(1, exceeded.resetAt - Math.floor(nowMilliseconds / 1000));
    }
    /**
     * Counts one attempt, or lets it through when the limiter itself fails
     * and failOpen is on. The log line names the policy and its windows,
     * never the tracker key: digested as its caller's half is, the key is
     * still the same for every attempt of one caller, and a log is read by
     * more people than the table. A failure the limiter throws again (see
     * loggedFailures) is not logged again.
     */
    async countAttempt(name, trackerKey, limits, where) {
        try {
            return await this.limiter.isRateLimited(trackerKey, limits);
        }
        catch (limiterErr) {
            if (!this.failOpen)
                throw limiterErr;
            if (typeof limiterErr === "object" && limiterErr !== null) {
                if (this.loggedFailures.has(limiterErr))
                    return false;
                this.loggedFailures.add(limiterErr);
            }
            console.error(`Lambder rate limits: policy "${name}" (${describeWindows(limits)}) could not be checked for ${where}; ` +
                "the request is being allowed through. Set rateLimits.failOpen: false to refuse instead.", limiterErr);
            return false;
        }
    }
    async chargeKeyOf(name, policy, subject) {
        const per = policy.per;
        if (per === undefined) {
            if (subject.key === undefined)
                throw new Error(`Lambder: rate-limit policy "${name}" declares no per, so the code charging it passes the key: ctx.rateLimit("${name}", key).`);
            return await this.keyFieldDigest.digestOf("custom", subject.key);
        }
        if (per !== "ip" && per !== "session") {
            throw new Error(`Lambder: rate-limit policy "${name}" derives its key from an API's payload, so only the APIs declaring it can charge it.`);
        }
        if (subject.key !== undefined)
            throw new Error(`Lambder: rate-limit policy "${name}" is keyed per "${per}", so charging it takes no key.`);
        return await this.requestKeyOf(name, per, subject.ip, subject.session);
    }
    async resolveKey(name, request, ctx, per) {
        if (per === "ip" || per === "session")
            return await this.requestKeyOf(name, per, request.ip, ctx.session);
        const payload = per.apiInput ? await parsePreflightSlice(per.apiInput, request.payload) : undefined;
        return await this.keyFieldDigest.digestOf("custom", await per.handler(ctx, payload));
    }
    /**
     * The key a `per: "ip"` or `per: "session"` policy counts under: what the
     * request carries, however the policy is charged, digested as a custom
     * key is. The address is the subject rateLimitSubjectOf counts (an IPv6
     * caller's /64), so the digest of one subscriber's every address is one.
     */
    async requestKeyOf(name, per, ip, session) {
        if (per === "ip")
            return await this.keyFieldDigest.digestOf("ip", rateLimitSubjectOf(ip, this.ipv6PrefixLength));
        const sessionKey = session?.sessionKey;
        if (!sessionKey)
            throw new Error(`Lambder: rate-limit policy "${name}" is keyed per "session", and the request charging it has no session.`);
        return await this.keyFieldDigest.digestOf("session", sessionKey);
    }
}

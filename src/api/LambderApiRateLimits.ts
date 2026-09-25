import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type { LambderRateLimitOptionValue, LambderRateLimitOverride } from "../shared/wire/LambderApiOptionValues.js";
import { joinKeyFields } from "../shared/util/joinKeyFields.js";
import { boundKeyField } from "../shared/util/boundKeyField.js";
import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext } from "./LambderApiCallContext.js";
import {
    RATE_LIMIT_WINDOWS,
    type LambderRateLimiter,
    type LambderRateLimitExceeded,
    type LambderRateLimitPolicy,
    type LambderRateLimitWindow,
} from "../shared/contracts/LambderRateLimiter.js";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import { LambderApiRefusal, LAMBDER_REFUSAL_CODES, type LambderAppRefusalMessage, type LambderRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import { parsePreflightSlice } from "./LambderApiValidationRefusal.js";
import type { LambderNonEmptyOptionMap } from "../shared/util/LambderTypeUtilities.js";
import { assertNonNegativeInteger } from "../shared/util/LambderOptionChecks.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
import { DEFAULT_IPV6_RATE_LIMIT_PREFIX, rateLimitSubjectOf } from "../shared/util/LambderClientIp.js";

const RATE_LIMIT_WINDOW_KEYS: readonly LambderRateLimitWindow[] = RATE_LIMIT_WINDOWS.map((window) => window.key);

/** Refusal a rate-limited request answers unless the policy or the API's override names its own. */
export const DEFAULT_RATE_LIMIT_REFUSAL = { type: "warning", code: LAMBDER_REFUSAL_CODES.rateLimited, content: "Too many requests. Please try again later." } satisfies LambderRefusalMessage;

/**
 * The refusal a rate-limited call answers with: a 429 envelope carrying the
 * framework code (a policy's own message inherits it unless it sets a more
 * specific one) and a Retry-After header. The engine throws it; the mock
 * runtime's failure injection throws the same one, so an injected rate
 * limit is indistinguishable from a real one.
 */
export const rateLimitRefusal = (
    detail: string,
    retryAfterSeconds: number,
    message?: LambderAppRefusalMessage,
): LambderApiRefusal => new LambderApiRefusal(detail, {
    errorMessage: message ? { code: LAMBDER_REFUSAL_CODES.rateLimited, ...message } satisfies LambderAppRefusalMessage : DEFAULT_RATE_LIMIT_REFUSAL,
    statusCode: 429,
    headers: { "Retry-After": String(Math.max(1, Math.floor(retryAfterSeconds))) },
});

/**
 * A custom rate-limit key. `apiInput` names the fields of the API's OWN
 * payload the key derives from: that slice is validated against the raw
 * payload before `handler` runs (failures answer like regular input
 * validation, through setApiInputValidationErrorHandler when set) and reaches
 * the handler typed. Referencing the policy from an API whose input schema
 * lacks those fields is a compile error, so the API's schema stays the single
 * owner of the field. Build with lambderRateLimitKey() so the handler's
 * payload type follows `apiInput`. The context is the adapter's (the render
 * context on the server); the engine itself reads nothing from it.
 *
 * One member with `apiInput` optional, not a union of two shapes: a union
 * with a function in each arm defeats contextual typing, so annotating a
 * policies map with LambderRateLimitPer or LambderApiRateLimitPolicyConfig
 * would leave `ctx` implicitly any and fail to compile. The builder's
 * overloads keep the apiInput/payload correlation instead.
 */
export type LambderRateLimitKeyFn<TInput extends z.ZodType = z.ZodType, TCtx = any> = {
    apiInput?: TInput;
    handler: (ctx: TCtx, payload: z.output<TInput>) => string | Promise<string>;
};

/**
 * Builder that ties the handler's payload type to the `apiInput` schema
 * inside one literal. Returns the exact union member so type extraction can
 * see the schema.
 */
export type LambderRateLimitKeyBuilder<TCtx> = {
    <TInput extends z.ZodType>(key: { apiInput: TInput; handler: (ctx: TCtx, payload: z.output<TInput>) => string | Promise<string> }): { apiInput: TInput; handler: (ctx: TCtx, payload: z.output<TInput>) => string | Promise<string> };
    (key: { handler: (ctx: TCtx, payload: undefined) => string | Promise<string> }): { apiInput?: undefined; handler: (ctx: TCtx, payload: undefined) => string | Promise<string> };
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
export const lambderRateLimitKeyBuilder = <TCtx>(): LambderRateLimitKeyBuilder<TCtx> =>
    ((key: LambderRateLimitKeyFn<any, any>) => key) as LambderRateLimitKeyBuilder<TCtx>;

/** What one rate-limit counter tracks: the client IP, the session identity, or a custom payload-derived key. */
export type LambderRateLimitPer<TCtx = any> = "ip" | "session" | LambderRateLimitKeyFn<any, TCtx>;

/**
 * What one budget spans:
 *
 * - "perApi" (default): every API referencing the policy gets its own
 *   counter, so the windows are a per-API ceiling (three APIs referencing a
 *   60/min policy allow one subject 180/min in total). An API may tune the
 *   windows in its declaration: `rateLimit: { name: { perMin: 20 } }`.
 * - "perPolicy": every API referencing the policy shares ONE counter, so the
 *   windows are one combined budget (e.g. one per-email allowance across
 *   send, register, and reset). The policy IS the group: to give user APIs
 *   and report APIs separate shared budgets, declare two policies.
 */
export type LambderRateLimitBudget = "perApi" | "perPolicy";

/**
 * When a custom-keyed policy is charged, relative to the guards and the input
 * schema.
 *
 * - "afterGuards" (default): after every guard and the input schema passed.
 *   The key is a value the caller chose (an email in the payload), so a
 *   caller who never passes a captcha guard cannot spend a victim's budget
 *   and lock them out of reset, register and send-code.
 * - "beforeGuards": before the guards and the input schema, so an attempt
 *   they refuse is counted too. For a limit on guessing a secret a guard or
 *   the schema checks (a one-time code checked by a guard, keyed per email):
 *   charged after them, a wrong guess is refused before it is ever counted.
 *   Pair it with an IP limit, since anyone may spend this budget.
 */
export type LambderRateLimitChargeAt = "beforeGuards" | "afterGuards";

/**
 * A named rate-limit policy: fixed windows, the key one counter tracks, and
 * what one budget spans.
 *
 * Generic over the context a custom key handler receives, so the adapter's
 * policies map pins it: the server's is the render context, the mock's is the
 * mock call context. Left open, a handler written for one adapter would
 * compile against the other and read fields that are not there.
 */
export type LambderApiRateLimitPolicyConfig<TCtx = any> = LambderRateLimitPolicy & {
    /**
     * What one counter tracks when an API declares the policy. Left out, the
     * policy is keyed by the code that charges it (`ctx.rateLimit(name, key)`
     * in a handler), for a key only the handler knows, such as one recipient
     * of an invitation; such a policy cannot be named in an API's `rateLimit`
     * option, since the request alone does not say what to count.
     */
    per?: LambderRateLimitPer<TCtx>;
    /** Whether the windows are a per-API ceiling (default) or one budget shared by every referencing API. See LambderRateLimitBudget. */
    budget?: LambderRateLimitBudget;
    /**
     * When a policy keyed by a `{ apiInput?, handler }` key is charged. See
     * LambderRateLimitChargeAt. Default: "afterGuards". Only such a policy
     * takes it: `per: "ip"` and `per: "session"` have one place each.
     */
    chargeAt?: LambderRateLimitChargeAt;
    /** Envelope errorMessage for refused requests; inherits code "lambder/rate-limited" unless it sets its own. Default: a warning saying too many requests. */
    errorMessage?: LambderAppRefusalMessage;
};

export type LambderApiRateLimitsConfig<TPolicies extends Record<string, LambderApiRateLimitPolicyConfig<any>>> = {
    /** Your limiter instance (LambderDdbRateLimiter, LambderMemoryRateLimiter, or your own); its table and keyPrefix apply as configured on it. */
    limiter: LambderRateLimiter;
    /** Named policies referenced (typed) from addApi/addSessionApi. */
    policies: TPolicies;
    /**
     * Let the request through when the limiter itself fails (the table is
     * down, an IAM action is missing), instead of failing the request.
     * Default: true, and the failure is logged either way.
     *
     * It lives here rather than on a limiter because it is a decision about
     * the REQUEST, not the store: on the limiter, every custom limiter would
     * need its own, and two limiters could answer the same outage
     * differently. Set it to false where an unmetered request is worse than
     * a refused one.
     */
    failOpen?: boolean;
    /**
     * How much of an IPv6 address one `per: "ip"` counter covers. A
     * subscriber, a VPS included, holds at least a /64 and may pick any
     * address inside it, so counting full addresses gives anyone who rotates
     * a fresh counter per request. Default: 64. A smaller number (48, 56)
     * counts a whole allocation as one caller.
     */
    ipv6PrefixLength?: number;
};

/**
 * A policy's `per` as its type declares it: undefined for a policy declared
 * without one, and a union holding undefined for a policy typed as the
 * general LambderApiRateLimitPolicyConfig, where only registration can tell.
 */
type LambderPolicyPerOf<TPolicy> = "per" extends keyof TPolicy ? TPolicy["per" & keyof TPolicy] : undefined;

/**
 * Policy names an API may reference: session-keyed policies only on session
 * APIs, apiInput-keyed policies only when the API's payload carries the
 * key's fields, and never a policy without `per`, whose key only the code
 * that charges it knows. A policy whose type does not settle its `per` is
 * allowed here and checked at registration.
 *
 * The payload is compared whole, as the guards' check does it: a union input
 * one of whose members lacks the key's fields does not carry them, and every
 * request of that member would be refused by the key slice's parse.
 */
export type LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession extends boolean> = {
    [K in keyof TPolicies]:
        [LambderPolicyPerOf<TPolicies[K]>] extends [undefined] ? never
        : [LambderPolicyPerOf<TPolicies[K]>] extends ["session"] ? (TIncludeSession extends true ? K : never)
        : [LambderPolicyPerOf<TPolicies[K]>] extends [{ apiInput: infer S extends z.ZodType }] ? ([TPayload] extends [z.input<S>] ? K : never)
        : K
}[keyof TPolicies] & string;

/**
 * Policy names a handler may charge itself: every policy except one keyed by
 * a `{ apiInput?, handler }` key, which derives its key from an API's payload
 * and so is charged by the APIs that declare it.
 */
export type LambderChargeablePolicyNames<TPolicies> = {
    [K in keyof TPolicies]: TPolicies[K] extends { per: LambderRateLimitKeyFn<any, any> } ? never : K
}[keyof TPolicies] & string;

/**
 * The key argument charging a policy takes: none for `per: "ip"` and
 * `per: "session"`, which the request supplies, and the key itself for a
 * policy that declares no `per`. Optional where the types cannot tell: on a
 * context that does not know the app's policies (a hook's, a guard's), and
 * for a policy typed as the general LambderApiRateLimitPolicyConfig.
 */
export type LambderChargeKeyArgs<TPolicies, K> =
    string extends K ? [key?: string]
    : string extends keyof TPolicies ? [key?: string]
    : K extends keyof TPolicies
        ? [LambderPolicyPerOf<TPolicies[K]>] extends [undefined] ? [key: string]
        : [LambderPolicyPerOf<TPolicies[K]>] extends ["ip" | "session"] ? []
        : undefined extends LambderPolicyPerOf<TPolicies[K]> ? [key?: string]
        : [key: string]
    : never;

/**
 * What `ctx.isRateLimited` answers: false when the attempt was allowed,
 * otherwise the window that refused it, when that window resets, and the
 * seconds until then.
 */
export type LambderRateLimitCheckResult = false | (LambderRateLimitExceeded & { retryAfterSeconds: number });

/**
 * `ctx.rateLimit(policy, key?)`: counts one attempt against a named policy
 * and, when it is over, refuses the request the way a declared limit does (a
 * 429 with Retry-After and the policy's errorMessage). For a limit whose key
 * only the handler knows, or one to charge only on some paths through it.
 *
 * The key tuple is NoInfer: left inferable, a key passed where none belongs
 * would infer K as a string, which the constraint widens to every policy
 * name, and the call would then accept the key it has to refuse.
 */
export type LambderContextRateLimit<TPolicies> =
    <K extends LambderChargeablePolicyNames<TPolicies>>(policy: K, ...key: NoInfer<LambderChargeKeyArgs<TPolicies, K>>) => Promise<void>;

/**
 * `ctx.isRateLimited(policy, key?)`: the same count, answered rather than
 * thrown, for a handler that says "too many" in its own output shape.
 */
export type LambderContextRateLimitCheck<TPolicies> =
    <K extends LambderChargeablePolicyNames<TPolicies>>(policy: K, ...key: NoInfer<LambderChargeKeyArgs<TPolicies, K>>) => Promise<LambderRateLimitCheckResult>;

/** Who is charging a policy from code: the API the call is (null on a route), and what a `per: "ip"` or `per: "session"` key reads. */
export type LambderRateLimitChargeSubject = {
    apiName: string | null;
    ip: string;
    session: LambderSessionRecord<any> | null;
    /** The key the code supplied; required for a policy without `per`, refused for any other. */
    key: string | undefined;
};

/** What charging a policy from code came to: the check result, and the refusal to throw when it is over. */
export type LambderRateLimitChargeResult = {
    checkResult: LambderRateLimitCheckResult;
    refusal: LambderApiRefusal | null;
};

type LambderRateLimitOverrideFor<TPolicy> =
    TPolicy extends { budget: "perPolicy" } ? Pick<LambderRateLimitOverride, "errorMessage"> : LambderRateLimitOverride;

/** The map form's full shape: every referable policy name, each carrying its own override. */
type LambderRateLimitMap<TPolicies, TPayload, TIncludeSession extends boolean> = {
    readonly [K in LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession> & keyof TPolicies]?:
        true | LambderRateLimitOverrideFor<TPolicies[K]> };

/**
 * The per-API `rateLimit` option: one policy name, a non-empty ordered list
 * of names, or a non-empty object map that can carry each policy's override
 * (`true` applies the policy as declared). Map entries are checked in
 * insertion order.
 *
 * Every form is non-empty by construction (LambderNonEmptyOptionMap, as the
 * guards option uses), since `rateLimit: {}`, `rateLimit: []` and
 * `rateLimit: { policy: undefined }` would announce a limit and enforce none.
 */
export type LambderRateLimitOption<TPolicies, TPayload, TIncludeSession extends boolean> =
    | LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>
    | readonly [LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>,
        ...LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>[]]
    | LambderNonEmptyOptionMap<LambderRateLimitMap<TPolicies, TPayload, TIncludeSession>>;

type LambderRateLimitEntry = { name: string, override?: LambderRateLimitOverride };

/** Normalize the three rateLimit-option forms into ordered entries; an explicit `undefined` map value declares nothing. */
const toRateLimitEntries = (value?: LambderRateLimitOptionValue): LambderRateLimitEntry[] => {
    if(value === undefined) return [];
    if(typeof value === "string") return [{ name: value }];
    if(Array.isArray(value)) return value.map((name: string) => ({ name }));
    return Object.entries(value).flatMap(([name, override]): LambderRateLimitEntry[] =>
        override === undefined ? [] : override === true ? [{ name }] : [{ name, override }]);
};

/**
 * A limiter is handed only limits it can act on, so no implementation has to
 * invent an answer for a nonsense one (where two limiters would drift apart,
 * one refusing the first attempt against a negative cap and one allowing it).
 * Zero is legal and leaves the window unenforced, hence non-negative rather
 * than positive.
 */
const assertWindowLimits = (subject: string, windows: Partial<Record<LambderRateLimitWindow, number>>): void => {
    for(const key of RATE_LIMIT_WINDOW_KEYS){
        const limit = windows[key];
        if(limit === undefined) continue;
        assertNonNegativeInteger(limit, `${subject} caps ${key} at ${String(limit)}; a window's limit`);
    }
};

const hasWindowOverride = (override: LambderRateLimitOverride): boolean =>
    RATE_LIMIT_WINDOW_KEYS.some((key) => override[key] !== undefined);

/**
 * When in a call a policy is checked.
 *
 * - `per: "ip"` is known from the request alone, so it runs before the
 *   session read and bounds how often one address may make the session store
 *   look a token up.
 * - `per: "session"` needs the session, so it runs after the read, and
 *   before the guards, which it protects the same way.
 * - A custom key runs where its policy's `chargeAt` puts it (see
 *   LambderRateLimitChargeAt): after the guards by default, or with the
 *   session-keyed limits, before the guards, for "beforeGuards".
 */
type LambderRateLimitPhase = "beforeSession" | LambderRateLimitChargeAt;

const phaseOf = (per: LambderRateLimitPer, chargeAt: LambderRateLimitChargeAt | undefined): LambderRateLimitPhase => {
    if(per === "ip") return "beforeSession";
    if(per === "session") return "beforeGuards";
    return chargeAt ?? "afterGuards";
};

/** The windows one check ran against, for a log line that must not carry the tracker key. */
const describeWindows = (limits: LambderRateLimitPolicy): string =>
    RATE_LIMIT_WINDOW_KEYS.filter((key) => limits[key] !== undefined).map((key) => `${key}: ${String(limits[key])}`).join(", ") || "no window";

/** The windows a check runs against: the policy's own, each replaced by the API's override where it names one. */
const windowsOf = (policy: LambderApiRateLimitPolicyConfig, override?: LambderRateLimitOverride): LambderRateLimitPolicy => {
    const limits: LambderRateLimitPolicy = {};
    for(const windowKey of RATE_LIMIT_WINDOW_KEYS){
        const limit = override?.[windowKey] ?? policy[windowKey];
        if(limit !== undefined) limits[windowKey] = limit;
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
const trackerKeyOf = (name: string, policy: LambderApiRateLimitPolicyConfig, apiName: string | null, key: string): string =>
    policy.budget === "perPolicy" || apiName === null
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
 */
export class LambderApiRateLimitsEngine {
    private limiter: LambderRateLimiter | null = null;
    private failOpen = true;
    private ipv6PrefixLength = DEFAULT_IPV6_RATE_LIMIT_PREFIX;
    // A Map, not a plain object: an object answers for "toString" and
    // "constructor" through its prototype, so a policy named one of those
    // would slip past the registration check and fail on every request.
    private policies = new Map<string, LambderApiRateLimitPolicyConfig>();
    /**
     * The limiter failures already logged. A limiter answering a run of
     * requests with one continuing failure throws the same error for each
     * (see LambderRateLimiter), and a flood of a few thousand requests a
     * second would otherwise be as many identical log lines.
     */
    private readonly loggedFailures = new WeakSet<object>();

    /** True once rateLimits were configured. */
    get isConfigured(): boolean { return this.limiter !== null; }

    configure(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void {
        if(this.limiter) throw new Error("Lambder: rateLimits were already configured.");
        // Declaring the option is declaring a limit, as for the guards option
        // and an API's own `rateLimit: {}`. An empty map would configure a
        // limiter with nothing to enforce, and every API naming a policy would
        // be reported as if the option were missing: the wrong line to fix.
        if(Object.keys(config.policies).length === 0){
            throw new Error("Lambder: the rateLimits option was declared with no policies in it, which configures nothing. Name the policies APIs will declare, or leave the option off.");
        }
        for(const [name, policy] of Object.entries(config.policies)){
            const per = policy.per as LambderRateLimitPer | undefined;
            if(per !== undefined && per !== "ip" && per !== "session" && typeof per?.handler !== "function"){
                throw new Error(`Lambder: rate-limit policy "${name}" has a per that is not "ip", "session", or a { apiInput?, handler } key. Leave per out for a policy the handler charges with its own key.`);
            }
            if(!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])){
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
            assertWindowLimits(`rate-limit policy "${name}"`, policy);
            const chargeAt = policy.chargeAt as LambderRateLimitChargeAt | undefined;
            if(chargeAt !== undefined){
                if(chargeAt !== "beforeGuards" && chargeAt !== "afterGuards"){
                    throw new Error(`Lambder: rate-limit policy "${name}" has chargeAt "${String(chargeAt)}"; use "afterGuards" (default) or "beforeGuards".`);
                }
                if(per === undefined || per === "ip" || per === "session"){
                    throw new Error(`Lambder: rate-limit policy "${name}" sets chargeAt, which only a policy keyed by a { apiInput?, handler } key takes: per "ip" and per "session" each run at one fixed place, and a policy without per is charged by the code that names it.`);
                }
            }
            const budget = policy.budget as LambderRateLimitBudget | undefined;
            if(budget !== undefined && budget !== "perApi" && budget !== "perPolicy"){
                throw new Error(`Lambder: rate-limit policy "${name}" has budget "${String(budget)}"; use "perApi" (default: each referencing API counts separately) or "perPolicy" (one counter shared by every referencing API).`);
            }
        }
        const ipv6PrefixLength = config.ipv6PrefixLength ?? DEFAULT_IPV6_RATE_LIMIT_PREFIX;
        if(!Number.isInteger(ipv6PrefixLength) || ipv6PrefixLength < 1 || ipv6PrefixLength > 128){
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
    [LAMBDER_BACKEND_SWAP](limiter: LambderRateLimiter): boolean {
        if(!this.limiter) return false;
        this.limiter = limiter;
        return true;
    }

    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName: string, mode: LambderApiMode, rateLimitOption?: LambderRateLimitOptionValue): void {
        const entries = toRateLimitEntries(rateLimitOption);
        // Declaring the option is declaring a limit, as for guards: `{}`,
        // `[]` and `{ name: undefined }` would register an API that
        // announces a rate limit and enforces none.
        if(rateLimitOption !== undefined && entries.length === 0){
            throw new Error(
                `Lambder: API "${apiName}" declares an empty rateLimit option, which limits nothing. ` +
                `Name the policy that limits it, or omit the option entirely.`
            );
        }
        for(const { name, override } of entries){
            const policy = this.policies.get(name);
            if(!policy){
                throw new Error(`Lambder: API "${apiName}" references unknown rate-limit policy "${name}". Declare it in the rateLimits option at creation.`);
            }
            if(policy.per === undefined){
                throw new Error(`Lambder: API "${apiName}" references rate-limit policy "${name}", which declares no per: its key is the one a handler passes to ctx.rateLimit("${name}", key), so the request alone cannot be counted against it.`);
            }
            if(policy.per === "session" && mode !== "session"){
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which requires addSessionApi.`);
            }
            if(override) assertWindowLimits(`API "${apiName}" override of rate-limit policy "${name}"`, override);
            if(override && hasWindowOverride(override) && !RATE_LIMIT_WINDOW_KEYS.some((key) => (override[key] ?? policy[key]))){
                throw new Error(
                    `Lambder: API "${apiName}" overrides rate-limit policy "${name}" down to no enforced window, which limits nothing. ` +
                    `A policy is required to declare a window; an override may not take the last one away.`
                );
            }
            if(override && policy.budget === "perPolicy" && hasWindowOverride(override)){
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
    async run(apiName: string, request: LambderApiRequest, ctx: LambderApiCallContext, rateLimitOption: LambderRateLimitOptionValue | undefined, phase: LambderRateLimitPhase): Promise<void> {
        for(const { name, override } of toRateLimitEntries(rateLimitOption)){
            // Registration refused an unknown policy and one without per.
            const policy = this.policies.get(name)!;
            const per = policy.per!;
            if(phaseOf(per, policy.chargeAt) !== phase) continue;
            const key = await this.resolveKey(name, request, ctx, per);
            const limits = windowsOf(policy, override);
            const exceeded = await this.countAttempt(name, trackerKeyOf(name, policy, apiName, key), limits, `API "${apiName}"`);
            if(exceeded){
                throw rateLimitRefusal(
                    `Rate limited: "${apiName}" exceeded policy "${name}" (${exceeded.window}: ${exceeded.limit}).`,
                    this.retryAfterOf(exceeded),
                    override?.errorMessage ?? policy.errorMessage,
                );
            }
        }
    }

    /**
     * One policy charged by code rather than by a declaration, for
     * `ctx.rateLimit` and `ctx.isRateLimited`. Counters, failOpen, key
     * bounding and refusal are those of a declared limit; only who knows the
     * key differs. A policy without `per` takes the key the code passes, a
     * `per: "ip"` or `per: "session"` one reads it off the request, and one
     * keyed by an API payload is refused, since only its APIs know the key.
     */
    async chargePolicy(name: string, subject: LambderRateLimitChargeSubject): Promise<LambderRateLimitChargeResult> {
        if(!this.limiter) throw new Error(`Lambder: charging rate-limit policy "${name}" needs the rateLimits option at creation.`);
        const policy = this.policies.get(name);
        if(!policy) throw new Error(`Lambder: unknown rate-limit policy "${name}". Declare it in the rateLimits option at creation.`);
        const key = await this.chargeKeyOf(name, policy, subject);
        const limits = windowsOf(policy);
        const where = subject.apiName === null ? "a route" : `API "${subject.apiName}"`;
        const exceeded = await this.countAttempt(name, trackerKeyOf(name, policy, subject.apiName, key), limits, where);
        if(!exceeded) return { checkResult: false, refusal: null };
        const retryAfterSeconds = this.retryAfterOf(exceeded);
        return {
            checkResult: { ...exceeded, retryAfterSeconds },
            refusal: rateLimitRefusal(`Rate limited: ${where} exceeded policy "${name}" (${exceeded.window}: ${exceeded.limit}).`, retryAfterSeconds, policy.errorMessage),
        };
    }

    /**
     * Seconds until the refusing window resets, read against the limiter's
     * own clock when it keeps one: `resetAt` is a second on that clock, and a
     * limiter under a test clock would otherwise be told a Retry-After
     * measured from another time entirely.
     */
    private retryAfterOf(exceeded: LambderRateLimitExceeded): number {
        const nowMilliseconds = this.limiter?.clockMilliseconds?.() ?? Date.now();
        return Math.max(1, exceeded.resetAt - Math.floor(nowMilliseconds / 1000));
    }

    /**
     * Counts one attempt, or lets it through when the limiter itself fails
     * and failOpen is on. The log line names the policy and its windows,
     * never the tracker key: the key carries whatever a custom handler
     * returned, which the docs' own example makes an email address. A
     * failure the limiter throws again (see loggedFailures) is not logged
     * again.
     */
    private async countAttempt(name: string, trackerKey: string, limits: LambderRateLimitPolicy, where: string): Promise<LambderRateLimitExceeded | false> {
        try {
            return await this.limiter!.isRateLimited(trackerKey, limits);
        }catch(limiterErr){
            if(!this.failOpen) throw limiterErr;
            if(typeof limiterErr === "object" && limiterErr !== null){
                if(this.loggedFailures.has(limiterErr)) return false;
                this.loggedFailures.add(limiterErr);
            }
            console.error(
                `Lambder rate limits: policy "${name}" (${describeWindows(limits)}) could not be checked for ${where}; ` +
                "the request is being allowed through. Set rateLimits.failOpen: false to refuse instead.",
                limiterErr,
            );
            return false;
        }
    }

    private async chargeKeyOf(name: string, policy: LambderApiRateLimitPolicyConfig, subject: LambderRateLimitChargeSubject): Promise<string> {
        const per = policy.per;
        if(per === undefined){
            if(subject.key === undefined) throw new Error(`Lambder: rate-limit policy "${name}" declares no per, so the code charging it passes the key: ctx.rateLimit("${name}", key).`);
            return await boundKeyField("custom", subject.key);
        }
        if(per !== "ip" && per !== "session"){
            throw new Error(`Lambder: rate-limit policy "${name}" derives its key from an API's payload, so only the APIs declaring it can charge it.`);
        }
        if(subject.key !== undefined) throw new Error(`Lambder: rate-limit policy "${name}" is keyed per "${per}", so charging it takes no key.`);
        return await this.requestKeyOf(name, per, subject.ip, subject.session);
    }

    private async resolveKey(name: string, request: LambderApiRequest, ctx: LambderApiCallContext, per: LambderRateLimitPer): Promise<string> {
        if(per === "ip" || per === "session") return await this.requestKeyOf(name, per, request.ip, ctx.session);
        const payload = per.apiInput ? await parsePreflightSlice(per.apiInput, request.payload) : undefined;
        return await boundKeyField("custom", await per.handler(ctx, payload as never));
    }

    /**
     * The key a `per: "ip"` or `per: "session"` policy counts under: what the
     * request carries, however the policy is charged. A session key is
     * bounded like a custom one (see boundKeyField); an address needs no
     * bound, since normalizeClientIp caps it at 45 characters whichever
     * header or gateway field named it.
     */
    private async requestKeyOf(name: string, per: "ip" | "session", ip: string, session: LambderSessionRecord<any> | null): Promise<string> {
        if(per === "ip") return `ip:${rateLimitSubjectOf(ip, this.ipv6PrefixLength)}`;
        const sessionKey = session?.sessionKey;
        if(!sessionKey) throw new Error(`Lambder: rate-limit policy "${name}" is keyed per "session", and the request charging it has no session.`);
        return await boundKeyField("session", sessionKey);
    }
}

import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type { LambderRateLimitOptionValue, LambderRateLimitOverride } from "../shared/wire/LambderApiOptionValues.js";
import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext } from "./LambderApiCallContext.js";
import { type LambderRateLimiter, type LambderRateLimitExceeded, type LambderRateLimitPolicy } from "../shared/contracts/LambderRateLimiter.js";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import { LambderApiRefusal, type LambderAppRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import type { LambderNonEmptyOptionMap } from "../shared/util/LambderTypeUtilities.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
/** Refusal a rate-limited request answers unless the policy or the API's override names its own. */
export declare const DEFAULT_RATE_LIMIT_REFUSAL: {
    type: "warning";
    code: "lambder/rate-limited";
    content: string;
};
/**
 * The refusal a rate-limited call answers with: a 429 envelope carrying the
 * framework code (a policy's own message inherits it unless it sets a more
 * specific one) and a Retry-After header. The engine throws it; the mock
 * runtime's failure injection throws the same one, so an injected rate
 * limit is indistinguishable from a real one.
 */
export declare const rateLimitRefusal: (detail: string, retryAfterSeconds: number, message?: LambderAppRefusalMessage) => LambderApiRefusal;
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
    <TInput extends z.ZodType>(key: {
        apiInput: TInput;
        handler: (ctx: TCtx, payload: z.output<TInput>) => string | Promise<string>;
    }): {
        apiInput: TInput;
        handler: (ctx: TCtx, payload: z.output<TInput>) => string | Promise<string>;
    };
    (key: {
        handler: (ctx: TCtx, payload: undefined) => string | Promise<string>;
    }): {
        apiInput?: undefined;
        handler: (ctx: TCtx, payload: undefined) => string | Promise<string>;
    };
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
export declare const lambderRateLimitKeyBuilder: <TCtx>() => LambderRateLimitKeyBuilder<TCtx>;
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
    [K in keyof TPolicies]: [
        LambderPolicyPerOf<TPolicies[K]>
    ] extends [undefined] ? never : [LambderPolicyPerOf<TPolicies[K]>] extends ["session"] ? (TIncludeSession extends true ? K : never) : [LambderPolicyPerOf<TPolicies[K]>] extends [{
        apiInput: infer S extends z.ZodType;
    }] ? ([TPayload] extends [z.input<S>] ? K : never) : K;
}[keyof TPolicies] & string;
/**
 * Policy names a handler may charge itself: every policy except one keyed by
 * a `{ apiInput?, handler }` key, which derives its key from an API's payload
 * and so is charged by the APIs that declare it.
 */
export type LambderChargeablePolicyNames<TPolicies> = {
    [K in keyof TPolicies]: TPolicies[K] extends {
        per: LambderRateLimitKeyFn<any, any>;
    } ? never : K;
}[keyof TPolicies] & string;
/**
 * The key argument charging a policy takes: none for `per: "ip"` and
 * `per: "session"`, which the request supplies, and the key itself for a
 * policy that declares no `per`. Optional where the types cannot tell: on a
 * context that does not know the app's policies (a hook's, a guard's), and
 * for a policy typed as the general LambderApiRateLimitPolicyConfig.
 */
export type LambderChargeKeyArgs<TPolicies, K> = string extends K ? [key?: string] : string extends keyof TPolicies ? [key?: string] : K extends keyof TPolicies ? [LambderPolicyPerOf<TPolicies[K]>] extends [undefined] ? [key: string] : [LambderPolicyPerOf<TPolicies[K]>] extends ["ip" | "session"] ? [] : undefined extends LambderPolicyPerOf<TPolicies[K]> ? [key?: string] : [key: string] : never;
/**
 * What `ctx.isRateLimited` answers: false when the attempt was allowed,
 * otherwise the window that refused it, when that window resets, and the
 * seconds until then.
 */
export type LambderRateLimitCheckResult = false | (LambderRateLimitExceeded & {
    retryAfterSeconds: number;
});
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
export type LambderContextRateLimit<TPolicies> = <K extends LambderChargeablePolicyNames<TPolicies>>(policy: K, ...key: NoInfer<LambderChargeKeyArgs<TPolicies, K>>) => Promise<void>;
/**
 * `ctx.isRateLimited(policy, key?)`: the same count, answered rather than
 * thrown, for a handler that says "too many" in its own output shape.
 */
export type LambderContextRateLimitCheck<TPolicies> = <K extends LambderChargeablePolicyNames<TPolicies>>(policy: K, ...key: NoInfer<LambderChargeKeyArgs<TPolicies, K>>) => Promise<LambderRateLimitCheckResult>;
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
type LambderRateLimitOverrideFor<TPolicy> = TPolicy extends {
    budget: "perPolicy";
} ? Pick<LambderRateLimitOverride, "errorMessage"> : LambderRateLimitOverride;
/** The map form's full shape: every referable policy name, each carrying its own override. */
type LambderRateLimitMap<TPolicies, TPayload, TIncludeSession extends boolean> = {
    readonly [K in LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession> & keyof TPolicies]?: true | LambderRateLimitOverrideFor<TPolicies[K]>;
};
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
export type LambderRateLimitOption<TPolicies, TPayload, TIncludeSession extends boolean> = LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession> | readonly [
    LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>,
    ...LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession>[]
] | LambderNonEmptyOptionMap<LambderRateLimitMap<TPolicies, TPayload, TIncludeSession>>;
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
/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPipeline. Reads the request (its ip, and a key's payload
 * slice) and hands the context to a custom key's handler, reading nothing
 * of the context itself but its session, so it runs unchanged under the
 * server and the mock runtime.
 */
export declare class LambderApiRateLimitsEngine {
    private limiter;
    private failOpen;
    private ipv6PrefixLength;
    private policies;
    /**
     * The limiter failures already logged. A limiter answering a run of
     * requests with one continuing failure throws the same error for each
     * (see LambderRateLimiter), and a flood of a few thousand requests a
     * second would otherwise be as many identical log lines.
     */
    private readonly loggedFailures;
    /** True once rateLimits were configured. */
    get isConfigured(): boolean;
    configure(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void;
    /**
     * Puts the engine over another limiter, for `lambder/testing`; the named
     * policies and failOpen stay as configured. False when rateLimits were
     * never configured: there is nothing for a limiter to sit under.
     */
    [LAMBDER_BACKEND_SWAP](limiter: LambderRateLimiter): boolean;
    /** Startup validation of one API registration's rateLimit option. */
    assertRegistration(apiName: string, mode: LambderApiMode, rateLimitOption?: LambderRateLimitOptionValue): void;
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
    run(apiName: string, request: LambderApiRequest, ctx: LambderApiCallContext, rateLimitOption: LambderRateLimitOptionValue | undefined, phase: LambderRateLimitPhase): Promise<void>;
    /**
     * One policy charged by code rather than by a declaration, for
     * `ctx.rateLimit` and `ctx.isRateLimited`. Counters, failOpen, key
     * bounding and refusal are those of a declared limit; only who knows the
     * key differs. A policy without `per` takes the key the code passes, a
     * `per: "ip"` or `per: "session"` one reads it off the request, and one
     * keyed by an API payload is refused, since only its APIs know the key.
     */
    chargePolicy(name: string, subject: LambderRateLimitChargeSubject): Promise<LambderRateLimitChargeResult>;
    /**
     * Seconds until the refusing window resets, read against the limiter's
     * own clock when it keeps one: `resetAt` is a second on that clock, and a
     * limiter under a test clock would otherwise be told a Retry-After
     * measured from another time entirely.
     */
    private retryAfterOf;
    /**
     * Counts one attempt, or lets it through when the limiter itself fails
     * and failOpen is on. The log line names the policy and its windows,
     * never the tracker key: the key carries whatever a custom handler
     * returned, which the docs' own example makes an email address. A
     * failure the limiter throws again (see loggedFailures) is not logged
     * again.
     */
    private countAttempt;
    private chargeKeyOf;
    private resolveKey;
    /**
     * The key a `per: "ip"` or `per: "session"` policy counts under: what the
     * request carries, however the policy is charged. A session key is
     * bounded like a custom one (see boundKeyField); an address needs no
     * bound, since normalizeClientIp caps it at 45 characters whichever
     * header or gateway field named it.
     */
    private requestKeyOf;
}
export {};

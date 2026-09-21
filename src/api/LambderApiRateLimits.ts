import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type { LambderRateLimitOptionValue, LambderRateLimitOverride } from "../shared/wire/LambderApiOptionValues.js";
import { joinKeyFields } from "../shared/util/LambderKeyFields.js";
import { sha256HexOf } from "../shared/util/LambderTextDigest.js";
import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext } from "./LambderApiCallContext.js";
import {
    RATE_LIMIT_WINDOWS,
    type LambderRateLimiter,
    type LambderRateLimitPolicy,
    type LambderRateLimitWindow,
} from "../shared/contracts/LambderRateLimiter.js";
import { LambderApiRefusal, LAMBDER_REFUSAL_CODES, type LambderAppRefusalMessage, type LambderRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import { parsePreflightSlice } from "./LambderApiValidationRefusal.js";
import type { LambderNonEmptyOptionMap } from "../shared/util/LambderTypeUtilities.js";
import { assertNonNegativeInteger } from "../shared/util/LambderOptionChecks.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";

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
 * payload the key derives from: the slice is validated against the raw
 * payload before `handler` runs (failures answer like regular input
 * validation, through setApiInputValidationErrorHandler when set) and the
 * handler receives it typed. Referencing the policy from an API whose input
 * schema does not carry those fields is a compile error, so the API's schema
 * stays the single owner of the field. Build with lambderRateLimitKey() so
 * the handler's payload type follows `apiInput`. The context is the
 * adapter's (the render context on the server); the engine reads nothing
 * from it itself.
 *
 * ONE member, with `apiInput` optional, rather than a union of the two
 * shapes: a union with a function member in each arm defeats contextual
 * typing, so annotating a policies map with LambderRateLimitPer or
 * LambderApiRateLimitPolicyConfig left `ctx` implicitly any and the
 * annotation did not compile at all. The builder's overloads are where the
 * apiInput/payload correlation is kept.
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
 * context the adapter runs on, and the two adapters run on different ones. A
 * single builder pinned to the server's context type compiled against the
 * mock and then handed the handler a context with no `ip`, `method` or
 * `path`, so every caller collapsed onto one counter and the limit a test was
 * written to prove silently proved nothing.
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
 * A named rate-limit policy: fixed windows, the key one counter tracks, and
 * what one budget spans.
 *
 * Generic over the context a custom key handler receives, so the adapter's
 * policies map pins it: the server's is the render context, the mock's is the
 * mock call context. Left open, a handler written for one adapter compiled
 * against the other and then read fields that were not there.
 */
export type LambderApiRateLimitPolicyConfig<TCtx = any> = LambderRateLimitPolicy & {
    per: LambderRateLimitPer<TCtx>;
    /** Whether the windows are a per-API ceiling (default) or one budget shared by every referencing API. See LambderRateLimitBudget. */
    budget?: LambderRateLimitBudget;
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
     * It lives here rather than on a limiter implementation because it is a
     * decision about the REQUEST, not about a store: a custom limiter had no
     * fail-open at all, and two limiters could answer the same outage
     * differently. Set it to false on an app where an unmetered request is
     * worse than a refused one.
     */
    failOpen?: boolean;
};

/**
 * Policy names an API may reference: session-keyed policies only on session
 * APIs, and apiInput-keyed policies only when the API's payload carries the
 * key's fields.
 */
export type LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession extends boolean> = {
    [K in keyof TPolicies]:
        TPolicies[K] extends { per: "session" }
            ? (TIncludeSession extends true ? K : never)
            : TPolicies[K] extends { per: { apiInput: infer S extends z.ZodType } }
                ? (TPayload extends z.output<S> ? K : never)
                : K
}[keyof TPolicies] & string;

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
 * Every form is non-empty by construction, the same machinery the guards
 * option uses (LambderNonEmptyOptionMap): `rateLimit: {}`, `rateLimit: []`
 * and `rateLimit: { policy: undefined }` announce a limit and enforce none.
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
 * invent an answer for a nonsense one: that is where two limiters drift apart,
 * one refusing the first attempt against a negative cap and the other allowing
 * it. Zero is legal and leaves the window
 * unenforced, which is why this is the non-negative check and not the
 * positive one.
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
 * When in a call a policy can be checked. A `per: "ip"` counter is known from
 * the request alone, so it runs before the session read and bounds how often
 * one address may make the session store look a token up. Everything else
 * runs after: `per: "session"` needs the session, and a custom key handler is
 * app code that may read ctx.session too.
 */
type LambderRateLimitPhase = "beforeSession" | "afterSession";

const phaseOf = (per: LambderRateLimitPer): LambderRateLimitPhase => per === "ip" ? "beforeSession" : "afterSession";

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
const boundTrackerKeyPart = async (kind: "session" | "custom", value: string): Promise<string> =>
    new TextEncoder().encode(value).length > MAX_TRACKER_KEY_PART_BYTES
        ? `${kind}:h:${await sha256HexOf(value)}`
        : `${kind}:${value}`;

/** The windows one check ran against, for a log line that must not carry the tracker key. */
const describeWindows = (limits: LambderRateLimitPolicy): string =>
    RATE_LIMIT_WINDOW_KEYS.filter((key) => limits[key] !== undefined).map((key) => `${key}: ${String(limits[key])}`).join(", ") || "no window";

/**
 * Runtime side of the rate-limit subsystem: holds the limiter and its named
 * policies, asserts API registrations against them at startup, and checks an
 * API's declared policies during preflight. Composed into
 * LambderApiPolicyEngine. Reads the request's ip and the context's session
 * and nothing else, so it runs unchanged under the server and the mock
 * runtime.
 */
export class LambderApiRateLimitsEngine {
    private limiter: LambderRateLimiter | null = null;
    private failOpen = true;
    // A Map for the same reason the guard registry is one: a plain object
    // answers for "toString" and "constructor" through its prototype, so a
    // policy named one of those would slip past the registration check and
    // fail on every request instead.
    private policies = new Map<string, LambderApiRateLimitPolicyConfig>();

    /** True once rateLimits were configured. */
    get isConfigured(): boolean { return this.limiter !== null; }

    configure(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void {
        if(this.limiter) throw new Error("Lambder: rateLimits were already configured.");
        // The same rule the guards option follows, and the one an API's own
        // `rateLimit: {}` is already held to: declaring the option is
        // declaring a limit. An empty map configured a limiter with nothing to
        // enforce and reported every API that named a policy as if the option
        // had never been given, which sends the reader to the wrong line.
        if(Object.keys(config.policies).length === 0){
            throw new Error("Lambder: the rateLimits option was declared with no policies in it, which configures nothing. Name the policies APIs will declare, or leave the option off.");
        }
        for(const [name, policy] of Object.entries(config.policies)){
            const per = policy.per as LambderRateLimitPer | undefined;
            if(!per || (per !== "ip" && per !== "session" && typeof per.handler !== "function")){
                throw new Error(`Lambder: rate-limit policy "${name}" needs per: "ip", "session", or a { apiInput?, handler } key.`);
            }
            if(!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])){
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
            assertWindowLimits(`rate-limit policy "${name}"`, policy);
            const budget = policy.budget as LambderRateLimitBudget | undefined;
            if(budget !== undefined && budget !== "perApi" && budget !== "perPolicy"){
                throw new Error(`Lambder: rate-limit policy "${name}" has budget "${String(budget)}"; use "perApi" (default: each referencing API counts separately) or "perPolicy" (one counter shared by every referencing API).`);
            }
        }
        this.limiter = config.limiter;
        this.failOpen = config.failOpen ?? true;
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
        // The same rule the guards option follows: declaring the option is
        // declaring a limit. `{}`, `[]` and `{ name: undefined }` are
        // present-but-empty, and would otherwise register an API that
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
     * Run twice per call, once per phase: the policies whose key needs no
     * session are checked BEFORE the session is read, so a flood of requests
     * carrying bogus session cookies is refused without touching the session
     * store; the rest are checked after it, since `per: "session"` and a
     * custom key handler may both read ctx.session. Declared order is kept
     * inside each phase.
     */
    async run(apiName: string, request: LambderApiRequest, ctx: LambderApiCallContext, rateLimitOption: LambderRateLimitOptionValue | undefined, phase: LambderRateLimitPhase): Promise<void> {
        for(const { name, override } of toRateLimitEntries(rateLimitOption)){
            const policy = this.policies.get(name);
            if(!policy || !this.limiter) throw new Error(`Lambder: rate-limit policy "${name}" is not configured. Declare it in the rateLimits option at creation.`);
            if(phaseOf(policy.per) !== phase) continue;
            const key = await this.resolveKey(request, ctx, policy.per);
            // "perPolicy" shares one counter across every API referencing the
            // policy; "perApi" keys each API separately, which is also what
            // lets an API override the windows without colliding.
            const trackerKey = policy.budget === "perPolicy"
                ? joinKeyFields("policy", name, key)
                : joinKeyFields("api", apiName, name, key);
            const limits: LambderRateLimitPolicy = {};
            for(const windowKey of RATE_LIMIT_WINDOW_KEYS){
                const limit = override?.[windowKey] ?? policy[windowKey];
                if(limit !== undefined) limits[windowKey] = limit;
            }
            let exceeded: Awaited<ReturnType<LambderRateLimiter["isRateLimited"]>>;
            try {
                exceeded = await this.limiter.isRateLimited(trackerKey, limits);
            }catch(limiterErr){
                if(!this.failOpen) throw limiterErr;
                // The policy and its windows, never the tracker key: the key
                // carries whatever a custom handler returned, which the docs'
                // own example makes an email address, and a log line is not
                // the place for it.
                console.error(
                    `Lambder rate limits: policy "${name}" (${describeWindows(limits)}) could not be checked for API "${apiName}"; ` +
                    "the request is being allowed through. Set rateLimits.failOpen: false to refuse instead.",
                    limiterErr,
                );
                continue;
            }
            if(exceeded){
                const retryAfterSeconds = Math.max(1, exceeded.resetAt - Math.floor(Date.now() / 1000));
                throw rateLimitRefusal(
                    `Rate limited: "${apiName}" exceeded policy "${name}" (${exceeded.window}: ${exceeded.limit}).`,
                    retryAfterSeconds,
                    override?.errorMessage ?? policy.errorMessage,
                );
            }
        }
    }

    private async resolveKey(request: LambderApiRequest, ctx: LambderApiCallContext, per: LambderRateLimitPer): Promise<string> {
        if(per === "ip") return `ip:${request.ip}`;
        if(per === "session"){
            const sessionKey = ctx.session?.sessionKey;
            if(!sessionKey) throw new Error('Lambder: rate-limit per "session" evaluated without a session on the context.');
            return await boundTrackerKeyPart("session", sessionKey);
        }
        const payload = per.apiInput ? parsePreflightSlice(per.apiInput, request.payload) : undefined;
        return await boundTrackerKeyPart("custom", await per.handler(ctx, payload as never));
    }
}

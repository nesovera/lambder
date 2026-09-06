import type { z } from "zod";
import type { LambderRenderContext } from "./LambderContext.js";
import type LambderResolver from "./LambderResolver.js";
import type { LambderRateLimitPolicy, LambderDdbRateLimiter } from "./LambderDdbRateLimiter.js";
import type { LambderDdbIdempotency, LambderIdempotencyBeginResult } from "./LambderDdbIdempotency.js";
import { LambderApiError } from "./LambderApiError.js";
import { LambderResponse, type HttpStatusCode } from "./LambderResponse.js";

/** A crashed original must not block retries forever: pending claims expire on their own. */
const IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
/** Responses above this size skip replay storage (DynamoDB item limit is 400KB). */
const IDEMPOTENCY_MAX_STORED_BODY_BYTES = 350_000;

const RATE_LIMIT_WINDOW_KEYS: (keyof LambderRateLimitPolicy)[] = ["perMin", "per10Min", "perHour", "perDay", "perWeek", "perMonth"];

/**
 * A custom rate-limit key. `apiInput` names the fields of the API's OWN
 * payload the key derives from: the slice is validated against the raw
 * payload before `handler` runs (failures answer the standard 422 validation
 * shape) and the handler receives it typed. Referencing the policy from an
 * API whose input schema does not carry those fields is a compile error, so
 * the API's schema stays the single owner of the field. Build with
 * lambderRateLimitKey() so the handler's payload type follows `apiInput`.
 */
export type LambderRateLimitKeyFn<TInput extends z.ZodTypeAny = z.ZodTypeAny> =
    | { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> }
    | { apiInput?: undefined; handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> };

/**
 * Builder that ties the handler's payload type to the `apiInput` schema
 * inside one literal. Returns the exact union member so type extraction can
 * see the schema.
 */
export function lambderRateLimitKey<TInput extends z.ZodTypeAny>(key: { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> }): { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>) => string | Promise<string> };
export function lambderRateLimitKey(key: { handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> }): { apiInput?: undefined; handler: (ctx: LambderRenderContext, payload: undefined) => string | Promise<string> };
export function lambderRateLimitKey(key: LambderRateLimitKeyFn<any>): LambderRateLimitKeyFn<any> { return key; }

/** What one rate-limit counter tracks: the client IP, the session identity, or a custom payload-derived key. */
export type LambderRateLimitPer = "ip" | "session" | LambderRateLimitKeyFn<any>;

/** A named rate-limit policy: fixed windows plus the key one counter tracks. */
export type LambderApiRateLimitPolicyConfig = LambderRateLimitPolicy & {
    per: LambderRateLimitPer;
    /** Envelope errorMessage for refused requests. Default: a generic too-many-requests message. */
    errorMessage?: any;
};

export type LambderApiRateLimitsConfig<TPolicies extends Record<string, LambderApiRateLimitPolicyConfig>> = {
    /** Your limiter instance; its table, keyPrefix and failOpen apply as configured on it. */
    limiter: LambderDdbRateLimiter;
    /** Named policies referenced (typed) from addApi/addSessionApi. */
    policies: TPolicies;
};

export type LambderApiIdempotencyConfig = {
    /** Your idempotency store instance; may share the rate limiter's table (distinct key prefix). */
    store: LambderDdbIdempotency;
    /** Seconds a stored response replays for. Default: 86400 (24h). Per-API override: idempotency: { ttlSeconds }. */
    defaultTtlSeconds?: number;
    /** Skip idempotency (execute normally) when DynamoDB errors, instead of failing the request. Default: true. */
    failOpen?: boolean;
};

/**
 * A named guard, run before the API's own input validation. Two modes:
 *
 * - `apiInput`: the guard checks fields of the API's OWN payload. The slice
 *   is validated against the raw payload before `handler` runs and handed to
 *   it typed. The API's input schema stays the owner of those fields:
 *   declaring the guard on an API whose schema does not carry them is a
 *   compile error.
 * - `guardInput`: the guard has its own value the client sends SEPARATELY,
 *   outside the API payload, via the caller's options.guardInputs[name].
 *   The requirement lands on the API's contract (`guardInputs`), so the
 *   typed caller refuses to compile a call that does not send it. The API
 *   payload and handler never see the value.
 *
 * Either way a validation failure answers the standard 422 shape, and the
 * handler refuses by throwing (typically refuse()/LambderApiError). Build
 * with lambderGuard() so the handler's payload type follows the schema.
 */
export type LambderApiGuard<TInput extends z.ZodTypeAny = z.ZodTypeAny> =
    | { apiInput: TInput; guardInput?: undefined; handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void> }
    | { guardInput: TInput; apiInput?: undefined; handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void> }
    | { apiInput?: undefined; guardInput?: undefined; handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void> };

/**
 * Builder that ties the handler's payload type to the schema inside one
 * literal. Returns the exact union member so mode/type extraction works.
 */
export function lambderGuard<TInput extends z.ZodTypeAny>(guard: { apiInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void> }): { apiInput: TInput; guardInput?: undefined; handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void> };
export function lambderGuard<TInput extends z.ZodTypeAny>(guard: { guardInput: TInput; handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void> }): { guardInput: TInput; apiInput?: undefined; handler: (ctx: LambderRenderContext, payload: z.output<TInput>, res: LambderResolver) => void | Promise<void> };
export function lambderGuard(guard: { handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void> }): { apiInput?: undefined; guardInput?: undefined; handler: (ctx: LambderRenderContext, payload: undefined, res: LambderResolver) => void | Promise<void> };
export function lambderGuard(guard: LambderApiGuard<any>): LambderApiGuard<any> { return guard; }

/** Per-guard metadata carried on the Lambder instance: mode plus payload type. */
export type LambderGuardMeta<G> =
    G extends { apiInput: infer S extends z.ZodTypeAny } ? { apiInput: z.output<S> }
    : G extends { guardInput: infer S extends z.ZodTypeAny } ? { guardInput: z.output<S> }
    : {};
export type LambderGuardMetaMap<TGuards> = { [K in keyof TGuards]: LambderGuardMeta<TGuards[K]> };

type NamesIn<TOpt> = TOpt extends readonly (infer N extends string)[] ? N : TOpt extends string ? TOpt : never;

/** Guard names an API may declare: apiInput-mode guards only when the API's payload carries their fields. */
export type LambderAllowedGuardNames<TGuards, TPayload> = {
    [K in keyof TGuards]:
        TGuards[K] extends { apiInput: infer R } ? (TPayload extends R ? K : never) : K
}[keyof TGuards] & string;

/**
 * Policy names an API may reference: session-keyed policies only on session
 * APIs, and apiInput-keyed policies only when the API's payload carries the
 * key's fields.
 */
export type LambderAllowedPolicyNames<TPolicies, TPayload, TIncludeSession extends boolean> = {
    [K in keyof TPolicies]:
        TPolicies[K] extends { per: "session" }
            ? (TIncludeSession extends true ? K : never)
            : TPolicies[K] extends { per: { apiInput: infer S extends z.ZodTypeAny } }
                ? (TPayload extends z.output<S> ? K : never)
                : K
}[keyof TPolicies] & string;

type GuardInputsEntries<TGuards, TOpt> = {
    [K in Extract<NamesIn<TOpt>, keyof TGuards> as TGuards[K] extends { guardInput: any } ? K : never]:
        TGuards[K] extends { guardInput: infer V } ? V : never
};
/** The guardInputs map an API's contract requires clients to send; never when no declared guard uses guardInput mode. */
export type LambderGuardInputsOf<TGuards, TOpt> =
    keyof GuardInputsEntries<TGuards, TOpt> extends never ? never : GuardInputsEntries<TGuards, TOpt>;

const toList = (value?: string | readonly string[]): readonly string[] =>
    value === undefined ? [] : typeof value === "string" ? [value] : value;

/**
 * Runtime side of the declarative API options: holds what the enable/define
 * calls declared, asserts registrations against it at startup, and executes
 * rate limits, guards, and idempotency around handlers at request time.
 * Internal to Lambder; apps interact through enableApiRateLimits(),
 * enableApiIdempotency(), defineApiGuards() and the per-API options.
 */
export class LambderApiPolicyEngine {
    private limiter: LambderDdbRateLimiter | null = null;
    private rateLimitPolicies: Record<string, LambderApiRateLimitPolicyConfig> = {};
    private guards: Record<string, LambderApiGuard<any>> = {};
    private idempotencyStore: LambderDdbIdempotency | null = null;
    private idempotencyDefaultTtlSeconds = 24 * 3600;
    private idempotencyFailOpen = true;

    setRateLimits(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void {
        if(this.limiter) throw new Error("Lambder: enableApiRateLimits() was already called.");
        for(const [name, policy] of Object.entries(config.policies)){
            const per = policy.per as LambderRateLimitPer | undefined;
            if(!per || (per !== "ip" && per !== "session" && typeof per.handler !== "function")){
                throw new Error(`Lambder: rate-limit policy "${name}" needs per: "ip", "session", or a { apiInput?, handler } key.`);
            }
            if(!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])){
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
        }
        this.limiter = config.limiter;
        this.rateLimitPolicies = { ...config.policies };
    }

    addGuards(guards: Record<string, LambderApiGuard<any>>): void {
        for(const [name, guardDef] of Object.entries(guards)){
            if(this.guards[name]) throw new Error(`Lambder: guard "${name}" is already defined.`);
            if(typeof guardDef?.handler !== "function") throw new Error(`Lambder: guard "${name}" has no handler function.`);
            if(guardDef.apiInput && guardDef.guardInput) throw new Error(`Lambder: guard "${name}" declares both apiInput and guardInput; pick one.`);
            this.guards[name] = guardDef;
        }
    }

    setIdempotency(config: LambderApiIdempotencyConfig): void {
        if(this.idempotencyStore) throw new Error("Lambder: enableApiIdempotency() was already called.");
        this.idempotencyStore = config.store;
        this.idempotencyDefaultTtlSeconds = config.defaultTtlSeconds ?? 24 * 3600;
        this.idempotencyFailOpen = config.failOpen ?? true;
    }

    /** Startup validation of one API registration's declarative options. */
    assertRegistration(
        apiName: string,
        mode: "public" | "session",
        options: { rateLimit?: string | readonly string[], guards?: string | readonly string[], idempotency?: unknown },
    ): void {
        for(const name of toList(options.rateLimit)){
            const policy = this.rateLimitPolicies[name];
            if(!policy){
                throw new Error(`Lambder: API "${apiName}" references unknown rate-limit policy "${name}". Declare it via enableApiRateLimits() before registering the API.`);
            }
            if(policy.per === "session" && mode !== "session"){
                throw new Error(`Lambder: API "${apiName}" uses rate-limit policy "${name}" (per "session"), which requires addSessionApi.`);
            }
        }
        for(const name of toList(options.guards)){
            if(!this.guards[name]){
                throw new Error(`Lambder: API "${apiName}" references unknown guard "${name}". Define it via defineApiGuards() before registering the API.`);
            }
        }
        if(options.idempotency !== undefined && !this.idempotencyStore){
            throw new Error(`Lambder: API "${apiName}" declares idempotency but enableApiIdempotency() was not called first.`);
        }
    }

    /** Rate limits then guards, in declared order. Refusals throw (LambderApiError or a guard's own throw). */
    async runPreflight(
        apiName: string,
        ctx: LambderRenderContext,
        resolver: LambderResolver,
        options: { rateLimit?: string | readonly string[], guards?: string | readonly string[] },
    ): Promise<void> {
        for(const name of toList(options.rateLimit)){
            const policy = this.rateLimitPolicies[name];
            if(!policy || !this.limiter) throw new Error(`Lambder: rate-limit policy "${name}" is not configured.`);
            const key = await this.resolveRateLimitKey(ctx, resolver, policy.per);
            const limited = await this.limiter.isRateLimited(`api|${apiName}|${name}|${key}`, policy);
            if(limited){
                throw new LambderApiError(`Rate limited: "${apiName}" exceeded policy "${name}".`, {
                    errorMessage: policy.errorMessage ?? "Too many requests. Please try again later.",
                    statusCode: 429,
                });
            }
        }
        for(const name of toList(options.guards)){
            const guardDef = this.guards[name];
            if(!guardDef) throw new Error(`Lambder: guard "${name}" is not configured.`);
            const post = ctx.post as Record<string, unknown> | undefined;
            let payload: unknown;
            if(guardDef.apiInput){
                payload = this.parseSlice(guardDef.apiInput, post?.payload, resolver);
            }else if(guardDef.guardInput){
                payload = this.parseSlice(guardDef.guardInput, (post?.guardInputs as Record<string, unknown> | undefined)?.[name], resolver);
            }
            await guardDef.handler(ctx, payload as never, resolver);
        }
    }

    /**
     * Validate a preflight input slice (an apiInput slice of the raw payload,
     * or a guardInput value from the raw guardInputs map). Runs before the
     * API's own validation; failures answer the same 422 shape as regular
     * input validation.
     */
    private parseSlice(input: z.ZodTypeAny, value: unknown, resolver: LambderResolver): unknown {
        const parsed = input.safeParse(value);
        if(!parsed.success){
            throw resolver.json({ error: "Input validation failed", zodError: parsed.error }, { statusCode: 422 });
        }
        return parsed.data;
    }

    private async resolveRateLimitKey(ctx: LambderRenderContext, resolver: LambderResolver, per: LambderRateLimitPer): Promise<string> {
        if(per === "ip") return `ip:${ctx.ip}`;
        if(per === "session"){
            const sessionKey = (ctx.session as { sessionKey?: string } | null)?.sessionKey;
            if(!sessionKey) throw new Error('Lambder: rate-limit per "session" evaluated without a session on the context.');
            return `session:${sessionKey}`;
        }
        const payload = per.apiInput
            ? this.parseSlice(per.apiInput, (ctx.post as Record<string, unknown> | undefined)?.payload, resolver)
            : undefined;
        return `custom:${await per.handler(ctx, payload as never)}`;
    }

    /**
     * Idempotency wrapper around validation-passed handler execution. Without
     * a client idempotencyKey the handler just runs; with one, the scope
     * (identity + api + key) is claimed atomically: duplicates of an
     * in-flight original refuse with 409, replays of a completed one return
     * the stored response verbatim, and a crashed original releases its claim
     * so a retry actually retries.
     */
    async withIdempotency(
        apiName: string,
        ctx: LambderRenderContext,
        config: boolean | { ttlSeconds?: number },
        exec: () => Promise<LambderResponse>,
    ): Promise<LambderResponse> {
        const store = this.idempotencyStore;
        const rawKey = (ctx.post as Record<string, unknown> | undefined)?.idempotencyKey;
        if(!store || rawKey === undefined || rawKey === null) return await exec();
        if(typeof rawKey !== "string" || rawKey.length < 1 || rawKey.length > 200){
            throw new LambderApiError("Invalid idempotency key.", { statusCode: 400 });
        }
        const ttlSeconds = (typeof config === "object" ? config.ttlSeconds : undefined) ?? this.idempotencyDefaultTtlSeconds;
        // Scoped per identity so clients cannot collide with or poison each other's keys.
        const sessionKey = (ctx.session as { sessionKey?: string } | null)?.sessionKey;
        const scopeKey = `${sessionKey ? `s:${sessionKey}` : `ip:${ctx.ip}`}|${apiName}|${rawKey}`;

        let begun: LambderIdempotencyBeginResult;
        try {
            begun = await store.begin(scopeKey, { pendingTtlSeconds: IDEMPOTENCY_PENDING_TTL_SECONDS });
        }catch(err){
            if(this.idempotencyFailOpen) return await exec();
            throw err;
        }
        if(begun.state === "pending"){
            throw new LambderApiError(`Duplicate request for "${apiName}": the original is still processing.`, {
                statusCode: 409,
                errorMessage: "This request is already being processed.",
            });
        }
        if(begun.state === "done"){
            return new LambderResponse({
                statusCode: begun.statusCode as HttpStatusCode,
                headers: begun.contentType ? { "Content-Type": begun.contentType } : {},
                body: begun.body,
            });
        }
        const ownerToken = begun.ownerToken;

        // Store the response for replays when it qualifies, release the claim
        // otherwise. Settle failures only surface when failing closed.
        const settleClaim = async (response: LambderResponse) => {
            const cacheable = response.statusCode < 500
                && typeof response.body === "string"
                && !response.isBodyBase64
                && response.body.length <= IDEMPOTENCY_MAX_STORED_BODY_BYTES;
            try {
                if(cacheable){
                    await store.complete(scopeKey, ownerToken, {
                        statusCode: response.statusCode,
                        contentType: response.getHeader("Content-Type")?.[0] ?? null,
                        body: response.body as string,
                        ttlSeconds,
                    });
                }else{
                    await store.abandon(scopeKey, ownerToken);
                }
            }catch(storeErr){
                if(!this.idempotencyFailOpen) throw storeErr;
            }
        };

        try {
            const response = await exec();
            await settleClaim(response);
            return response;
        }catch(err){
            // A thrown LambderResponse IS the response (res.die.*, throw
            // res.api(...)): settle the claim like a returned one so its side
            // effect replays, then rethrow so the pipeline emits it.
            if(err instanceof LambderResponse){
                await settleClaim(err);
                throw err;
            }
            // A real crash (or a refusal like LambderApiError) releases the
            // claim so a retry actually retries.
            try { await store.abandon(scopeKey, ownerToken); }
            catch(cleanupErr){ if(!this.idempotencyFailOpen) throw cleanupErr; }
            throw err;
        }
    }
}

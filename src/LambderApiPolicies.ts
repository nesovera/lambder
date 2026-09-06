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
 * What one rate-limit counter tracks: the client IP, the session identity, or
 * a custom key derived from the request (e.g. a normalized email). Custom
 * functions run before input validation, so they read the raw payload.
 */
export type LambderRateLimitPer =
    | "ip"
    | "session"
    | ((ctx: LambderRenderContext) => string | Promise<string>);

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
 * A named guard, run before input validation. Refuse by throwing (typically a
 * LambderApiError, or res.die.*); return normally to let the request through.
 * ctx.apiPayload is unvalidated at this point.
 */
export type LambderApiGuardFunction = (ctx: LambderRenderContext, res: LambderResolver) => void | Promise<void>;

/** Names of policies usable on public APIs: everything not keyed per "session". */
export type LambderPublicRateLimitNames<TPolicies> = {
    [K in keyof TPolicies]: TPolicies[K] extends { per: "session" } ? never : K
}[keyof TPolicies] & string;

/** Declarative per-API options carried in the addApi/addSessionApi schema object. */
export type LambderApiRegistrationOptions<
    TRateLimitName extends string,
    TGuardName extends string,
    TIdempotencyEnabled extends boolean,
> = {
    /** Named rate limits, checked in declared order before guards and validation; the first exceeded one refuses (429 envelope). */
    rateLimit?: TRateLimitName | readonly TRateLimitName[];
    /** Named guards, run in declared order before input validation; refuse by throwing. */
    guards?: TGuardName | readonly TGuardName[];
    /** Replay-protect this API per client idempotencyKey. Requires enableApiIdempotency() first. */
    idempotency?: TIdempotencyEnabled extends true ? (boolean | { ttlSeconds?: number }) : never;
};

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
    private guards: Record<string, LambderApiGuardFunction> = {};
    private idempotencyStore: LambderDdbIdempotency | null = null;
    private idempotencyDefaultTtlSeconds = 24 * 3600;
    private idempotencyFailOpen = true;

    setRateLimits(config: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>): void {
        if(this.limiter) throw new Error("Lambder: enableApiRateLimits() was already called.");
        for(const [name, policy] of Object.entries(config.policies)){
            if(!policy.per) throw new Error(`Lambder: rate-limit policy "${name}" is missing its "per" key source.`);
            if(!RATE_LIMIT_WINDOW_KEYS.some((key) => policy[key])){
                throw new Error(`Lambder: rate-limit policy "${name}" declares no window (${RATE_LIMIT_WINDOW_KEYS.join("/")}).`);
            }
        }
        this.limiter = config.limiter;
        this.rateLimitPolicies = { ...config.policies };
    }

    addGuards(guards: Record<string, LambderApiGuardFunction>): void {
        for(const [name, guardFn] of Object.entries(guards)){
            if(this.guards[name]) throw new Error(`Lambder: guard "${name}" is already defined.`);
            this.guards[name] = guardFn;
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
            const key = await this.resolveRateLimitKey(ctx, policy.per);
            const limited = await this.limiter.isRateLimited(`api|${apiName}|${name}|${key}`, policy);
            if(limited){
                throw new LambderApiError(`Rate limited: "${apiName}" exceeded policy "${name}".`, {
                    errorMessage: policy.errorMessage ?? "Too many requests. Please try again later.",
                    statusCode: 429,
                });
            }
        }
        for(const name of toList(options.guards)){
            const guardFn = this.guards[name];
            if(!guardFn) throw new Error(`Lambder: guard "${name}" is not configured.`);
            await guardFn(ctx, resolver);
        }
    }

    private async resolveRateLimitKey(ctx: LambderRenderContext, per: LambderRateLimitPer): Promise<string> {
        if(per === "ip") return `ip:${ctx.ip}`;
        if(per === "session"){
            const sessionKey = (ctx.session as { sessionKey?: string } | null)?.sessionKey;
            if(!sessionKey) throw new Error('Lambder: rate-limit per "session" evaluated without a session on the context.');
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

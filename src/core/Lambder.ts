import type { z } from "zod";

import type { Context, APIGatewayProxyHandler, APIGatewayProxyHandlerV2 } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import {
    LambderResponse,
    finalizeResponse,
    DEFAULT_FINALIZE_OPTIONS,
    type LambderFinalizeOptions,
    type LambderHttpResponse,
} from "./LambderResponse.js";
import { compileRouteMatcher, type CompiledMatcher, type RouteCondition, type ConditionFunction, type LambderRouteMatcher, type PathParamsOf } from "./LambderRouting.js";
import { applyCorsHeaders, type LambderCorsConfig } from "./LambderCors.js";
import LambderSessionManager, { type LambderSessionDataRefreshConfig } from "../session/LambderSessionManager.js";
import LambderSessionController, { type LambderSessionCookieOptions } from "../session/LambderSessionController.js";
import { LambderPublicFilesHandler, type LambderPublicFilesOptions } from "./LambderPublicFiles.js";
import { isLambderApiError, type LambderApiError } from "../shared/LambderApiError.js";
import { LambderApiPolicyEngine } from "../policies/LambderApiPolicies.js";
import type {
    LambderApiGuard,
    LambderGuardMetaMap,
    LambderGuardsOption,
    LambderGuardsOptionValue,
    LambderGuardDataOf,
    LambderGuardInputsOf,
} from "../policies/LambderApiGuards.js";
import type {
    LambderApiRateLimitPolicyConfig,
    LambderApiRateLimitsConfig,
    LambderAllowedPolicyNames,
} from "../policies/LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "../policies/LambderApiIdempotency.js";
import type { MergeContract } from "../shared/LambderApiContract.js";
import { createContext, isV2HttpEvent, type LambderHttpEvent, type LambderRenderContext, type LambderSessionRenderContext } from "./LambderContext.js";

export type { PathParamsOf, RouteCondition, ConditionFunction, LambderRouteMatcher } from "./LambderRouting.js";
export type { LambderCorsConfig } from "./LambderCors.js";

type MaybePromise<T> = T | Promise<T>;
type Path = `/${string}`;

type ActionFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderResponse>;
type SessionActionFunction<SessionData = any> = (
    ctx: LambderSessionRenderContext<any, SessionData>,
    resolver: LambderResolver,
) => MaybePromise<LambderResponse>;

type ActionObject = { match: CompiledMatcher, actionFn: ActionFunction };

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
type HookEventType = "created" | "beforeRender" | "afterRender" | "fallback";
type HookCreatedFunction = (lambderInstance: Lambder<any, any, any, any, any>) => void | Promise<void>;
/** Return the (possibly replaced) ctx to continue, a LambderResponse to short-circuit, or an Error to fail. */
type HookBeforeRenderFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderRenderContext | LambderResponse | Error>;
type HookAfterRenderFunction = (ctx: LambderRenderContext, resolver: LambderResolver, response: LambderResponse) => MaybePromise<LambderResponse | Error>;
type HookFallbackFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => void | Promise<void>;

type GlobalErrorHandlerFunction = (
    err: Error,
    ctx: LambderRenderContext | null,
    response: LambderResponseBuilder,
    logListToApiResponse?: any[],
) => MaybePromise<LambderResponse>;
type FallbackHandlerFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderResponse>;
type ApiInputValidationErrorHandlerFunction = (ctx: LambderRenderContext, resolver: LambderResolver, zodError: z.ZodError) => MaybePromise<LambderResponse>;

export type LambderIndexHtmlOptions = {
    /** Methods that reach the index handler. Default: ["GET", "HEAD"]. */
    methods?: string[];
    /**
     * Skip paths whose last segment contains a dot, treating them as missing
     * assets rather than app routes. Default: false — real files have already
     * been served by servePublicFiles at this point, and plenty of app routes
     * carry dots (JWTs, coordinates, domain names, version numbers). Turn it
     * on to get 404s instead of a 200 shell for missing-asset requests.
     */
    skipFilePaths?: boolean;
    /** 301-redirect trailing-slash paths to the canonical no-slash URL. Default: false. */
    redirectTrailingSlash?: boolean;
    /** Shell served by the default handler. Default: "index.html". */
    indexFile?: string | ((ctx: LambderRenderContext) => string);
    /** Compression override, like servePublicFiles: "auto" (default), true/false, or (ctx) => boolean | "auto". */
    compress?: boolean | "auto" | ((ctx: LambderRenderContext) => boolean | "auto");
};

// ---------------------------------------------------------------------------
// Actions: one handler list entry that can match on the raw Lambda event
// (non-HTTP triggers) or on the HTTP context.
// ---------------------------------------------------------------------------
/**
 * Second argument of an addAction handler. Discriminated on `ctx`: HTTP
 * invocations get the full context and a resolver, non-HTTP invocations get
 * null for both.
 */
export type LambderActionTools =
    | { ctx: LambderRenderContext; res: LambderResolver; lambdaContext: Context }
    | { ctx: null; res: null; lambdaContext: Context };

type ActionFilterFunction = (event: unknown, ctx: LambderRenderContext | null) => boolean;
type UnifiedActionFunction<TEvent = unknown> = (event: TEvent, tools: LambderActionTools) => MaybePromise<unknown>;
type EventActionObject = { match: (event: unknown) => boolean, actionFn: (event: unknown, lambdaContext: Context) => MaybePromise<unknown> };

/** Overloaded handler type returned by getHandler(): HTTP events get a typed response, others dispatch to actions. */
export type LambderHandler = {
    (event: LambderHttpEvent, context: Context): Promise<LambderHttpResponse>;
    (event: unknown, context: Context): Promise<unknown>;
};

// Compile-time guarantees: getHandler() output is a valid official AWS handler.
type AssertAssignable<T extends true> = T;
type _AssertHandlerV1 = AssertAssignable<LambderHandler extends APIGatewayProxyHandler ? true : false>;
type _AssertHandlerV2 = AssertAssignable<LambderHandler extends APIGatewayProxyHandlerV2 ? true : false>;

export type LambderConstructorOptions = {
    publicPath?: string;
    apiPath?: string;
    apiVersion?: string;
    /** Automatic gzip for compressible responses. Default: { minBytes: 860 }. Set false to disable. */
    compression?: false | { minBytes?: number };
    /** Automatic ETag + If-None-Match 304 on GET/HEAD 200 responses. Default: true. */
    etag?: boolean;
    /** Guard threshold for Lambda's ~6MB response cap. Default: 5,500,000. */
    maxResponseBytes?: number;
};

/**
 * Main Lambder class for building type-safe serverless APIs
 *
 * @typeParam TSessionData - Type of session data stored in DynamoDB
 * @typeParam _TContract - @internal Accumulates API contract during chaining (do not pass manually)
 * @typeParam _TRateLimitPolicies - @internal Accumulated by enableApiRateLimits (do not pass manually)
 * @typeParam _TGuards - @internal Guard name to required-payload map, accumulated by defineApiGuards (do not pass manually)
 * @typeParam _TIdempotencyEnabled - @internal Flipped by enableApiIdempotency (do not pass manually)
 *
 * @example
 * ```typescript
 * interface SessionData { userId: string; role: string; }
 *
 * const lambder = new Lambder<SessionData>({ apiPath: '/api' })
 *   .addApi('getUser', { input: z.object({...}), output: z.object({...}) }, handler)
 *   .addApi('createUser', { input: z.object({...}), output: z.object({...}) }, handler);
 * ```
 */
export default class Lambder<
    TSessionData = any,
    _TContract extends Record<string, any> = {},
    _TRateLimitPolicies extends Record<string, LambderApiRateLimitPolicyConfig> = {},
    _TGuards extends Record<string, any> = {},
    _TIdempotencyEnabled extends boolean = false,
> {
    public apiPath: string;
    public apiVersion: null | string;
    public publicPath: string;

    /**
     * Type property for extracting the API contract
     * Use this to export your API types to the frontend
     *
     * @example
     * ```typescript
     * const lambder = new Lambder().addApi(...).addApi(...);
     * export type ApiContractType = typeof lambder.ApiContract;
     * ```
     */
    public readonly ApiContract!: _TContract;

    private actionList: ActionObject[] = [];
    private apiPolicyEngine: LambderApiPolicyEngine | null = null;
    private registeredApiNames = new Set<string>();
    private hookList: {
        "beforeRender": { priority: number, hookFn: HookBeforeRenderFunction }[],
        "afterRender": { priority: number, hookFn: HookAfterRenderFunction }[],
        "fallback": { priority: number, hookFn: HookFallbackFunction }[],
    } = { "beforeRender": [], "afterRender": [], "fallback": [] };
    private createdHooks: HookCreatedFunction[] = [];
    private initPromise: Promise<void> | null = null;

    private globalErrorHandler: GlobalErrorHandlerFunction | null = null;
    private routeFallbackHandler: FallbackHandlerFunction | null = null;
    private apiFallbackHandler: FallbackHandlerFunction | null = null;
    private apiInputValidationErrorHandler: ApiInputValidationErrorHandlerFunction | null = null;
    private sessionExpiredRouteHandler: FallbackHandlerFunction | null = null;
    private publicFilesHandler: LambderPublicFilesHandler | null = null;
    private indexHtmlConfig: { handler: FallbackHandlerFunction | null, options: LambderIndexHtmlOptions } | null = null;
    private eventActionList: EventActionObject[] = [];
    private corsConfig: LambderCorsConfig | null = null;
    private finalizeOptions: LambderFinalizeOptions;

    private lambderSessionManager?: LambderSessionManager;
    private sessionCookieOptions: LambderSessionCookieOptions = {};
    private sessionTokenCookieKey = "LMDRSESSIONTKID";
    private sessionCsrfCookieKey = "LMDRSESSIONCSTK";

    constructor(options: LambderConstructorOptions = {}){
        this.publicPath = options.publicPath || "/incorrect-path-not-found";
        this.apiPath = options.apiPath ?? "/api";
        this.apiVersion = options.apiVersion ?? null;

        this.finalizeOptions = {
            compression: options.compression === false
                ? false
                : { minBytes: options.compression?.minBytes ?? (DEFAULT_FINALIZE_OPTIONS.compression as { minBytes: number }).minBytes },
            etag: options.etag ?? DEFAULT_FINALIZE_OPTIONS.etag,
            maxResponseBytes: options.maxResponseBytes ?? DEFAULT_FINALIZE_OPTIONS.maxResponseBytes,
        };
    }

    enableCors(config: boolean | LambderCorsConfig): this {
        this.corsConfig = config === true ? {} : (config === false ? null : config);
        return this;
    }

    enableDdbSession(
        {
            tableName, tableRegion, sessionSalt,
            enableSlidingExpiration, slidingWriteIntervalSeconds,
            cookie, partitionKey, sortKey, dataRefresh,
        }: {
            tableName: string;
            tableRegion: string;
            sessionSalt: string;
            enableSlidingExpiration?: boolean;
            /** Min seconds between sliding-expiration writes. Default: max(60, 5% of TTL). */
            slidingWriteIntervalSeconds?: number;
            /** Session cookie attributes, e.g. { domain: ".example.com" } for cross-subdomain sessions. `domain` may be a (hostname) => string function for multi-domain deployments. */
            cookie?: LambderSessionCookieOptions;
            partitionKey?: string;
            sortKey?: string;
            /**
             * Opt-in freshness for session.data derived from external state
             * (roles, permissions, feature flags...). Every session read
             * renews data past its ttlSeconds via your refresh callback,
             * persisting in place on the same record: same tokens, same
             * cookies. Return null from refresh to end the session. See
             * LambderSessionDataRefreshConfig for the exact semantics.
             */
            dataRefresh?: LambderSessionDataRefreshConfig<TSessionData>;
        }
    ): this {
        this.lambderSessionManager = new LambderSessionManager({
            tableName, tableRegion,
            partitionKey: partitionKey ?? "pk",
            sortKey: sortKey ?? "sk",
            sessionSalt, enableSlidingExpiration, slidingWriteIntervalSeconds,
            dataRefresh,
        });
        this.sessionCookieOptions = cookie ?? {};
        return this;
    }

    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): this {
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
        return this;
    }

    setRouteFallbackHandler(routeFallbackHandler: FallbackHandlerFunction): this {
        this.routeFallbackHandler = routeFallbackHandler;
        return this;
    }
    setApiFallbackHandler(apiFallbackHandler: FallbackHandlerFunction): this {
        this.apiFallbackHandler = apiFallbackHandler;
        return this;
    }
    setApiInputValidationErrorHandler(apiInputValidationErrorHandler: ApiInputValidationErrorHandlerFunction): this {
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;
        return this;
    }
    setGlobalErrorHandler(globalErrorHandler: GlobalErrorHandlerFunction): this {
        this.globalErrorHandler = globalErrorHandler;
        return this;
    }
    /** Response for session routes when the session is missing/expired (non-API). Default: 401. */
    setSessionExpiredRouteHandler(handler: FallbackHandlerFunction): this {
        this.sessionExpiredRouteHandler = handler;
        return this;
    }

    /**
     * Terminal public-file layer. Runs only when no route matched, so it can
     * never shadow routes registered after it. Serves real files under
     * publicPath (traversal-safe, mime-typed, memory-cached, immutable-cache
     * heuristic for content-hashed assets); when the file does not exist the
     * request falls through to setRouteFallbackHandler, where the app decides
     * what remains (e.g. render an app shell with res.templateFile).
     */
    servePublicFiles(options: LambderPublicFilesOptions = {}): this {
        this.publicFilesHandler = new LambderPublicFilesHandler(this.publicPath, options);
        return this;
    }

    /**
     * Serve the app shell for page requests that nothing else handled. Runs
     * after servePublicFiles in the fallback chain, so real files are already
     * gone; everything left is an app route (option `skipFilePaths` opts back
     * into 404ing dotted paths). Only configured methods reach it, default
     * GET/HEAD. Gated-out requests fall through to setRouteFallbackHandler.
     * Without a handler, publicPath/index.html is served via res.templateFile
     * (markers optional) with no-cache.
     */
    serveIndexHtml(handler?: FallbackHandlerFunction, options: LambderIndexHtmlOptions = {}): this {
        this.indexHtmlConfig = { handler: handler ?? null, options };
        return this;
    }

    /** Apply the serveIndexHtml gates; null means fall through. */
    private async tryServeIndexHtml(ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse | null> {
        if(!this.indexHtmlConfig) return null;
        const { handler, options } = this.indexHtmlConfig;

        const methods = (options.methods ?? ["GET", "HEAD"]).map((m) => m.toUpperCase());
        if(!methods.includes(ctx.method.toUpperCase())) return null;

        if((options.skipFilePaths ?? false) && (ctx.path.split("/").pop() ?? "").includes(".")) return null;

        if(options.redirectTrailingSlash && ctx.path.length > 1 && ctx.path.endsWith("/")){
            const target = ctx.path.replace(/\/+$/, "") || "/";
            return resolver.redirect(target + buildQueryString(ctx), 301);
        }

        const response = handler
            ? await handler(ctx, resolver)
            : await resolver.templateFile(
                typeof options.indexFile === "function" ? options.indexFile(ctx) : (options.indexFile ?? "index.html"),
                {},
                { cacheControl: "no-cache" },
            );
        if(options.compress !== undefined){
            response.compress = typeof options.compress === "function" ? options.compress(ctx) : options.compress;
        }
        return response;
    }

    // ---------------------------------------------------------------------
    // Declarative API policies (rate limits, guards, idempotency)
    // ---------------------------------------------------------------------
    /**
     * Wire declarative per-API rate limiting: your LambderDdbRateLimiter
     * instance plus named policies, each declaring its windows and what one
     * counter tracks (`per`: "ip", "session", or a custom key function).
     * APIs then reference policies by name via the `rateLimit` option; the
     * returned type narrows so only declared names are accepted, and
     * policies keyed per "session" are only referable from addSessionApi.
     * Callable once; call it before the API registrations that use it.
     */
    enableApiRateLimits<const TPolicies extends Record<string, LambderApiRateLimitPolicyConfig>>(
        config: LambderApiRateLimitsConfig<TPolicies>,
    ): Lambder<TSessionData, _TContract, TPolicies, _TGuards, _TIdempotencyEnabled> {
        this.getOrCreatePolicyEngine().setRateLimits(config);
        return this as any;
    }

    /**
     * Wire declarative idempotency: your LambderDdbIdempotency instance plus
     * replay defaults. APIs opt in via `idempotency: true | { ttlSeconds }`;
     * the option is a type error until this is called. Requests carrying a
     * client `idempotencyKey` (sent by LambderCaller) claim an
     * identity+api+key scope atomically: concurrent duplicates refuse with
     * 409, replays of a completed request return the stored response, and a
     * crashed original releases its claim. Callable once.
     */
    enableApiIdempotency(
        config: LambderApiIdempotencyConfig,
    ): Lambder<TSessionData, _TContract, _TRateLimitPolicies, _TGuards, true> {
        this.getOrCreatePolicyEngine().setIdempotency(config);
        return this as any;
    }

    /**
     * Define named guards that APIs reference (typed) via the `guards`
     * option. Each guard is built with lambderGuard(): its input mode
     * (apiInput slice of the API's own payload, a separate client-sent
     * guardInput, or none), an optional `session: true` requirement, an
     * optional parameter APIs pass in their declaration (`guards: { name:
     * param }`), and an optional return value that lands typed on the
     * handler's ctx.guardData[name]. Guards run before input validation, in
     * the order the API declares them; a handler refuses by throwing
     * (typically refuse()). Callable multiple times so domain modules can
     * contribute their own; names must not collide.
     */
    defineApiGuards<TGuards extends Record<string, LambderApiGuard<any, any, any>>>(
        guards: TGuards,
    ): Lambder<TSessionData, _TContract, _TRateLimitPolicies, _TGuards & LambderGuardMetaMap<TGuards>, _TIdempotencyEnabled> {
        this.getOrCreatePolicyEngine().addGuards(guards);
        return this as any;
    }

    private getOrCreatePolicyEngine(): LambderApiPolicyEngine {
        if(!this.apiPolicyEngine) this.apiPolicyEngine = new LambderApiPolicyEngine();
        return this.apiPolicyEngine;
    }

    /** Registration-time checks shared by addApi/addSessionApi. */
    private assertApiRegistration(
        name: string,
        mode: "public" | "session",
        options: { rateLimit?: string | readonly string[], guards?: LambderGuardsOptionValue, idempotency?: unknown },
    ): void {
        if(this.registeredApiNames.has(name)){
            throw new Error(`Lambder: duplicate API name "${name}". Dispatch is first-match, so the second registration would be silently dead code.`);
        }
        this.registeredApiNames.add(name);
        const usesPolicies = options.rateLimit !== undefined || options.guards !== undefined || options.idempotency !== undefined;
        if(!usesPolicies) return;
        if(!this.apiPolicyEngine){
            throw new Error(`Lambder: API "${name}" declares rateLimit/guards/idempotency, but none of enableApiRateLimits()/defineApiGuards()/enableApiIdempotency() was called first.`);
        }
        this.apiPolicyEngine.assertRegistration(name, mode, options);
    }

    // ---------------------------------------------------------------------
    // Routes and APIs
    // ---------------------------------------------------------------------
    addRoute<TPath extends Path>(
        condition: TPath,
        actionFn: (ctx: LambderRenderContext<any, PathParamsOf<TPath>>, resolver: LambderResolver) => MaybePromise<LambderResponse>,
    ): this;
    addRoute(condition: RegExp | ConditionFunction | LambderRouteMatcher, actionFn: ActionFunction): this;
    addRoute(condition: RouteCondition, actionFn: (ctx: any, resolver: LambderResolver) => MaybePromise<LambderResponse>): this {
        this.actionList.push({
            match: compileRouteMatcher(condition),
            actionFn: (ctx, resolver) => actionFn(ctx, resolver),
        });
        return this;
    }

    addSessionRoute<TPath extends Path>(
        condition: TPath,
        actionFn: (ctx: LambderSessionRenderContext<any, TSessionData, PathParamsOf<TPath>>, resolver: LambderResolver) => MaybePromise<LambderResponse>,
    ): this;
    addSessionRoute(condition: RegExp | ConditionFunction | LambderRouteMatcher, actionFn: SessionActionFunction<TSessionData>): this;
    addSessionRoute(condition: RouteCondition, actionFn: (ctx: any, resolver: LambderResolver) => MaybePromise<LambderResponse>): this {
        this.actionList.push({
            match: compileRouteMatcher(condition),
            actionFn: async (ctx, resolver) => {
                await this.requireSession(ctx, resolver);
                return await actionFn(ctx as unknown as LambderSessionRenderContext<any, TSessionData>, resolver);
            },
        });
        return this;
    }

    // Plugin system
    // The policy generics are `any` in the plugin signature on purpose: a
    // module may annotate its parameter as the bare Lambder<SessionData> or
    // as the app's narrowed alias, and both must chain. Registration-time
    // assertions still verify every referenced policy/guard name at runtime.
    public use<_TNewContract extends Record<string, any>>(
        plugin: (
            lambder: Lambder<TSessionData, _TContract, any, any, any>
        ) => Lambder<TSessionData, _TNewContract, any, any, any>
    ): Lambder<TSessionData, _TNewContract extends _TContract ? _TNewContract : (_TContract & _TNewContract), _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled> {
        return plugin(this as any) as any;
    }

    // Typed API with Zod
    public addApi<
        TName extends string,
        TInput extends z.ZodTypeAny,
        TOutput extends z.ZodTypeAny,
        const TRateOpt extends LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, false> | readonly LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, false>[] = never,
        const TGuardsOpt extends LambderGuardsOption<_TGuards, z.infer<TInput>, false> = never,
    >(
        name: TName,
        schema: { input: TInput, output: TOutput } & {
            /** Named rate limits, checked in declared order before guards and validation; the first exceeded one refuses (429 envelope). */
            rateLimit?: TRateOpt;
            /** Named guards, run in declared order before input validation: a name, a list of names, or a { name: param } map for parameterized guards. Their input requirements merge into this API's contract input; their return values land typed on ctx.guardData. */
            guards?: TGuardsOpt;
            /** Replay-protect this API per client idempotencyKey. Requires enableApiIdempotency() first. */
            idempotency?: _TIdempotencyEnabled extends true ? (boolean | { ttlSeconds?: number }) : never;
        },
        handler: (
            ctx: LambderRenderContext<z.infer<TInput>, Record<string, string>, LambderGuardDataOf<_TGuards, TGuardsOpt>>,
            resolver: LambderResolver<z.infer<TOutput>>
        ) => MaybePromise<LambderResponse>
    ): Lambder<TSessionData, MergeContract<_TContract, TName,
        z.infer<TInput>,
        z.infer<TOutput>,
        LambderGuardInputsOf<_TGuards, TGuardsOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled> {
        this.assertApiRegistration(name, "public", schema);
        this.actionList.push({
            match: (ctx) => ctx.apiName === name ? {} : false,
            actionFn: async (ctx, resolver) => {
                // Replay fast path first: a completed idempotent request must
                // answer its stored response without burning rate-limit quota
                // or re-running guards (no handler executes either way).
                if(this.apiPolicyEngine && schema.idempotency){
                    const replay = await this.apiPolicyEngine.findReplay(name, ctx);
                    if(replay) return replay;
                }
                if(this.apiPolicyEngine) await this.apiPolicyEngine.runPreflight(name, ctx, resolver, schema);

                const inputResult = schema.input.safeParse(ctx.apiPayload);
                if (!inputResult.success) {
                    if (this.apiInputValidationErrorHandler) {
                        return await this.apiInputValidationErrorHandler(ctx, resolver, inputResult.error);
                    }
                    return resolver.json({ error: "Input validation failed", zodError: inputResult.error }, { statusCode: 422 });
                }

                ctx.apiPayload = inputResult.data;
                const run = async () => await handler(ctx as never, resolver as LambderResolver<z.infer<TOutput>>);
                if(this.apiPolicyEngine && schema.idempotency) return await this.apiPolicyEngine.withIdempotency(name, ctx, schema.idempotency, run);
                return await run();
            },
        });
        return this as any;
    }

    // Typed Session API with Zod
    public addSessionApi<
        TName extends string,
        TInput extends z.ZodTypeAny,
        TOutput extends z.ZodTypeAny,
        const TRateOpt extends LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, true> | readonly LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, true>[] = never,
        const TGuardsOpt extends LambderGuardsOption<_TGuards, z.infer<TInput>, true> = never,
    >(
        name: TName,
        schema: { input: TInput, output: TOutput } & {
            /** Named rate limits, checked in declared order before guards and validation; the first exceeded one refuses (429 envelope). */
            rateLimit?: TRateOpt;
            /** Named guards, run in declared order before input validation: a name, a list of names, or a { name: param } map for parameterized guards. Their input requirements merge into this API's contract input; their return values land typed on ctx.guardData. */
            guards?: TGuardsOpt;
            /** Replay-protect this API per client idempotencyKey. Requires enableApiIdempotency() first. */
            idempotency?: _TIdempotencyEnabled extends true ? (boolean | { ttlSeconds?: number }) : never;
        },
        handler: (
            ctx: LambderSessionRenderContext<z.infer<TInput>, TSessionData, Record<string, string>, LambderGuardDataOf<_TGuards, TGuardsOpt>>,
            resolver: LambderResolver<z.infer<TOutput>>
        ) => MaybePromise<LambderResponse>
    ): Lambder<TSessionData, MergeContract<_TContract, TName,
        z.infer<TInput>,
        z.infer<TOutput>,
        LambderGuardInputsOf<_TGuards, TGuardsOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled> {
        this.assertApiRegistration(name, "session", schema);
        this.actionList.push({
            match: (ctx) => ctx.apiName === name ? {} : false,
            actionFn: async (ctx, resolver) => {
                await this.requireSession(ctx, resolver);

                // Replay fast path (after the session fetch: the replay scope
                // is keyed per session): see addApi.
                if(this.apiPolicyEngine && schema.idempotency){
                    const replay = await this.apiPolicyEngine.findReplay(name, ctx);
                    if(replay) return replay;
                }
                if(this.apiPolicyEngine) await this.apiPolicyEngine.runPreflight(name, ctx, resolver, schema);

                const inputResult = schema.input.safeParse(ctx.apiPayload);
                if (!inputResult.success) {
                    if (this.apiInputValidationErrorHandler) {
                        return await this.apiInputValidationErrorHandler(ctx, resolver, inputResult.error);
                    }
                    return resolver.json({ error: "Input validation failed", zodError: inputResult.error }, { statusCode: 422 });
                }

                ctx.apiPayload = inputResult.data;
                const run = async () => await handler(ctx as never, resolver as LambderResolver<z.infer<TOutput>>);
                if(this.apiPolicyEngine && schema.idempotency) return await this.apiPolicyEngine.withIdempotency(name, ctx, schema.idempotency, run);
                return await run();
            }
        });
        return this as any;
    }

    /**
     * Fetch the session or short-circuit the request: API calls get the
     * protocol's { sessionExpired: true } response (handled by LambderCaller),
     * routes get the sessionExpiredRouteHandler response (default 401).
     */
    private async requireSession(ctx: LambderRenderContext, resolver: LambderResolver): Promise<void> {
        const session = await this.getSessionController(ctx).fetchSessionIfExists();
        if(!session){
            if(ctx._otherInternal.isApiCall){ throw resolver.api(null, { sessionExpired: true }); }
            if(this.sessionExpiredRouteHandler){ throw await this.sessionExpiredRouteHandler(ctx, resolver); }
            throw resolver.status(401, "Session required.");
        }
    }

    addHook(hookEvent: 'created', hookFn: HookCreatedFunction, priority?: number): this;
    addHook(hookEvent: 'beforeRender', hookFn: HookBeforeRenderFunction, priority?: number): this;
    addHook(hookEvent: 'afterRender', hookFn: HookAfterRenderFunction, priority?: number): this;
    addHook(hookEvent: 'fallback', hookFn: HookFallbackFunction, priority?: number): this;
    addHook(
        hookEvent: HookEventType,
        hookFn: HookCreatedFunction & HookBeforeRenderFunction & HookAfterRenderFunction & HookFallbackFunction,
        priority = 0
    ): this {
        if(hookEvent === "created"){
            // Runs once, lazily, at the first render() call.
            this.createdHooks.push(hookFn);
        }else{
            this.hookList[hookEvent].push({ priority, hookFn });
            this.hookList[hookEvent].sort((a, b) => a.priority - b.priority);
        }
        return this;
    }

    getSessionController(ctx: LambderRenderContext | LambderSessionRenderContext<any, TSessionData>): LambderSessionController<TSessionData>{
        if(!this.lambderSessionManager) throw new Error("Session is not enabled. Use lambder.enableDdbSession(...) to enable.");

        return new LambderSessionController<TSessionData>({
            lambderSessionManager: this.lambderSessionManager,
            sessionTokenCookieKey: this.sessionTokenCookieKey,
            sessionCsrfCookieKey: this.sessionCsrfCookieKey,
            cookieOptions: this.sessionCookieOptions,
            ctx,
        });
    }

    getResponseBuilder(ctx?: LambderRenderContext){
        return new LambderResponseBuilder({
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            ctx,
        });
    };

    private getResolver(ctx: LambderRenderContext){
        return new LambderResolver({
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            ctx,
        });
    };

    /** Map a thrown LambderApiError onto the structured API envelope. */
    private apiErrorResponse(err: LambderApiError, resolver: LambderResolver): LambderResponse {
        return resolver.api(null, {
            ...(err.errorMessage !== undefined ? { errorMessage: err.errorMessage } : {}),
            ...(err.notAuthorized ? { notAuthorized: true } : {}),
            ...(err.sessionExpired ? { sessionExpired: true } : {}),
        }, err.statusCode !== undefined ? { statusCode: err.statusCode } : undefined);
    }

    getHandler(): LambderHandler {
        return ((event: unknown, context: Context) =>
            Lambder.isHttpEvent(event)
                ? this.render(event, context)
                : this.renderEvent(event, context)
        ) as LambderHandler;
    }

    // ---------------------------------------------------------------------
    // Actions (raw-event or context filtering; the only handler for non-HTTP)
    // ---------------------------------------------------------------------
    /** True when the Lambda event is an API Gateway HTTP event (REST API v1 or HTTP API / Function URL v2). */
    static isHttpEvent(event: unknown): event is LambderHttpEvent {
        if(!event || typeof event !== "object") return false;
        if("httpMethod" in event && "path" in event) return true;
        return isV2HttpEvent(event);
    }

    /**
     * Register an action that filters on the raw Lambda event and, for HTTP
     * invocations, the context (ctx is null otherwise).
     *
     * - Non-HTTP invocations (EventBridge/CloudWatch schedules, SQS, ...):
     *   actions are the only handlers. Return values pass through to Lambda
     *   untouched and errors rethrow, so retry/DLQ semantics keep working.
     *   A trailing `.addAction(() => true, handler)` acts as the fallback;
     *   with no match, a descriptive error is thrown.
     * - HTTP invocations: the action joins the same first-match chain as
     *   routes/APIs (registration order) and must return a response built
     *   with tools.res.
     *
     * Use a type-guard filter to get a typed event:
     * `(event): event is ScheduledEvent => ...`
     */
    addAction<TEvent>(
        filter: (event: unknown, ctx: LambderRenderContext | null) => event is TEvent,
        actionFn: (event: TEvent, tools: LambderActionTools) => MaybePromise<unknown>,
    ): this;
    addAction(
        filter: (event: unknown, ctx: LambderRenderContext | null) => boolean,
        actionFn: (event: unknown, tools: LambderActionTools) => MaybePromise<unknown>,
    ): this;
    addAction(
        filter: ActionFilterFunction,
        actionFn: UnifiedActionFunction<any>,
    ): this {
        // HTTP side: joins the route/API chain in registration order.
        this.actionList.push({
            match: (ctx) => filter(ctx.event, ctx) ? {} : false,
            actionFn: async (ctx, resolver) => {
                const result = await actionFn(ctx.event, { ctx, res: resolver, lambdaContext: ctx.lambdaContext });
                if(!(result instanceof LambderResponse)){
                    throw new Error("Lambder: an addAction matched an HTTP request but did not return a response. Build one with tools.res.");
                }
                return result;
            },
        });
        // Non-HTTP side.
        this.eventActionList.push({
            match: (event) => filter(event, null),
            actionFn: (event, lambdaContext) => actionFn(event, { ctx: null, res: null, lambdaContext }),
        });
        return this;
    }

    /** Dispatch a non-HTTP Lambda event to the registered actions. */
    async renderEvent(event: unknown, lambdaContext: Context): Promise<unknown> {
        await this.ensureInitialized();
        for(const action of this.eventActionList){
            if(action.match(event)){
                return await action.actionFn(event, lambdaContext);
            }
        }
        const summary = event && typeof event === "object"
            ? ` (source: ${String((event as Record<string, unknown>).source ?? "?")}, detail-type: ${String((event as Record<string, unknown>)["detail-type"] ?? "?")})`
            : "";
        throw new Error(`Lambder: no action matched non-HTTP event${summary}. Register one with addAction(); a trailing addAction(() => true, ...) acts as a fallback.`);
    }

    // ---------------------------------------------------------------------
    // Render pipeline
    // ---------------------------------------------------------------------
    private ensureInitialized(): Promise<void> {
        if(!this.initPromise){
            this.initPromise = (async () => {
                for(const hookFn of this.createdHooks){ await hookFn(this); }
            })();
        }
        return this.initPromise;
    }

    private applyCors(ctx: LambderRenderContext, response: LambderResponse, isPreflight: boolean): void {
        applyCorsHeaders(this.corsConfig, ctx, response, isPreflight);
    }

    private async handleNoMatchedAction(ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse> {
        for(const hook of this.hookList["fallback"]){ await hook.hookFn(ctx, resolver); }

        const isAPI = ctx._otherInternal.isApiCall || ctx.path === this.apiPath;
        if(isAPI){
            if(this.apiFallbackHandler) return await this.apiFallbackHandler(ctx, resolver);
            return resolver.api(null, { errorMessage: "API not found." });
        }
        if(this.publicFilesHandler){
            const fileResponse = await this.publicFilesHandler.handle(ctx);
            if(fileResponse) return fileResponse;
        }
        const indexResponse = await this.tryServeIndexHtml(ctx, resolver);
        if(indexResponse) return indexResponse;
        if(this.routeFallbackHandler) return await this.routeFallbackHandler(ctx, resolver);
        return resolver.text("Not found.", { statusCode: 404 });
    }

    private async resolveRequest(ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse> {
        if(ctx.method === "OPTIONS" && this.corsConfig){
            const preflight = new LambderResponse({ statusCode: 204, body: null });
            this.applyCors(ctx, preflight, true);
            return preflight;
        }

        // Version check if provided by both the client and the server
        if(this.apiVersion && ctx._otherInternal.requestVersion && ctx._otherInternal.requestVersion !== this.apiVersion){
            return resolver.versionExpired();
        }

        let matched: { action: ActionObject, params: Record<string, string> } | null = null;
        for(const action of this.actionList){
            const params = action.match(ctx);
            if(params !== false){ matched = { action, params }; break; }
        }
        if(!matched) return await this.handleNoMatchedAction(ctx, resolver);

        ctx.pathParams = matched.params;

        let currentCtx = ctx;
        for(const hook of this.hookList["beforeRender"]){
            const hookResult = await hook.hookFn(currentCtx, resolver);
            if(hookResult instanceof Error) throw hookResult;
            if(hookResult instanceof LambderResponse) return hookResult;
            currentCtx = hookResult;
        }

        return await matched.action.actionFn(currentCtx, resolver);
    }

    async render(
        event: LambderHttpEvent,
        lambdaContext: Context
    ): Promise<LambderHttpResponse> {
        let ctx: LambderRenderContext | null = null;

        try {
            await this.ensureInitialized();
            ctx = createContext(event, lambdaContext, this.apiPath);
            const resolver = this.getResolver(ctx);

            let response: LambderResponse;
            try {
                response = await this.resolveRequest(ctx, resolver);
            } catch(err){
                // A thrown LambderResponse IS the response (res.die.*, throw res.html(...)).
                if(err instanceof LambderResponse){ response = err; }
                // A thrown LambderApiError on an API call IS a structured refusal
                // (brand-checked, not instanceof, to survive duplicate installs).
                else if(isLambderApiError(err) && ctx._otherInternal.isApiCall){ response = this.apiErrorResponse(err, resolver); }
                else { throw err; }
            }

            try {
                for(const hook of this.hookList["afterRender"]){
                    const hookResponse = await hook.hookFn(ctx, resolver, response);
                    if(hookResponse instanceof Error) throw hookResponse;
                    response = hookResponse;
                }
            } catch(err){
                if(err instanceof LambderResponse){ response = err; }
                else if(isLambderApiError(err) && ctx._otherInternal.isApiCall){ response = this.apiErrorResponse(err, resolver); }
                else { throw err; }
            }

            // Apply setHeader, addHeader values.
            for(const header of ctx._otherInternal.setHeaderFnAccumulator){
                response.setHeader(header.key, header.value);
            }
            for(const header of ctx._otherInternal.addHeaderFnAccumulator){
                response.addHeader(header.key, header.value);
            }

            this.applyCors(ctx, response, false);

            return await finalizeResponse(ctx, response, this.finalizeOptions, ctx._otherInternal.eventFormat);
        }catch(err){
            const wrappedError = err instanceof Error ? err : new Error("Error: " + String(err));
            // ctx may be null (createContext failed): derive the format from the raw event.
            const eventFormat = ctx?._otherInternal.eventFormat ?? (isV2HttpEvent(event) ? "v2" : "v1");
            try {
                if(this.globalErrorHandler){
                    const responseBuilder = this.getResponseBuilder(ctx ?? undefined);
                    const errorResponse = await this.globalErrorHandler(
                        wrappedError,
                        ctx,
                        responseBuilder,
                        ctx?._otherInternal.logToApiResponseAccumulator
                    );
                    return await finalizeResponse(ctx, errorResponse, this.finalizeOptions, eventFormat);
                }
            } catch(handlerErr){
                if(handlerErr instanceof LambderResponse){
                    try { return await finalizeResponse(ctx, handlerErr, this.finalizeOptions, eventFormat); } catch { /* fall through */ }
                }
            }
            // Last-resort 500. API calls get the JSON envelope so clients can
            // parse a structured failure; everything else keeps plain text.
            if(ctx?._otherInternal.isApiCall){
                const apiBody = JSON.stringify({ apiVersion: this.apiVersion, payload: null, errorMessage: "Internal server error." });
                return eventFormat === "v2"
                    ? { statusCode: 500, headers: { "Content-Type": "application/json; charset=utf-8" }, body: apiBody, isBase64Encoded: false }
                    : { statusCode: 500, multiValueHeaders: { "Content-Type": ["application/json; charset=utf-8"] }, body: apiBody, isBase64Encoded: false };
            }
            return eventFormat === "v2"
                ? { statusCode: 500, headers: {}, body: "Internal Server Error.", isBase64Encoded: false }
                : { statusCode: 500, multiValueHeaders: {}, body: "Internal Server Error.", isBase64Encoded: false };
        }
    }

}

/**
 * The app's configured Lambder instance type, for annotating the parameter
 * of api modules used via lambder.use(...). Name the pieces you wired in
 * index.ts and the guard metadata mapping happens for you:
 *
 * ```typescript
 * export type AppLambder = LambderApp<SessionData, {
 *     policies: typeof apiRateLimitPolicies;   // enableApiRateLimits({ policies })
 *     guards: typeof apiGuards;                // defineApiGuards(apiGuards)
 *     idempotency: true;                       // enableApiIdempotency(...) was called
 * }>;
 * ```
 *
 * Every field is optional; omit what the app does not wire. The declaration
 * is still an assertion about index.ts (registration-time asserts backstop a
 * mismatch at cold start), but derive the fields from the same exported
 * consts the enable calls receive and the types cannot drift.
 */
export type LambderApp<
    TSessionData,
    TConfig extends {
        policies?: Record<string, LambderApiRateLimitPolicyConfig>;
        guards?: Record<string, LambderApiGuard<any, any, any>>;
        idempotency?: boolean;
    } = {},
> = Lambder<
    TSessionData,
    {},
    TConfig["policies"] extends Record<string, LambderApiRateLimitPolicyConfig> ? TConfig["policies"] : {},
    TConfig["guards"] extends Record<string, LambderApiGuard<any, any, any>> ? LambderGuardMetaMap<TConfig["guards"]> : {},
    TConfig["idempotency"] extends true ? true : false
>;

/** Rebuild the query string from the API Gateway event for redirects. */
const buildQueryString = (ctx: LambderRenderContext): string => {
    if(isV2HttpEvent(ctx.event)){
        return ctx.event.rawQueryString ? `?${ctx.event.rawQueryString}` : "";
    }
    const multi = ctx.event.multiValueQueryStringParameters;
    const single = ctx.event.queryStringParameters;
    const params = new URLSearchParams();
    if(multi){
        for(const [key, values] of Object.entries(multi)){
            for(const value of values ?? []) params.append(key, value);
        }
    }else if(single){
        for(const [key, value] of Object.entries(single)){
            if(value !== undefined) params.append(key, value);
        }
    }
    const queryString = params.toString();
    return queryString ? `?${queryString}` : "";
};

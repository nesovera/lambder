import type { z } from "zod";
import type { Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import { LambderResponse, type LambderHttpResponse } from "./LambderResponse.js";
import { type ConditionFunction, type LambderRouteMatcher, type PathParamsOf } from "./LambderRouting.js";
import { type LambderCorsConfig } from "./LambderCors.js";
import { type LambderSessionDataRefreshConfig } from "./LambderSessionManager.js";
import LambderSessionController, { type LambderSessionCookieOptions } from "./LambderSessionController.js";
import { type LambderPublicFilesOptions } from "./LambderPublicFiles.js";
import { type LambderApiRateLimitPolicyConfig, type LambderApiRateLimitsConfig, type LambderApiIdempotencyConfig, type LambderApiGuard, type LambderGuardMetaMap, type LambderAllowedGuardNames, type LambderAllowedPolicyNames, type LambderGuardInputsOf } from "./LambderApiPolicies.js";
import type { MergeContract } from "./LambderApiContract.js";
import { type LambderHttpEvent, type LambderRenderContext, type LambderSessionRenderContext } from "./LambderContext.js";
export type { PathParamsOf, RouteCondition, ConditionFunction, LambderRouteMatcher } from "./LambderRouting.js";
export type { LambderCorsConfig } from "./LambderCors.js";
type MaybePromise<T> = T | Promise<T>;
type Path = `/${string}`;
type ActionFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderResponse>;
type SessionActionFunction<SessionData = any> = (ctx: LambderSessionRenderContext<any, SessionData>, resolver: LambderResolver) => MaybePromise<LambderResponse>;
type HookCreatedFunction = (lambderInstance: Lambder<any, any, any, any, any>) => void | Promise<void>;
/** Return the (possibly replaced) ctx to continue, a LambderResponse to short-circuit, or an Error to fail. */
type HookBeforeRenderFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderRenderContext | LambderResponse | Error>;
type HookAfterRenderFunction = (ctx: LambderRenderContext, resolver: LambderResolver, response: LambderResponse) => MaybePromise<LambderResponse | Error>;
type HookFallbackFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => void | Promise<void>;
type GlobalErrorHandlerFunction = (err: Error, ctx: LambderRenderContext | null, response: LambderResponseBuilder, logListToApiResponse?: any[]) => MaybePromise<LambderResponse>;
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
/**
 * Second argument of an addAction handler. Discriminated on `ctx`: HTTP
 * invocations get the full context and a resolver, non-HTTP invocations get
 * null for both.
 */
export type LambderActionTools = {
    ctx: LambderRenderContext;
    res: LambderResolver;
    lambdaContext: Context;
} | {
    ctx: null;
    res: null;
    lambdaContext: Context;
};
/** Overloaded handler type returned by getHandler(): HTTP events get a typed response, others dispatch to actions. */
export type LambderHandler = {
    (event: LambderHttpEvent, context: Context): Promise<LambderHttpResponse>;
    (event: unknown, context: Context): Promise<unknown>;
};
export type LambderConstructorOptions = {
    publicPath?: string;
    apiPath?: string;
    apiVersion?: string;
    /** Automatic gzip for compressible responses. Default: { minBytes: 860 }. Set false to disable. */
    compression?: false | {
        minBytes?: number;
    };
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
export default class Lambder<TSessionData = any, _TContract extends Record<string, any> = {}, _TRateLimitPolicies extends Record<string, LambderApiRateLimitPolicyConfig> = {}, _TGuards extends Record<string, any> = {}, _TIdempotencyEnabled extends boolean = false> {
    apiPath: string;
    apiVersion: null | string;
    publicPath: string;
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
    readonly ApiContract: _TContract;
    private actionList;
    private apiPolicyEngine;
    private registeredApiNames;
    private hookList;
    private createdHooks;
    private initPromise;
    private globalErrorHandler;
    private routeFallbackHandler;
    private apiFallbackHandler;
    private apiInputValidationErrorHandler;
    private sessionExpiredRouteHandler;
    private publicFilesHandler;
    private indexHtmlConfig;
    private eventActionList;
    private corsConfig;
    private finalizeOptions;
    private lambderSessionManager?;
    private sessionCookieOptions;
    private sessionTokenCookieKey;
    private sessionCsrfCookieKey;
    constructor(options?: LambderConstructorOptions);
    enableCors(config: boolean | LambderCorsConfig): this;
    enableDdbSession({ tableName, tableRegion, sessionSalt, enableSlidingExpiration, slidingWriteIntervalSeconds, cookie, partitionKey, sortKey, dataRefresh, }: {
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
    }): this;
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): this;
    setRouteFallbackHandler(routeFallbackHandler: FallbackHandlerFunction): this;
    setApiFallbackHandler(apiFallbackHandler: FallbackHandlerFunction): this;
    setApiInputValidationErrorHandler(apiInputValidationErrorHandler: ApiInputValidationErrorHandlerFunction): this;
    setGlobalErrorHandler(globalErrorHandler: GlobalErrorHandlerFunction): this;
    /** Response for session routes when the session is missing/expired (non-API). Default: 401. */
    setSessionExpiredRouteHandler(handler: FallbackHandlerFunction): this;
    /**
     * Terminal public-file layer. Runs only when no route matched, so it can
     * never shadow routes registered after it. Serves real files under
     * publicPath (traversal-safe, mime-typed, memory-cached, immutable-cache
     * heuristic for content-hashed assets); when the file does not exist the
     * request falls through to setRouteFallbackHandler, where the app decides
     * what remains (e.g. render an app shell with res.templateFile).
     */
    servePublicFiles(options?: LambderPublicFilesOptions): this;
    /**
     * Serve the app shell for page requests that nothing else handled. Runs
     * after servePublicFiles in the fallback chain, so real files are already
     * gone; everything left is an app route (option `skipFilePaths` opts back
     * into 404ing dotted paths). Only configured methods reach it, default
     * GET/HEAD. Gated-out requests fall through to setRouteFallbackHandler.
     * Without a handler, publicPath/index.html is served via res.templateFile
     * (markers optional) with no-cache.
     */
    serveIndexHtml(handler?: FallbackHandlerFunction, options?: LambderIndexHtmlOptions): this;
    /** Apply the serveIndexHtml gates; null means fall through. */
    private tryServeIndexHtml;
    /**
     * Wire declarative per-API rate limiting: your LambderDdbRateLimiter
     * instance plus named policies, each declaring its windows and what one
     * counter tracks (`per`: "ip", "session", or a custom key function).
     * APIs then reference policies by name via the `rateLimit` option; the
     * returned type narrows so only declared names are accepted, and
     * policies keyed per "session" are only referable from addSessionApi.
     * Callable once; call it before the API registrations that use it.
     */
    enableApiRateLimits<const TPolicies extends Record<string, LambderApiRateLimitPolicyConfig>>(config: LambderApiRateLimitsConfig<TPolicies>): Lambder<TSessionData, _TContract, TPolicies, _TGuards, _TIdempotencyEnabled>;
    /**
     * Wire declarative idempotency: your LambderDdbIdempotency instance plus
     * replay defaults. APIs opt in via `idempotency: true | { ttlSeconds }`;
     * the option is a type error until this is called. Requests carrying a
     * client `idempotencyKey` (sent by LambderCaller) claim an
     * identity+api+key scope atomically: concurrent duplicates refuse with
     * 409, replays of a completed request return the stored response, and a
     * crashed original releases its claim. Callable once.
     */
    enableApiIdempotency(config: LambderApiIdempotencyConfig): Lambder<TSessionData, _TContract, _TRateLimitPolicies, _TGuards, true>;
    /**
     * Define named guards that APIs reference (typed) via the `guards`
     * option. Each guard is built with lambderGuard() in one of two modes:
     * apiInput (checks a slice of the API's own payload; declarable only on
     * APIs whose input schema carries those fields, so the payload type
     * passes both the API input and the guard's apiInput) or guardInput (the
     * client sends the guard's value separately via options.guardInputs, and
     * the contract forces it at the call site). Guards run before input
     * validation, in the order the API declares them; a handler refuses by
     * throwing (typically refuse()). Callable multiple times so domain
     * modules can contribute their own; names must not collide.
     */
    defineApiGuards<TGuards extends Record<string, LambderApiGuard<any>>>(guards: TGuards): Lambder<TSessionData, _TContract, _TRateLimitPolicies, _TGuards & LambderGuardMetaMap<TGuards>, _TIdempotencyEnabled>;
    private getOrCreatePolicyEngine;
    /** Registration-time checks shared by addApi/addSessionApi. */
    private assertApiRegistration;
    addRoute<TPath extends Path>(condition: TPath, actionFn: (ctx: LambderRenderContext<any, PathParamsOf<TPath>>, resolver: LambderResolver) => MaybePromise<LambderResponse>): this;
    addRoute(condition: RegExp | ConditionFunction | LambderRouteMatcher, actionFn: ActionFunction): this;
    addSessionRoute<TPath extends Path>(condition: TPath, actionFn: (ctx: LambderSessionRenderContext<any, TSessionData, PathParamsOf<TPath>>, resolver: LambderResolver) => MaybePromise<LambderResponse>): this;
    addSessionRoute(condition: RegExp | ConditionFunction | LambderRouteMatcher, actionFn: SessionActionFunction<TSessionData>): this;
    use<_TNewContract extends Record<string, any>>(plugin: (lambder: Lambder<TSessionData, _TContract, any, any, any>) => Lambder<TSessionData, _TNewContract, any, any, any>): Lambder<TSessionData, _TNewContract extends _TContract ? _TNewContract : (_TContract & _TNewContract), _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled>;
    addApi<TName extends string, TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny, const TRateOpt extends LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, false> | readonly LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, false>[] = never, const TGuardsOpt extends LambderAllowedGuardNames<_TGuards, z.infer<TInput>> | readonly LambderAllowedGuardNames<_TGuards, z.infer<TInput>>[] = never>(name: TName, schema: {
        input: TInput;
        output: TOutput;
    } & {
        /** Named rate limits, checked in declared order before guards and validation; the first exceeded one refuses (429 envelope). */
        rateLimit?: TRateOpt;
        /** Named guards, run in declared order before input validation; their input requirements merge into this API's contract input. */
        guards?: TGuardsOpt;
        /** Replay-protect this API per client idempotencyKey. Requires enableApiIdempotency() first. */
        idempotency?: _TIdempotencyEnabled extends true ? (boolean | {
            ttlSeconds?: number;
        }) : never;
    }, handler: (ctx: LambderRenderContext<z.infer<TInput>>, resolver: LambderResolver<z.infer<TOutput>>) => MaybePromise<LambderResponse>): Lambder<TSessionData, MergeContract<_TContract, TName, z.infer<TInput>, z.infer<TOutput>, LambderGuardInputsOf<_TGuards, TGuardsOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled>;
    addSessionApi<TName extends string, TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny, const TRateOpt extends LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, true> | readonly LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, true>[] = never, const TGuardsOpt extends LambderAllowedGuardNames<_TGuards, z.infer<TInput>> | readonly LambderAllowedGuardNames<_TGuards, z.infer<TInput>>[] = never>(name: TName, schema: {
        input: TInput;
        output: TOutput;
    } & {
        /** Named rate limits, checked in declared order before guards and validation; the first exceeded one refuses (429 envelope). */
        rateLimit?: TRateOpt;
        /** Named guards, run in declared order before input validation; their input requirements merge into this API's contract input. */
        guards?: TGuardsOpt;
        /** Replay-protect this API per client idempotencyKey. Requires enableApiIdempotency() first. */
        idempotency?: _TIdempotencyEnabled extends true ? (boolean | {
            ttlSeconds?: number;
        }) : never;
    }, handler: (ctx: LambderSessionRenderContext<z.infer<TInput>, TSessionData>, resolver: LambderResolver<z.infer<TOutput>>) => MaybePromise<LambderResponse>): Lambder<TSessionData, MergeContract<_TContract, TName, z.infer<TInput>, z.infer<TOutput>, LambderGuardInputsOf<_TGuards, TGuardsOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled>;
    /**
     * Fetch the session or short-circuit the request: API calls get the
     * protocol's { sessionExpired: true } response (handled by LambderCaller),
     * routes get the sessionExpiredRouteHandler response (default 401).
     */
    private requireSession;
    addHook(hookEvent: 'created', hookFn: HookCreatedFunction, priority?: number): this;
    addHook(hookEvent: 'beforeRender', hookFn: HookBeforeRenderFunction, priority?: number): this;
    addHook(hookEvent: 'afterRender', hookFn: HookAfterRenderFunction, priority?: number): this;
    addHook(hookEvent: 'fallback', hookFn: HookFallbackFunction, priority?: number): this;
    getSessionController(ctx: LambderRenderContext | LambderSessionRenderContext<any, TSessionData>): LambderSessionController<TSessionData>;
    getResponseBuilder(ctx?: LambderRenderContext): LambderResponseBuilder<any>;
    private getResolver;
    /** Map a thrown LambderApiError onto the structured API envelope. */
    private apiErrorResponse;
    getHandler(): LambderHandler;
    /** True when the Lambda event is an API Gateway HTTP event (REST API v1 or HTTP API / Function URL v2). */
    static isHttpEvent(event: unknown): event is LambderHttpEvent;
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
    addAction<TEvent>(filter: (event: unknown, ctx: LambderRenderContext | null) => event is TEvent, actionFn: (event: TEvent, tools: LambderActionTools) => MaybePromise<unknown>): this;
    addAction(filter: (event: unknown, ctx: LambderRenderContext | null) => boolean, actionFn: (event: unknown, tools: LambderActionTools) => MaybePromise<unknown>): this;
    /** Dispatch a non-HTTP Lambda event to the registered actions. */
    renderEvent(event: unknown, lambdaContext: Context): Promise<unknown>;
    private ensureInitialized;
    private applyCors;
    private handleNoMatchedAction;
    private resolveRequest;
    render(event: LambderHttpEvent, lambdaContext: Context): Promise<LambderHttpResponse>;
}

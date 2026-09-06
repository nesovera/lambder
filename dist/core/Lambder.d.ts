import type { z } from "zod";
import type { Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import { LambderResponse, type LambderHttpResponse } from "./LambderResponse.js";
import { type ConditionFunction, type LambderRouteMatcher, type PathParamsOf } from "./LambderRouting.js";
import { type LambderCorsConfig } from "./LambderCors.js";
import { type LambderSessionDataRefreshConfig } from "../session/LambderSessionManager.js";
import LambderSessionController, { type LambderSessionCookieOptions } from "../session/LambderSessionController.js";
import { type LambderPublicFilesOptions } from "./LambderPublicFiles.js";
import type { LambderApiGuard, LambderGuardMetaMap, LambderGuardsOption, LambderGuardDataOf, LambderGuardInputsOf } from "../policies/LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig, LambderApiRateLimitsConfig, LambderAllowedPolicyNames } from "../policies/LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "../policies/LambderApiIdempotency.js";
import type { MergeContract } from "../shared/LambderApiContract.js";
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
/** DynamoDB session configuration (the `session` option of create/new). */
export type LambderSessionOptions<TSessionData = any> = {
    tableName: string;
    tableRegion: string;
    sessionSalt: string;
    enableSlidingExpiration?: boolean;
    /** Min seconds between sliding-expiration writes. Default: max(60, 5% of TTL). */
    slidingWriteIntervalSeconds?: number;
    /** Session cookie attributes, e.g. { domain: ".example.com" } for cross-subdomain sessions. `domain` may be a (hostname) => string function for multi-domain deployments. */
    cookie?: LambderSessionCookieOptions;
    /** Session cookie names. Defaults: LMDRSESSIONTKID / LMDRSESSIONCSTK. */
    tokenCookieKey?: string;
    csrfCookieKey?: string;
    partitionKey?: string;
    sortKey?: string;
    /**
     * Opt-in freshness for session.data derived from external state (roles,
     * permissions, feature flags...). Every session read renews data past
     * its ttlSeconds via your refresh callback, persisting in place on the
     * same record: same tokens, same cookies. Return null from refresh to
     * end the session. See LambderSessionDataRefreshConfig for the exact
     * semantics.
     */
    dataRefresh?: LambderSessionDataRefreshConfig<TSessionData>;
};
/**
 * Everything an instance is configured with, in ONE declaration: base
 * serving options plus the type-affecting policy layer (rate limits,
 * guards, idempotency) and session/CORS config. There are no enable/define
 * chain methods; the instance is born fully configured and fully typed
 * (via initLambder), so no ordering rules exist and no partially-configured
 * instance type ever needs a name.
 */
export type LambderCreateOptions<TSessionData = any> = {
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
    /** CORS: true allows any origin; or pass a LambderCorsConfig. Default: off. */
    cors?: boolean | LambderCorsConfig;
    /** DynamoDB-backed sessions; required for addSessionApi/addSessionRoute. */
    session?: LambderSessionOptions<TSessionData>;
    /** Declarative per-API rate limiting: your limiter plus named policies APIs reference (typed) via the `rateLimit` option. */
    rateLimits?: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig>>;
    /** Named guards APIs reference (typed) via the `guards` option; build each with lambderGuard(). */
    guards?: Record<string, LambderApiGuard<any, any, any>>;
    /** Declarative idempotency: your store plus replay defaults; APIs opt in via `idempotency: true | { ttlSeconds }`. */
    idempotency?: LambderApiIdempotencyConfig;
};
/**
 * Main Lambder class for building type-safe serverless APIs. Create
 * instances with initLambder<SessionData>().create({...}) (see below): the
 * whole configuration, including the typed policy layer, is given at
 * construction, and only registration (routes, apis, hooks, use) chains.
 *
 * @typeParam TSessionData - Type of session data stored in DynamoDB
 * @typeParam _TContract - @internal Accumulates API contract during chaining (do not pass manually)
 * @typeParam _TRateLimitPolicies - @internal Inferred from create()'s rateLimits.policies (do not pass manually)
 * @typeParam _TGuards - @internal Guard metadata map inferred from create()'s guards (do not pass manually)
 * @typeParam _TIdempotencyEnabled - @internal True when create() received idempotency (do not pass manually)
 *
 * @example
 * ```typescript
 * interface SessionData { userId: string; role: string; }
 *
 * const lambder = initLambder<SessionData>().create({ apiPath: '/api' })
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
    constructor(options?: LambderCreateOptions<TSessionData>);
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
    private getOrCreatePolicyEngine;
    /** Registration-time checks shared by addApi/addSessionApi. */
    private assertApiRegistration;
    addRoute<TPath extends Path>(condition: TPath, actionFn: (ctx: LambderRenderContext<any, PathParamsOf<TPath>>, resolver: LambderResolver) => MaybePromise<LambderResponse>): this;
    addRoute(condition: RegExp | ConditionFunction | LambderRouteMatcher, actionFn: ActionFunction): this;
    addSessionRoute<TPath extends Path>(condition: TPath, actionFn: (ctx: LambderSessionRenderContext<any, TSessionData, PathParamsOf<TPath>>, resolver: LambderResolver) => MaybePromise<LambderResponse>): this;
    addSessionRoute(condition: RegExp | ConditionFunction | LambderRouteMatcher, actionFn: SessionActionFunction<TSessionData>): this;
    use<_TNewContract extends Record<string, any>>(plugin: (lambder: Lambder<TSessionData, _TContract, any, any, any>) => Lambder<TSessionData, _TNewContract, any, any, any>): Lambder<TSessionData, _TNewContract extends _TContract ? _TNewContract : (_TContract & _TNewContract), _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled>;
    addApi<TName extends string, TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny, const TRateOpt extends LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, false> | readonly LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, false>[] = never, const TGuardsOpt extends LambderGuardsOption<_TGuards, z.infer<TInput>, false> = never>(name: TName, schema: {
        input: TInput;
        output: TOutput;
    } & {
        /** Named rate limits, checked in declared order before guards and validation; the first exceeded one refuses (429 envelope). */
        rateLimit?: TRateOpt;
        /** Named guards, run in declared order before input validation: a name, a list of names, or a { name: param } map for parameterized guards. Their input requirements merge into this API's contract input; their return values land typed on ctx.guardData. */
        guards?: TGuardsOpt;
        /** Replay-protect this API per client idempotencyKey. Requires the idempotency option at creation. */
        idempotency?: _TIdempotencyEnabled extends true ? (boolean | {
            ttlSeconds?: number;
        }) : never;
    }, handler: (ctx: LambderRenderContext<z.infer<TInput>, Record<string, string>, LambderGuardDataOf<_TGuards, TGuardsOpt>>, resolver: LambderResolver<z.infer<TOutput>>) => MaybePromise<LambderResponse>): Lambder<TSessionData, MergeContract<_TContract, TName, z.infer<TInput>, z.infer<TOutput>, LambderGuardInputsOf<_TGuards, TGuardsOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled>;
    addSessionApi<TName extends string, TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny, const TRateOpt extends LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, true> | readonly LambderAllowedPolicyNames<_TRateLimitPolicies, z.infer<TInput>, true>[] = never, const TGuardsOpt extends LambderGuardsOption<_TGuards, z.infer<TInput>, true> = never>(name: TName, schema: {
        input: TInput;
        output: TOutput;
    } & {
        /** Named rate limits, checked in declared order before guards and validation; the first exceeded one refuses (429 envelope). */
        rateLimit?: TRateOpt;
        /** Named guards, run in declared order before input validation: a name, a list of names, or a { name: param } map for parameterized guards. Their input requirements merge into this API's contract input; their return values land typed on ctx.guardData. */
        guards?: TGuardsOpt;
        /** Replay-protect this API per client idempotencyKey. Requires the idempotency option at creation. */
        idempotency?: _TIdempotencyEnabled extends true ? (boolean | {
            ttlSeconds?: number;
        }) : never;
    }, handler: (ctx: LambderSessionRenderContext<z.infer<TInput>, TSessionData, Record<string, string>, LambderGuardDataOf<_TGuards, TGuardsOpt>>, resolver: LambderResolver<z.infer<TOutput>>) => MaybePromise<LambderResponse>): Lambder<TSessionData, MergeContract<_TContract, TName, z.infer<TInput>, z.infer<TOutput>, LambderGuardInputsOf<_TGuards, TGuardsOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled>;
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
/**
 * The canonical way to create an instance: fix the session data type first,
 * then create with the full configuration in one declaration; the policy,
 * guard, and idempotency types are INFERRED from the options, so the
 * instance is born fully typed and `typeof lambderApp` is the annotation
 * type for api modules. No enable/define chain exists, so there are no
 * ordering rules and nothing can be half-configured.
 *
 * ```typescript
 * // app.ts (imports no api modules, so modules can import the type back)
 * export const lambderApp = initLambder<SessionData>().create({
 *     apiPath: "/api",
 *     session: { tableName: "app-session", tableRegion: "us-east-1", sessionSalt: "..." },
 *     rateLimits: { limiter, policies },
 *     guards,
 *     idempotency: { store },
 * });
 * export type AppLambder = typeof lambderApp;
 *
 * // orders.ts
 * export const orderApi = (lambder: AppLambder) => lambder.addSessionApi(...);
 *
 * // index.ts: registration only
 * const lambder = lambderApp.addHook(...).use(orderApi)...;
 * export const handler = lambder.getHandler();
 * ```
 *
 * Why curried (`initLambder<S>().create(...)` rather than
 * `new Lambder<S>(...)`): TypeScript type arguments are all-or-nothing per
 * call, so explicitly passing the session data type to the constructor
 * would silently WIDEN the inferred policy and guard types to their {}
 * defaults. Fixing the session type in the first call lets the second call
 * infer everything else from the options. `new Lambder(options)` remains
 * for untyped or session-data-free instances.
 */
export declare const initLambder: <TSessionData = any>() => {
    create<const TOptions extends LambderCreateOptions<TSessionData>>(options: TOptions): Lambder<TSessionData, {}, TOptions["rateLimits"] extends {
        policies: infer TPolicies extends Record<string, LambderApiRateLimitPolicyConfig>;
    } ? TPolicies : {}, TOptions["guards"] extends Record<string, LambderApiGuard<any, any, any>> ? LambderGuardMetaMap<TOptions["guards"]> : {}, TOptions["idempotency"] extends LambderApiIdempotencyConfig ? true : false>;
};

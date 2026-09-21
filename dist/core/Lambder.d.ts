import type { z } from "zod";
import type { Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import { LambderResponse, type LambderHttpResponse } from "./LambderResponse.js";
import { type LambderRouteConditionFn, type LambderRouteMatcher, type LambderPathParamsOf, type LambderRoutePath } from "./LambderRouting.js";
import LambderSessionManager from "../session/LambderSessionManager.js";
import type LambderSessionController from "../session/LambderSessionController.js";
import { type LambderPublicFilesOptions } from "./LambderPublicFiles.js";
import { type LambderIndexHtmlOptions } from "./LambderIndexHtml.js";
import { LambderFiles } from "./LambderFiles.js";
import { type LambderPipelineBackends, type LambderPipelineBackendSwap } from "../api/LambderApiPipeline.js";
import type { LambderFileSource } from "../shared/contracts/LambderFileSource.js";
import { LAMBDER_BACKEND_SWAP, LAMBDER_CRASH_WATCH } from "../shared/util/LambderTestingDoors.js";
import { type LambderApiSignatureEntry } from "../api/LambderApiSignature.js";
import { type LambderApiSignatureMap } from "../shared/wire/LambderApiSignature.js";
import type { LambderApiIdempotencyOption } from "../shared/wire/LambderApiOptionValues.js";
import type { LambderApiGuard, LambderGuardMetaMap, LambderGuardsOption, LambderGuardDataOf, LambderGuardInputsOf } from "../api/LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig, LambderRateLimitOption } from "../api/LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "../api/LambderApiIdempotency.js";
import type { LambderContractEntry, LambderMergeContract } from "../shared/wire/LambderApiContract.js";
import { type LambderHttpEvent, type LambderRenderContext, type LambderSessionRenderContext } from "./LambderContext.js";
import type { MaybePromise } from "../shared/util/LambderTypeUtilities.js";
import { type LambderRouteHandler, type LambderInputValidationHandler, type LambderFallbackHandler, type LambderGlobalErrorHandler, type LambderAfterRenderHook, type LambderBeforeRenderHook, type LambderFallbackHook, type LambderActionTools, type LambderCreateOptions, type LambderGivenOption, type LambderHandler, type LambderNestedOptionChecks, type LambderNoExtraKeys, type LambderRequirableGuardsField, type LambderSessionEnabledInstance, type LambderSessionRouteHandler } from "./LambderCreateOptions.js";
/**
 * The "created" hook: run once the instance exists, with the instance. It is
 * declared here rather than beside the other hooks in LambderCreateOptions
 * because its parameter is the class, and an options module that names the
 * class cannot be read without it.
 */
/** Everything `lambder/testing` may put under a built instance: the pipeline's stores, and the source its files are read from. */
export type LambderInstanceBackends = LambderPipelineBackends & {
    fileSource?: LambderFileSource;
};
/** What the instance had a place for; see LambderPipelineBackendSwap. `files` is false on an instance created without the files option. */
export type LambderInstanceBackendSwap = LambderPipelineBackendSwap & {
    files: boolean;
};
export type LambderCreatedHook = (lambderInstance: Lambder<any, any, any, any, any, any, any, any>) => void | Promise<void>;
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
 * @typeParam _TSessionGuardsRequired - @internal True when create() received requireSessionApiGuards (do not pass manually)
 * @typeParam _TPublicGuardsRequired - @internal True when create() received requirePublicApiGuards (do not pass manually)
 * @typeParam _TSessionsEnabled - @internal True when create() received the session option (do not pass manually). It defaults to TRUE, unlike its siblings: a plugin module annotates its parameter as the bare Lambder<SessionData>, and that annotation has to keep registering session APIs. create() is where the option is actually known, so create() is where the false comes from; `new Lambder(...)` keeps only the registration-time throw.
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
export default class Lambder<TSessionData = any, _TContract extends Record<string, any> = {}, _TRateLimitPolicies extends Record<string, LambderApiRateLimitPolicyConfig> = {}, _TGuards extends Record<string, any> = {}, _TIdempotencyEnabled extends boolean = false, _TSessionGuardsRequired extends boolean = false, _TPublicGuardsRequired extends boolean = false, _TSessionsEnabled extends boolean = true> {
    apiPath: string;
    /** Stamped on every API answer's envelope as apiVersion. Informational: a client's staleness is judged per endpoint by its signature, see apiSignatures(). */
    apiVersion: null | string;
    /** The instance's file reader (source + caches), or null without the files option. */
    files: LambderFiles | null;
    /**
     * Type property for extracting the API contract
     * Use this to export your API types to the frontend
     *
     * Export it as an interface extending LambderFlattenContract, not as a
     * type alias. Chaining builds the contract as an intersection one member
     * deep per endpoint, and an interface collapses that into one declared
     * set of members, which every generic read of the contract (a mock
     * registry, a needs map, the typed caller) is then far cheaper against.
     * See LambderFlattenContract for the measurements.
     *
     * @example
     * ```typescript
     * const lambder = new Lambder().addApi(...).addApi(...);
     * export interface ApiContractType extends LambderFlattenContract<typeof lambder.ApiContract> {}
     * ```
     */
    readonly ApiContract: _TContract;
    private actionList;
    /** The API core: the pipeline every API call runs through, shared in shape with the mock runtime. */
    private readonly pipeline;
    /** Every registered API by name: the duplicate-name check, and what apiSignatures() digests. */
    private readonly apiDefinitions;
    /** The guards map given at creation, kept for apiSignatures(): a guard's schema is part of the signature of every endpoint declaring it. */
    private readonly guards;
    private hookList;
    private createdHooks;
    private initPromise;
    private globalErrorHandler;
    private routeFallbackHandler;
    private apiFallbackHandler;
    private apiInputValidationErrorHandler;
    private sessionExpiredRouteHandler;
    private publicFilesHandler;
    private indexHtmlHandler;
    private eventActionList;
    private corsConfig;
    private finalizeOptions;
    private requireSessionApiGuards;
    /** Told what a request threw, beside whatever answers it; null outside a test. See LAMBDER_CRASH_WATCH. */
    private crashWatcher;
    private readonly trustedClientIpHeaders;
    private requirePublicApiGuards;
    constructor(options?: LambderCreateOptions<TSessionData>);
    setRouteFallbackHandler(routeFallbackHandler: LambderFallbackHandler): this;
    setApiFallbackHandler(apiFallbackHandler: LambderFallbackHandler): this;
    setApiInputValidationErrorHandler(apiInputValidationErrorHandler: LambderInputValidationHandler): this;
    setGlobalErrorHandler(globalErrorHandler: LambderGlobalErrorHandler): this;
    /** Response for session routes when the session is missing/expired (non-API). Default: 401. */
    setSessionExpiredRouteHandler(handler: LambderFallbackHandler): this;
    /**
     * Terminal public-file layer. Runs only when no route matched, so it can
     * never shadow routes registered after it. Serves files from the `files`
     * source configured at creation, under the reader's path rule, mime-typed,
     * memory-cached, with the immutable-cache heuristic for content-hashed
     * assets. Only configured methods reach it, default GET/HEAD, as for
     * serveIndexHtml; a gated-out method and a path the source has no file
     * for both fall through to setRouteFallbackHandler, where the app decides
     * what remains (e.g. render an app shell with res.templateFile).
     */
    servePublicFiles(options?: LambderPublicFilesOptions): this;
    /**
     * Serve the app shell for page requests that nothing else handled. Runs
     * after servePublicFiles in the fallback chain, so real files are already
     * gone; everything left is an app route (option `skipFilePaths` opts back
     * into 404ing dotted paths). Only configured methods reach it, default
     * GET/HEAD. Gated-out requests fall through to setRouteFallbackHandler.
     * Without a handler, index.html from the files source is served via
     * res.templateFile (markers optional) with no-cache.
     */
    serveIndexHtml(handler?: LambderFallbackHandler, options?: LambderIndexHtmlOptions): this;
    addRoute<TPath extends LambderRoutePath>(condition: TPath, actionFn: (ctx: LambderRenderContext<any, LambderPathParamsOf<TPath>>, resolver: LambderResolver) => MaybePromise<LambderResponse>): this;
    addRoute(condition: RegExp | LambderRouteConditionFn | LambderRouteMatcher, actionFn: LambderRouteHandler): this;
    addSessionRoute<TPath extends LambderRoutePath>(condition: TPath, actionFn: ((ctx: LambderSessionRenderContext<any, TSessionData, LambderPathParamsOf<TPath>>, resolver: LambderResolver) => MaybePromise<LambderResponse>) & LambderSessionEnabledInstance<_TSessionsEnabled>): this;
    addSessionRoute(condition: RegExp | LambderRouteConditionFn | LambderRouteMatcher, actionFn: LambderSessionRouteHandler<TSessionData> & LambderSessionEnabledInstance<_TSessionsEnabled>): this;
    addApi<TName extends string, TInput extends z.ZodType, TOutput extends z.ZodType, const TRateOpt extends LambderRateLimitOption<_TRateLimitPolicies, z.infer<TInput>, false> = never, const TGuardsOpt extends LambderGuardsOption<_TGuards, z.infer<TInput>, false> = never, const TIdempotencyOpt extends LambderApiIdempotencyOption = never>(name: TName, schema: {
        input: TInput;
        output: TOutput;
    } & {
        /** Named rate limits, checked in declared order before guards and validation: a name, a list of names, or a { name: true | override } map (windows overridable on perApi budgets, errorMessage on any). The first exceeded one refuses (429 envelope + Retry-After); attempts count on every counter checked before it. */
        rateLimit?: TRateOpt;
        /** Replay-protect this API per client idempotencyKey. Requires the idempotency option at creation. */
        idempotency?: _TIdempotencyEnabled extends true ? TIdempotencyOpt : never;
    } & LambderRequirableGuardsField<_TPublicGuardsRequired, TGuardsOpt>, handler: (ctx: LambderRenderContext<z.infer<TInput>, Record<string, string>, LambderGuardDataOf<_TGuards, TGuardsOpt>>, resolver: LambderResolver<z.infer<TOutput>>) => MaybePromise<LambderResponse>): Lambder<TSessionData, LambderMergeContract<_TContract, TName, LambderContractEntry<z.infer<TInput>, z.infer<TOutput>, "public", LambderGuardInputsOf<_TGuards, TGuardsOpt>, TGuardsOpt, TRateOpt, TIdempotencyOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled, _TSessionGuardsRequired, _TPublicGuardsRequired, _TSessionsEnabled>;
    addSessionApi<TName extends string, TInput extends z.ZodType, TOutput extends z.ZodType, const TRateOpt extends LambderRateLimitOption<_TRateLimitPolicies, z.infer<TInput>, true> = never, const TGuardsOpt extends LambderGuardsOption<_TGuards, z.infer<TInput>, true> = never, const TIdempotencyOpt extends LambderApiIdempotencyOption = never>(name: TName, schema: {
        input: TInput;
        output: TOutput;
    } & {
        /** Named rate limits, checked in declared order before guards and validation: a name, a list of names, or a { name: true | override } map (windows overridable on perApi budgets, errorMessage on any). The first exceeded one refuses (429 envelope + Retry-After); attempts count on every counter checked before it. */
        rateLimit?: TRateOpt;
        /** Replay-protect this API per client idempotencyKey. Requires the idempotency option at creation. */
        idempotency?: _TIdempotencyEnabled extends true ? TIdempotencyOpt : never;
    } & LambderRequirableGuardsField<_TSessionGuardsRequired, TGuardsOpt> & LambderSessionEnabledInstance<_TSessionsEnabled>, handler: (ctx: LambderSessionRenderContext<z.infer<TInput>, TSessionData, Record<string, string>, LambderGuardDataOf<_TGuards, TGuardsOpt>>, resolver: LambderResolver<z.infer<TOutput>>) => MaybePromise<LambderResponse>): Lambder<TSessionData, LambderMergeContract<_TContract, TName, LambderContractEntry<z.infer<TInput>, z.infer<TOutput>, "session", LambderGuardInputsOf<_TGuards, TGuardsOpt>, TGuardsOpt, TRateOpt, TIdempotencyOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled, _TSessionGuardsRequired, _TPublicGuardsRequired, _TSessionsEnabled>;
    addHook(hookEvent: 'created', hookFn: LambderCreatedHook, priority?: number): this;
    addHook(hookEvent: 'beforeRender', hookFn: LambderBeforeRenderHook, priority?: number): this;
    addHook(hookEvent: 'afterRender', hookFn: LambderAfterRenderHook, priority?: number): this;
    addHook(hookEvent: 'fallback', hookFn: LambderFallbackHook, priority?: number): this;
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
    use<_TNewContract extends Record<string, any>>(plugin: (lambder: Lambder<TSessionData, _TContract, any, any, any, any, any, any>) => Lambder<TSessionData, _TNewContract, any, any, any, any, any, any>): Lambder<TSessionData, _TNewContract extends _TContract ? _TNewContract : (_TContract & _TNewContract), _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled, _TSessionGuardsRequired, _TPublicGuardsRequired, _TSessionsEnabled>;
    /**
     * Sessions for this request: what handlers create, rotate, refresh and
     * end sessions with. An API call presents its posted CSRF token; a route
     * presents cookies alone.
     */
    getSessionController(ctx: LambderRenderContext | LambderSessionRenderContext<any, TSessionData>): LambderSessionController<TSessionData>;
    /** The session manager, for code that works on sessions outside a request (maintenance, tests). */
    getSessionManager(): LambderSessionManager<TSessionData>;
    /**
     * The backend swap `lambder/testing` performs: the stores given go under
     * this instance in place, so every handler and guard that closed over it
     * reaches them, and the production ones are out of reach from then on.
     * Keyed by a symbol no entry point exports, so it is not part of what an
     * app can call; see LAMBDER_BACKEND_SWAP.
     */
    [LAMBDER_BACKEND_SWAP](backends: LambderInstanceBackends): LambderInstanceBackendSwap;
    /**
     * The crash watch `lambder/testing` sets: told every error a request
     * throws past the framework's own handling, before the global error
     * handler or the last-resort 500 answers it. The answer is unchanged.
     */
    [LAMBDER_CRASH_WATCH](watcher: (error: Error) => void): void;
    /**
     * Every registered endpoint's signature, keyed by its hashed name: the
     * LambderApiSignatureMap both sides ship with. A generator imports the
     * finished instance, awaits this, and writes the result to a file the
     * frontend passes to LambderCaller as apiSignatures and the server passes
     * to create() as apiSignatures; at request time the pipeline compares a
     * call's signature with the server's copy of the same map. This is the
     * one place a digest is computed, so it has nothing to agree with but
     * itself. Keys are sorted, so the generated file diffs by endpoint.
     */
    apiSignatures(): Promise<LambderApiSignatureMap>;
    /**
     * The same signatures with the endpoint name each one was digested from,
     * sorted by key as the map is. What apiSignatures() leaves out on purpose:
     * the map a client ships lists no names, so a generator that only had the
     * map could report that four signatures changed but not which endpoints.
     * Reading this instead, it can name them.
     *
     * A build-time view by construction. It comes off the server instance,
     * which a generator imports and a client never does, so nothing here
     * reaches a bundle unless the generator writes it there.
     */
    apiSignatureEntries(): Promise<LambderApiSignatureEntry[]>;
    getResponseBuilder(ctx?: LambderRenderContext): LambderResponseBuilder<any>;
    private getResolver;
    getHandler(): LambderHandler;
    /** True when the Lambda event is an API Gateway HTTP event (REST API v1 or HTTP API / Function URL v2). */
    static isHttpEvent(event: unknown): event is LambderHttpEvent;
    private ensureInitialized;
    private applyCors;
    /**
     * The beforeRender hooks, in priority order: the replaced context to
     * continue with, or the response one of them answered with.
     *
     * Its own method because BOTH request paths run it. Left inline after the
     * match, it ran for routes and APIs and for nothing else, so a
     * servePublicFiles or serveIndexHtml answer, which is every asset and
     * every app-shell page, skipped the one hook that can inspect a request,
     * replace its context or short-circuit it: a security header written in a
     * hook reached the API answers and not the HTML it was written for, and a
     * maintenance-mode hook served the whole frontend anyway.
     */
    private runBeforeRenderHooks;
    private handleNoMatchedAction;
    /**
     * True for the OPTIONS request the CORS layer answers by itself. Asked
     * twice: once to build the 204, once at the end of render() to decide
     * which form of the headers goes on. Asking once and letting the tail
     * apply the ordinary headers on top of the 204's would put both forms on
     * a preflight, answering `Vary: Origin, Origin` and an
     * Access-Control-Expose-Headers that means nothing before a request.
     */
    private isCorsPreflight;
    private resolveRequest;
    render(event: LambderHttpEvent, lambdaContext: Context): Promise<LambderHttpResponse>;
    /**
     * Fetch the session for a session route or short-circuit it with the
     * sessionExpiredRouteHandler response (default 401). Session APIs never
     * come through here: the pipeline answers them with the protocol's
     * { sessionExpired: true } envelope itself.
     */
    private requireSession;
    /** Dispatch a non-HTTP Lambda event to the registered actions. */
    renderEvent(event: unknown, lambdaContext: Context): Promise<unknown>;
    /** Registration-time checks shared by addApi/addSessionApi. */
    private assertApiRegistration;
    /**
     * The answer for a rejected input: the app's
     * setApiInputValidationErrorHandler when set, otherwise the standard 422
     * body. The API's own schema and every preflight slice (guard inputs,
     * rate-limit keys) answer through here, so one failure has one shape.
     */
    private inputValidationRefusal;
    /**
     * One API call through the core: the pipeline runs the protocol steps and
     * calls back for the handler, whose LambderResponse (returned, or thrown
     * via res.die.*) becomes the answer the pipeline stores and hands back.
     * The context is the pipeline's context, so a session it fetched is on
     * ctx.session and the validated payload is on ctx.apiPayload when the
     * handler runs.
     */
    private runApi;
    /** A thrown LambderApiRefusal (from a hook, say) as the structured API envelope: the core's one mapping. */
    private apiErrorResponse;
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
 *     session: { store: new LambderDdbSessionStore({ tableName: "app-session", region: "us-east-1" }), sessionSalt: "..." },
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
    create<const TOptions extends LambderCreateOptions<TSessionData>>(options: LambderNoExtraKeys<TOptions, LambderCreateOptions<TSessionData>> & LambderNestedOptionChecks<TSessionData, TOptions>): Lambder<TSessionData, {}, TOptions["rateLimits"] extends {
        policies: infer TPolicies extends Record<string, LambderApiRateLimitPolicyConfig>;
    } ? TPolicies : {}, TOptions["guards"] extends Record<string, LambderApiGuard<any, any, any>> ? LambderGuardMetaMap<TOptions["guards"]> : {}, TOptions["idempotency"] extends LambderApiIdempotencyConfig ? true : false, [LambderGivenOption<TOptions, "requireSessionApiGuards">] extends [false | undefined] ? false : true, [LambderGivenOption<TOptions, "requirePublicApiGuards">] extends [false | undefined] ? false : true, [LambderGivenOption<TOptions, "session">] extends [undefined] ? false : true>;
};

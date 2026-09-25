import type { z } from "zod";

import type { Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import {
    LambderResponse,
    finalizeResponse,
    answerFromResponse,
    responseFromAnswer,
    emitResponse,
    DEFAULT_FINALIZE_OPTIONS,
    DEFAULT_RESPONSE_COMPRESSION_SETTINGS,
    type LambderFinalizeOptions,
    type LambderHttpResponse,
} from "./LambderResponse.js";
import { compileRouteMatcher, type CompiledMatcher, type LambderRouteCondition, type LambderRouteConditionFn, type LambderRouteMatcher, type LambderPathParamsOf, type LambderRoutePath } from "./LambderRouting.js";
import { allowedCorsOriginOf, applyCorsHeaders, type LambderCorsConfig } from "./LambderCors.js";
import LambderSessionManager from "../session/LambderSessionManager.js";
import { resolveCompressionOption } from "../shared/wire/LambderCompressionOption.js";
import { DEFAULT_API_PATH } from "../shared/wire/LambderDefaultApiPath.js";
import type LambderSessionController from "../session/LambderSessionController.js";
import { LambderSessionNotFoundError } from "../session/LambderSessionController.js";
import { LambderPublicFilesHandler, type LambderPublicFilesOptions } from "./LambderPublicFiles.js";
import { LambderIndexHtmlHandler, type LambderIndexHtmlOptions } from "./LambderIndexHtml.js";
import { LambderFiles } from "./LambderFiles.js";
import { isLambderApiRefusal, type LambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
import { LambderApiPipeline, type LambderPipelineBackends, type LambderPipelineBackendSwap } from "../api/LambderApiPipeline.js";
import type { LambderFileSource } from "../shared/contracts/LambderFileSource.js";
import { LAMBDER_BACKEND_SWAP, LAMBDER_CRASH_WATCH } from "../shared/util/LambderTestingDoors.js";
import type { LambderApiDefinition } from "../api/LambderApiDefinition.js";
import { apiSignatureOf, type LambderApiSignatureEntry } from "../api/LambderApiSignature.js";
import { apiNameKeyOf, type LambderApiSignatureMap } from "../shared/wire/LambderApiSignature.js";
import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type {
    LambderApiIdempotencyOption,
    LambderGuardsOptionValue,
    LambderRateLimitOptionValue,
} from "../shared/wire/LambderApiOptionValues.js";
import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import {
    apiNotFoundAnswer,
    refusalAnswer,
    sessionExpiredAnswer,
} from "../api/LambderApiEnvelope.js";
import type {
    LambderApiGuard,
    LambderGuardMetaMap,
    LambderGuardsOption,
    LambderGuardDataOf,
    LambderGuardInputsOf,
} from "../api/LambderApiGuards.js";
import type {
    LambderApiRateLimitPolicyConfig,
    LambderRateLimitOption,
} from "../api/LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "../api/LambderApiIdempotency.js";
import type { LambderContractEntry, LambderJsonOutputOf, LambderMergeContract } from "../shared/wire/LambderApiContract.js";
import {
    bindContextTools,
    createContext,
    isV2HttpEvent,
    type LambderContextTools,
    type LambderHttpEvent,
    type LambderRenderContext,
    type LambderSessionRenderContext,
} from "./LambderContext.js";
import { COMPRESSED_PAYLOAD_GZ_FIELD, COMPRESSED_PAYLOAD_BR_FIELD, COMPRESSED_PAYLOAD_BYTES_FIELD } from "../shared/wire/LambderRequestPayload.js";
import type { MaybePromise } from "../shared/util/LambderTypeUtilities.js";
import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import { LambderCrashHandling } from "./LambderCrashHandling.js";
import { policyBuildersFor } from "./LambderPolicyBuilders.js";
import {
    assertCreateOptions,
    type LambderRouteHandler,
    type LambderActionFilter,
    type LambderInputValidationHandler,
    type LambderFallbackHandler,
    type LambderGlobalErrorHandler,
    type LambderAfterRenderHook,
    type LambderBeforeRenderHook,
    type LambderHookEvent,
    type LambderFallbackHook,
    type LambderActionTools,
    type LambderCreateOptions,
    type LambderGivenOption,
    type LambderHandler,
    type LambderNestedOptionChecks,
    type LambderNoExtraKeys,
    type LambderRequirableGuardsField,
    type LambderSessionEnabledInstance,
    type LambderSessionRouteHandler,
    type LambderActionHandler,
    type LambderCrashSite,
} from "./LambderCreateOptions.js";

/** Everything `lambder/testing` may put under a built instance: the pipeline's stores, and the source its files are read from. */
export type LambderInstanceBackends = LambderPipelineBackends & { fileSource?: LambderFileSource };
/** What the instance had a place for; see LambderPipelineBackendSwap. `files` is false on an instance created without the files option. */
export type LambderInstanceBackendSwap = LambderPipelineBackendSwap & { files: boolean };

/**
 * The "created" hook: run once the instance exists, with the instance. It is
 * declared here rather than beside the other hooks in LambderCreateOptions
 * because its parameter is the class, and an options module that names the
 * class cannot be read without it.
 */
export type LambderCreatedHook = (lambderInstance: Lambder<any, any, any, any, any, any, any, any>) => void | Promise<void>;

// The two shapes the class keeps for its own handler lists: a compiled route
// matcher beside the action it dispatches to, and the non-HTTP twin.
type ActionObject = { match: CompiledMatcher, actionFn: LambderRouteHandler };
type EventActionObject = { match: (event: unknown) => boolean, actionFn: (event: unknown, lambdaContext: Context) => MaybePromise<unknown> };

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
 * @typeParam _TSessionsEnabled - @internal True when create() received the session option (do not pass manually). Defaults to true, unlike its siblings, so a plugin annotating its parameter as the bare Lambder<SessionData> can still register session APIs. create() knows the option and supplies the false; `new Lambder(...)` relies on the registration-time throw alone.
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
export default class Lambder<
    TSessionData = any,
    _TContract extends Record<string, any> = {},
    _TRateLimitPolicies extends Record<string, LambderApiRateLimitPolicyConfig> = {},
    _TGuards extends Record<string, any> = {},
    _TIdempotencyEnabled extends boolean = false,
    _TSessionGuardsRequired extends boolean = false,
    _TPublicGuardsRequired extends boolean = false,
    _TSessionsEnabled extends boolean = true,
> {
    // =====================================================================
    // Construction
    // Everything an instance is, fixed before the first registration.
    // =====================================================================
    public apiPath: string;
    /** Stamped on every API answer's envelope as apiVersion. Informational: a client's staleness is judged per endpoint by its signature, see apiSignatures(). */
    public apiVersion: null | string;
    /** The instance's file reader (source + caches), or null without the files option. */
    public files: LambderFiles | null;

    /**
     * Type property for extracting the API contract, to export your API
     * types to the frontend.
     *
     * Export it as an interface extending LambderFlattenContract, not as a
     * type alias. Chaining builds the contract as an intersection one member
     * deep per endpoint; an interface collapses that into one declared set of
     * members, which every generic read of the contract (a mock registry, a
     * needs map, the typed caller) checks far more cheaply. See
     * LambderFlattenContract for the measurements.
     *
     * @example
     * ```typescript
     * const lambder = new Lambder().addApi(...).addApi(...);
     * export interface ApiContractType extends LambderFlattenContract<typeof lambder.ApiContract> {}
     * ```
     */
    public readonly ApiContract!: _TContract;

    private actionList: ActionObject[] = [];
    /** The API core: the pipeline every API call runs through, shared in shape with the mock runtime. */
    private readonly pipeline: LambderApiPipeline<LambderRenderContext, TSessionData>;
    /** Every registered API by name: the duplicate-name check, and what apiSignatures() digests. */
    private readonly apiDefinitions = new Map<string, LambderApiDefinition>();
    /** The guards map given at creation, kept for apiSignatures(): a guard's schema is part of the signature of every endpoint declaring it. */
    private readonly guards: LambderCreateOptions<TSessionData>["guards"];
    private hookList: {
        "beforeRender": { priority: number, hookFn: LambderBeforeRenderHook }[],
        "afterRender": { priority: number, hookFn: LambderAfterRenderHook }[],
        "fallback": { priority: number, hookFn: LambderFallbackHook }[],
    } = { "beforeRender": [], "afterRender": [], "fallback": [] };
    private createdHooks: LambderCreatedHook[] = [];
    private initPromise: Promise<void> | null = null;

    private globalErrorHandler: LambderGlobalErrorHandler | null = null;
    private routeFallbackHandler: LambderFallbackHandler | null = null;
    private apiFallbackHandler: LambderFallbackHandler | null = null;
    private apiInputValidationErrorHandler: LambderInputValidationHandler | null = null;
    private sessionExpiredRouteHandler: LambderFallbackHandler | null = null;
    private publicFilesHandler: LambderPublicFilesHandler | null = null;
    private indexHtmlHandler: LambderIndexHtmlHandler | null = null;
    private eventActionList: EventActionObject[] = [];
    private corsConfig: LambderCorsConfig | null = null;
    private finalizeOptions: LambderFinalizeOptions;
    private requireSessionApiGuards: boolean;
    /** Told what a request threw, beside whatever answers it; null outside a test. See LAMBDER_CRASH_WATCH. */
    private crashWatcher: ((error: Error) => void) | null = null;
    /** The crashes option applied: reporting, and the framework's own 500. */
    private readonly crashHandling: LambderCrashHandling;
    /** What this instance binds onto every context it renders (ctx.sessionController, ctx.rateLimit, ctx.isRateLimited). */
    private readonly contextTools: LambderContextTools;
    private readonly trustedClientIpHeaders: readonly string[];
    private readonly trustedHostHeaders: readonly string[];
    private requirePublicApiGuards: boolean;

    constructor(options: LambderCreateOptions<TSessionData> = {}){
        assertCreateOptions(options);
        this.files = options.files ? new LambderFiles(options.files) : null;
        this.apiPath = options.apiPath ?? DEFAULT_API_PATH;
        this.apiVersion = options.apiVersion ?? null;

        // Resolved (and validated) by the same function the at-rest stores
        // use; on unless explicitly disabled, except on a REST API, where it
        // is on only when the app names it: see LambderFinalizeOptions.
        const compression = resolveCompressionOption(options.compression, DEFAULT_RESPONSE_COMPRESSION_SETTINGS);
        this.finalizeOptions = {
            compression: { v1: options.compression === undefined ? null : compression, v2: compression },
            etag: options.etag ?? DEFAULT_FINALIZE_OPTIONS.etag,
            maxResponseBytes: options.maxResponseBytes ?? DEFAULT_FINALIZE_OPTIONS.maxResponseBytes,
        };
        if(options.cors !== undefined && options.cors !== false){
            this.corsConfig = options.cors === true ? {} : options.cors;
        }

        const session = options.session;
        this.guards = options.guards;
        this.pipeline = new LambderApiPipeline<LambderRenderContext, TSessionData>({
            apiVersion: this.apiVersion,
            minApiVersion: options.minApiVersion,
            apiSignatures: options.apiSignatures,
            maxRequestPayloadBytes: options.maxRequestPayloadBytes,
            // The app's own validation handler is read at call time, since
            // setApiInputValidationErrorHandler runs after creation.
            onInvalidInput: (zodError, ctx) => this.inputValidationRefusal(ctx, zodError),
            sessions: session
                ? {
                    manager: new LambderSessionManager<TSessionData>({
                        store: session.store,
                        sessionSalt: session.sessionSalt,
                        enableSlidingExpiration: session.enableSlidingExpiration,
                        slidingWriteIntervalSeconds: session.slidingWriteIntervalSeconds,
                        dataRefresh: session.dataRefresh,
                        crypto: session.crypto,
                    }),
                    tokenCookieKey: session.tokenCookieKey,
                    csrfCookieKey: session.csrfCookieKey,
                    cookieOptions: session.cookie,
                }
                : undefined,
            rateLimits: options.rateLimits,
            guards: options.guards,
            idempotency: options.idempotency,
        });

        this.trustedClientIpHeaders = options.trustedClientIpHeaders ?? [];
        this.trustedHostHeaders = options.trustedHostHeaders ?? [];
        this.requireSessionApiGuards = options.requireSessionApiGuards ?? false;
        this.requirePublicApiGuards = options.requirePublicApiGuards ?? false;
        this.crashHandling = new LambderCrashHandling(options.crashes ?? {}, this.apiVersion);
        this.contextTools = {
            sessionControllerFor: (ctx) => this.getSessionController(ctx),
            chargeRateLimit: async (ctx, policy, key, refuse) => {
                const { checkResult, refusal } = await this.pipeline.chargeRateLimit(policy, {
                    // A per-API budget counts per registered API. The posted
                    // name of a call no API matched (a hook or the fallback
                    // charging it) is the caller's choice, and a fresh name
                    // per request would be a fresh counter.
                    apiName: ctx.api && this.apiDefinitions.has(ctx.api.apiName) ? ctx.api.apiName : null,
                    ip: ctx.ip,
                    session: ctx.session,
                    key,
                });
                if(refuse && refusal){
                    if(ctx.api) throw refusal;
                    // A route has no envelope to carry a refusal, so it
                    // answers the same 429 as text, with the same Retry-After
                    // and the policy's own words.
                    throw this.getResolver(ctx).text(refusal.errorMessage.content, { statusCode: 429, headers: refusal.headers });
                }
                return checkResult;
            },
        };
    }

    // =====================================================================
    // Registration
    // What an app declares on the instance; all of it chains.
    // =====================================================================
    setRouteFallbackHandler(routeFallbackHandler: LambderFallbackHandler): this {
        this.routeFallbackHandler = routeFallbackHandler;
        return this;
    }
    setApiFallbackHandler(apiFallbackHandler: LambderFallbackHandler): this {
        this.apiFallbackHandler = apiFallbackHandler;
        return this;
    }
    setApiInputValidationErrorHandler(apiInputValidationErrorHandler: LambderInputValidationHandler): this {
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;
        return this;
    }
    setGlobalErrorHandler(globalErrorHandler: LambderGlobalErrorHandler): this {
        this.globalErrorHandler = globalErrorHandler;
        return this;
    }
    /**
     * Response for a session route when the session is missing or expired,
     * and for any non-API request whose route or hook meets a
     * LambderSessionNotFoundError (the session ended while the request held
     * it, or a session read found none, or cookies naming several: a
     * LambderSessionAmbiguousError). Default: 401.
     */
    setSessionExpiredRouteHandler(handler: LambderFallbackHandler): this {
        this.sessionExpiredRouteHandler = handler;
        return this;
    }

    /**
     * Terminal public-file layer. Runs only when no route matched, so it can
     * never shadow routes registered after it. Serves files from the `files`
     * source configured at creation, under the reader's path rule, mime-typed,
     * memory-cached, with the immutable-cache heuristic for content-hashed
     * assets. Only configured methods reach it (default GET/HEAD); a
     * gated-out method or a path with no file falls through to
     * setRouteFallbackHandler, where the app decides what remains (e.g.
     * render an app shell with res.templateFile).
     */
    servePublicFiles(options: LambderPublicFilesOptions = {}): this {
        if(!this.files) throw new Error("Lambder: servePublicFiles requires the files option at creation (e.g. files: new LambderLocalFileSource({ root }))");
        this.publicFilesHandler = new LambderPublicFilesHandler(this.files, options);
        return this;
    }

    /**
     * Serve the app shell for page requests that nothing else handled. Runs
     * after servePublicFiles in the fallback chain, so real files are already
     * gone; everything left is an app route (option `skipFilePaths` opts back
     * into 404ing dotted paths). Only configured methods reach it, default
     * GET/HEAD. Gated-out requests fall through to setRouteFallbackHandler.
     * Without a handler, index.html from the files source is served via
     * res.templateFile (markers optional) with no-cache.
     */
    serveIndexHtml(handler?: LambderFallbackHandler, options: LambderIndexHtmlOptions = {}): this {
        this.indexHtmlHandler = new LambderIndexHtmlHandler(handler ?? null, options);
        return this;
    }

    addRoute<TPath extends LambderRoutePath>(
        condition: TPath,
        actionFn: (ctx: LambderRenderContext<any, LambderPathParamsOf<TPath>, {}, TSessionData, _TRateLimitPolicies>, resolver: LambderResolver) => MaybePromise<LambderResponse>,
    ): this;
    addRoute(condition: RegExp | LambderRouteConditionFn | LambderRouteMatcher, actionFn: LambderRouteHandler): this;
    addRoute(condition: LambderRouteCondition, actionFn: (ctx: any, resolver: LambderResolver) => MaybePromise<LambderResponse>): this {
        this.actionList.push({
            match: compileRouteMatcher(condition),
            actionFn: (ctx, resolver) => actionFn(ctx, resolver),
        });
        return this;
    }

    addSessionRoute<TPath extends LambderRoutePath>(
        condition: TPath,
        actionFn: ((ctx: LambderSessionRenderContext<any, TSessionData, LambderPathParamsOf<TPath>, {}, _TRateLimitPolicies>, resolver: LambderResolver) => MaybePromise<LambderResponse>) & LambderSessionEnabledInstance<_TSessionsEnabled>,
    ): this;
    addSessionRoute(condition: RegExp | LambderRouteConditionFn | LambderRouteMatcher, actionFn: LambderSessionRouteHandler<TSessionData> & LambderSessionEnabledInstance<_TSessionsEnabled>): this;
    addSessionRoute(condition: LambderRouteCondition, actionFn: (ctx: any, resolver: LambderResolver) => MaybePromise<LambderResponse>): this {
        this.actionList.push({
            match: compileRouteMatcher(condition),
            actionFn: async (ctx, resolver) => {
                await this.requireSession(ctx, resolver);
                // requireSession answered already if there was no session, so
                // the only narrowing left is null to non-null.
                return await actionFn(ctx as LambderSessionRenderContext<any, TSessionData>, resolver);
            },
        });
        return this;
    }

    // Typed API with Zod
    public addApi<
        TName extends string,
        TInput extends z.ZodType,
        TOutput extends z.ZodType,
        const TRateOpt extends LambderRateLimitOption<_TRateLimitPolicies, z.input<TInput>, false> = never,
        const TGuardsOpt extends LambderGuardsOption<_TGuards, z.input<TInput>, false> = never,
        const TIdempotencyOpt extends LambderApiIdempotencyOption = never,
    >(
        name: TName,
        schema: { input: TInput, output: TOutput } & {
            /** Named rate limits, checked in declared order within their phase (per ip before the session read, per session before the guards, a custom key after the guards and input validation): a name, a list of names, or a { name: true | override } map (windows overridable on perApi budgets, errorMessage on any). The first exceeded one refuses (429 envelope + Retry-After); attempts count on every counter checked before it. */
            rateLimit?: TRateOpt;
            /** Replay-protect this API per client idempotencyKey. Requires the idempotency option at creation. */
            idempotency?: _TIdempotencyEnabled extends true ? TIdempotencyOpt : never;
        } & LambderRequirableGuardsField<_TPublicGuardsRequired, TGuardsOpt>,
        handler: (
            ctx: LambderRenderContext<z.infer<TInput>, Record<string, string>, LambderGuardDataOf<_TGuards, TGuardsOpt>, TSessionData, _TRateLimitPolicies>,
            resolver: LambderResolver<z.input<TOutput>>
        ) => MaybePromise<LambderResponse>
    ): Lambder<TSessionData, LambderMergeContract<_TContract, TName, LambderContractEntry<
        z.input<TInput>,
        LambderJsonOutputOf<z.output<TOutput>>,
        "public",
        LambderGuardInputsOf<_TGuards, TGuardsOpt>,
        TGuardsOpt,
        TRateOpt,
        TIdempotencyOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled, _TSessionGuardsRequired, _TPublicGuardsRequired, _TSessionsEnabled> {
        this.registerApi(name, "public", schema, handler as never);
        return this as any;
    }

    // Typed Session API with Zod
    public addSessionApi<
        TName extends string,
        TInput extends z.ZodType,
        TOutput extends z.ZodType,
        const TRateOpt extends LambderRateLimitOption<_TRateLimitPolicies, z.input<TInput>, true> = never,
        const TGuardsOpt extends LambderGuardsOption<_TGuards, z.input<TInput>, true> = never,
        const TIdempotencyOpt extends LambderApiIdempotencyOption = never,
    >(
        name: TName,
        schema: { input: TInput, output: TOutput } & {
            /** Named rate limits, checked in declared order within their phase (per ip before the session read, per session before the guards, a custom key after the guards and input validation): a name, a list of names, or a { name: true | override } map (windows overridable on perApi budgets, errorMessage on any). The first exceeded one refuses (429 envelope + Retry-After); attempts count on every counter checked before it. */
            rateLimit?: TRateOpt;
            /** Replay-protect this API per client idempotencyKey. Requires the idempotency option at creation. */
            idempotency?: _TIdempotencyEnabled extends true ? TIdempotencyOpt : never;
        } & LambderRequirableGuardsField<_TSessionGuardsRequired, TGuardsOpt> & LambderSessionEnabledInstance<_TSessionsEnabled>,
        handler: (
            ctx: LambderSessionRenderContext<z.infer<TInput>, TSessionData, Record<string, string>, LambderGuardDataOf<_TGuards, TGuardsOpt>, _TRateLimitPolicies>,
            resolver: LambderResolver<z.input<TOutput>>
        ) => MaybePromise<LambderResponse>
    ): Lambder<TSessionData, LambderMergeContract<_TContract, TName, LambderContractEntry<
        z.input<TInput>,
        LambderJsonOutputOf<z.output<TOutput>>,
        "session",
        LambderGuardInputsOf<_TGuards, TGuardsOpt>,
        TGuardsOpt,
        TRateOpt,
        TIdempotencyOpt>>, _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled, _TSessionGuardsRequired, _TPublicGuardsRequired, _TSessionsEnabled> {
        this.registerApi(name, "session", schema, handler as never);
        return this as any;
    }

    /**
     * What registering an API is, for addApi and addSessionApi alike: the
     * checks that can refuse it, then its definition recorded (what
     * apiSignatures() digests) and its action appended to the first-match
     * chain. The two public methods differ only in the mode and in the types
     * they give the handler.
     */
    private registerApi(
        name: string,
        mode: LambderApiMode,
        schema: { input: z.ZodType, output: z.ZodType, rateLimit?: LambderRateLimitOptionValue, guards?: LambderGuardsOptionValue, idempotency?: LambderApiIdempotencyOption },
        handler: (ctx: never, resolver: LambderResolver) => MaybePromise<LambderResponse>,
    ): void {
        if(this.apiDefinitions.has(name)){
            throw new Error(`Lambder: duplicate API name "${name}". Dispatch is first-match, so the second registration would be silently dead code.`);
        }
        // Everything that can refuse the registration runs before the name is
        // claimed below: a refusal the app catches and fixes would otherwise
        // leave the name taken, and the retry would report a duplicate
        // instead of the problem it was fixing.
        if(mode === "session" && !this.pipeline.hasSessions){
            throw new Error(`Lambder: session API "${name}" needs the session option at creation.`);
        }
        const guardsRequired = mode === "session" ? this.requireSessionApiGuards : this.requirePublicApiGuards;
        if(guardsRequired && schema.guards === undefined){
            const optOut = mode === "session"
                ? "the named no-op guard that marks the session itself as the whole authorization"
                : "the named no-op guard that records why anyone may call it";
            throw new Error(
                `Lambder: ${mode} API "${name}" declares no guards, and require${mode === "session" ? "Session" : "Public"}ApiGuards is on. ` +
                `Declare the guard that authorizes it, or ${optOut}.`
            );
        }
        const definition: LambderApiDefinition = { name, mode, guards: schema.guards, rateLimit: schema.rateLimit, idempotency: schema.idempotency, input: schema.input, output: schema.output };
        this.pipeline.assertRegistration(definition);

        this.apiDefinitions.set(name, definition);
        this.actionList.push({
            match: (ctx) => ctx.apiName === name ? {} : false,
            actionFn: (ctx) => this.runApi(ctx, definition, handler),
        });
    }

    addHook(hookEvent: 'created', hookFn: LambderCreatedHook, priority?: number): this;
    addHook(hookEvent: 'beforeRender', hookFn: LambderBeforeRenderHook, priority?: number): this;
    addHook(hookEvent: 'afterRender', hookFn: LambderAfterRenderHook, priority?: number): this;
    addHook(hookEvent: 'fallback', hookFn: LambderFallbackHook, priority?: number): this;
    addHook(
        hookEvent: LambderHookEvent,
        hookFn: LambderCreatedHook & LambderBeforeRenderHook & LambderAfterRenderHook & LambderFallbackHook,
        priority = 0
    ): this {
        if(hookEvent === "created"){
            // Runs once, lazily, before the first request or event is handled.
            this.createdHooks.push(hookFn);
        }else{
            this.hookList[hookEvent].push({ priority, hookFn });
            this.hookList[hookEvent].sort((a, b) => a.priority - b.priority);
        }
        return this;
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
        filter: LambderActionFilter,
        actionFn: LambderActionHandler<any>,
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

    // Plugin system
    // The policy generics are `any` in the plugin signature on purpose: a
    // module may annotate its parameter as the bare Lambder<SessionData> or
    // as the app's narrowed alias, and both must chain. Registration-time
    // assertions still check every referenced policy/guard name. Every
    // policy generic must be listed: a missing one falls back to its default,
    // making an instance with a non-default value unassignable to its own
    // plugins.
    public use<_TNewContract extends Record<string, any>>(
        plugin: (
            lambder: Lambder<TSessionData, _TContract, any, any, any, any, any, any>
        ) => Lambder<TSessionData, _TNewContract, any, any, any, any, any, any>
    ): Lambder<TSessionData, _TNewContract extends _TContract ? _TNewContract : (_TContract & _TNewContract), _TRateLimitPolicies, _TGuards, _TIdempotencyEnabled, _TSessionGuardsRequired, _TPublicGuardsRequired, _TSessionsEnabled> {
        return plugin(this as any) as any;
    }

    // =====================================================================
    // Accessors
    // What a handler or an app asks the instance for.
    // =====================================================================
    /**
     * A session controller for a context: what creates, rotates, refreshes
     * and ends sessions. An API call presents its posted CSRF token; a route
     * presents cookies alone. A context this instance renders already
     * carries one as `ctx.sessionController`; this is for a context it did
     * not render, such as one createContext() built from an event on its own.
     */
    getSessionController(ctx: LambderRenderContext | LambderSessionRenderContext<any, TSessionData>): LambderSessionController<TSessionData>{
        const context = ctx as LambderRenderContext;
        return this.pipeline.sessionController(
            context,
            context.api ? LambderApiPipeline.sessionInfoOf(context.api) : { host: context.host, cookies: context.cookieList, csrfToken: null },
        );
    }

    /** The session manager, for code that works on sessions outside a request (maintenance, tests). */
    getSessionManager(): LambderSessionManager<TSessionData> {
        return this.pipeline.sessionManager;
    }

    /**
     * The backend swap `lambder/testing` performs: the stores given go under
     * this instance in place, so every handler and guard that closed over it
     * reaches them, and the production ones are out of reach from then on.
     * Keyed by a symbol no entry point exports, so it is not part of what an
     * app can call; see LAMBDER_BACKEND_SWAP.
     */
    [LAMBDER_BACKEND_SWAP](backends: LambderInstanceBackends): LambderInstanceBackendSwap {
        if(this.files && backends.fileSource) this.files[LAMBDER_BACKEND_SWAP](backends.fileSource);
        return { ...this.pipeline[LAMBDER_BACKEND_SWAP](backends), files: this.files !== null };
    }

    /**
     * The crash watch `lambder/testing` sets: told every error a request
     * throws past the framework's own handling, before the global error
     * handler or the last-resort 500 answers it. The answer is unchanged.
     */
    [LAMBDER_CRASH_WATCH](watcher: (error: Error) => void): void {
        this.crashWatcher = watcher;
    }

    /**
     * Every registered endpoint's signature, keyed by its hashed name: the
     * LambderApiSignatureMap both sides ship with. A generator imports the
     * finished instance, awaits this, and writes a file that LambderCaller
     * and create() both take as apiSignatures; at request time the pipeline
     * compares a call's signature with the server's copy. This is the only
     * place a digest is computed, so there is no second computation to drift
     * from it. Keys are sorted, so the generated file diffs by endpoint.
     */
    async apiSignatures(): Promise<LambderApiSignatureMap> {
        return Object.fromEntries((await this.apiSignatureEntries()).map(({ key, signature }) => [key, signature]));
    }

    /**
     * The same signatures, sorted by key as the map is, with the endpoint
     * name each was digested from. The map a client ships deliberately lists
     * no names, so a generator reading only the map could say how many
     * signatures changed but not which endpoints; this lets it name them.
     *
     * A build-time view: it comes off the server instance, which a generator
     * imports and a client never does, so nothing here reaches a bundle
     * unless the generator writes it there.
     */
    async apiSignatureEntries(): Promise<LambderApiSignatureEntry[]> {
        const entries = await Promise.all([...this.apiDefinitions.values()].map(async (definition): Promise<LambderApiSignatureEntry> => ({
            name: definition.name,
            key: await apiNameKeyOf(definition.name),
            signature: await apiSignatureOf(definition, this.guards),
        })));
        entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return entries;
    }

    getResponseBuilder(ctx?: LambderRenderContext){
        return new LambderResponseBuilder({
            files: this.files,
            apiVersion: this.apiVersion,
            ctx,
        });
    };

    private getResolver(ctx: LambderRenderContext){
        return new LambderResolver({
            files: this.files,
            apiVersion: this.apiVersion,
            ctx,
        });
    };

    getHandler(): LambderHandler {
        return ((event: unknown, context: Context) =>
            Lambder.isHttpEvent(event)
                ? this.render(event, context)
                : this.renderEvent(event, context)
        ) as LambderHandler;
    }

    /** True when the Lambda event is an API Gateway HTTP event (REST API v1 or HTTP API / Function URL v2). */
    static isHttpEvent(event: unknown): event is LambderHttpEvent {
        if(!event || typeof event !== "object") return false;
        if("httpMethod" in event && "path" in event) return true;
        return isV2HttpEvent(event);
    }

    // =====================================================================
    // The request path
    // One HTTP invocation, from the event to the finalized response.
    // =====================================================================
    private ensureInitialized(): Promise<void> {
        if(!this.initPromise){
            const pending = (async () => {
                for(const hookFn of this.createdHooks){ await hookFn(this); }
            })();
            this.initPromise = pending;
            // A `created` hook usually reaches something that can be briefly
            // unavailable (a first DynamoDB read, a secret fetch). A kept
            // rejection would answer every later invocation on the warm
            // container with that first failure, so it is forgotten and the
            // next invocation runs the hooks again. Whoever is awaiting this
            // one still gets the rejection.
            pending.catch(() => { if(this.initPromise === pending) this.initPromise = null; });
        }
        return this.initPromise;
    }

    private applyCors(allowedOrigin: string | null, response: LambderResponse, isPreflight: boolean): void {
        applyCorsHeaders(this.corsConfig, allowedOrigin, response, isPreflight);
    }

    /**
     * The beforeRender hooks, in priority order: the replaced context to
     * continue with, or the response one of them answered with.
     *
     * Its own method because both request paths run it. Run only after a
     * match, it would skip every servePublicFiles and serveIndexHtml answer
     * (every asset and app-shell page): a security header written in a hook
     * would miss the HTML it was written for, and a maintenance-mode hook
     * would still serve the whole frontend.
     *
     * Each replacement is also handed to `onContextReplaced` as it is made,
     * rather than only returned: render() answers from it after the handler
     * too (the afterRender hooks, a crash's report, reveal and global error
     * handler), and a handler or a later hook that throws returns nothing.
     */
    private async runBeforeRenderHooks(
        ctx: LambderRenderContext,
        resolver: LambderResolver,
        onContextReplaced: (replacement: LambderRenderContext) => void,
    ): Promise<LambderRenderContext | LambderResponse> {
        let currentCtx = ctx;
        for(const hook of this.hookList["beforeRender"]){
            const hookResult = await hook.hookFn(currentCtx, resolver);
            if(hookResult instanceof Error) throw hookResult;
            if(hookResult instanceof LambderResponse) return hookResult;
            if(hookResult === currentCtx) continue;
            // A hook that answered with a new object (`{ ...ctx, extra }`)
            // carries none of the tools, which are not enumerable, so they are
            // bound again, onto the object the rest of the request uses.
            currentCtx = bindContextTools(hookResult, this.contextTools);
            onContextReplaced(currentCtx);
        }
        return currentCtx;
    }

    private async handleNoMatchedAction(
        ctx: LambderRenderContext,
        resolver: LambderResolver,
        onContextReplaced: (replacement: LambderRenderContext) => void,
    ): Promise<LambderResponse> {
        // Before the fallback hooks, and with the same power it has on a
        // matched route: the fallback hooks are typed void and cannot answer.
        const beforeRenderResult = await this.runBeforeRenderHooks(ctx, resolver, onContextReplaced);
        if(beforeRenderResult instanceof LambderResponse) return beforeRenderResult;
        const currentCtx = beforeRenderResult;

        for(const hook of this.hookList["fallback"]){ await hook.hookFn(currentCtx, resolver); }

        const isAPI = currentCtx.api !== null || currentCtx.path === this.apiPath;
        if(isAPI){
            if(this.apiFallbackHandler) return await this.apiFallbackHandler(currentCtx, resolver);
            return responseFromAnswer(currentCtx.api ? this.pipeline.answerUnknownApi(currentCtx) : apiNotFoundAnswer(this.apiVersion, currentCtx.logList));
        }
        if(this.publicFilesHandler){
            const fileResponse = await this.publicFilesHandler.handle(currentCtx);
            if(fileResponse) return fileResponse;
        }
        const indexResponse = this.indexHtmlHandler ? await this.indexHtmlHandler.handle(currentCtx, resolver) : null;
        if(indexResponse) return indexResponse;
        if(this.routeFallbackHandler) return await this.routeFallbackHandler(currentCtx, resolver);
        return resolver.text("Not found.", { statusCode: 404 });
    }

    /**
     * True for the OPTIONS request the CORS layer answers by itself. Asked
     * twice: once to build the 204, once at the end of render() to pick which
     * form of the headers goes on. Applying the ordinary headers on top of
     * the 204's would put both forms on a preflight: `Vary: Origin, Origin`
     * and an Access-Control-Expose-Headers that means nothing before a
     * request.
     */
    private isCorsPreflight(ctx: LambderRenderContext): boolean {
        return ctx.method === "OPTIONS" && !!this.corsConfig;
    }

    private async resolveRequest(
        ctx: LambderRenderContext,
        resolver: LambderResolver,
        onContextReplaced: (replacement: LambderRenderContext) => void,
    ): Promise<LambderResponse> {
        if(this.isCorsPreflight(ctx)) return new LambderResponse({ statusCode: 204, body: null });

        if(ctx.api){
            // The protocol's own pre-pass, run here rather than left to the
            // pipeline so that hooks and route matching see a plain payload,
            // and so a stale client is answered before any of them, whether or
            // not the name it asked for exists.
            const prepared = await this.pipeline.prepare(ctx.api);
            if(prepared) return responseFromAnswer(prepared);
            // ctx.post is the raw body view; it shows the restored payload and
            // none of the wire fields, so nothing reading it sees the format.
            ctx.apiPayload = ctx.api.payload;
            ctx.post.payload = ctx.api.payload;
            delete ctx.post[COMPRESSED_PAYLOAD_GZ_FIELD];
            delete ctx.post[COMPRESSED_PAYLOAD_BR_FIELD];
            delete ctx.post[COMPRESSED_PAYLOAD_BYTES_FIELD];
        }

        let matched: { action: ActionObject, params: Record<string, string> } | null = null;
        for(const action of this.actionList){
            const params = action.match(ctx);
            if(params !== false){ matched = { action, params }; break; }
        }
        if(!matched) return await this.handleNoMatchedAction(ctx, resolver, onContextReplaced);

        // Set before the hooks run, so a beforeRender hook on a matched route
        // sees the route's own path params.
        ctx.pathParams = matched.params;

        const beforeRenderResult = await this.runBeforeRenderHooks(ctx, resolver, onContextReplaced);
        if(beforeRenderResult instanceof LambderResponse) return beforeRenderResult;

        return await matched.action.actionFn(beforeRenderResult, resolver);
    }

    async render(
        event: LambderHttpEvent,
        lambdaContext: Context
    ): Promise<LambderHttpResponse> {
        let ctx: LambderRenderContext | null = null;
        let started = false;
        // Settled as soon as the context exists and reused by every answer,
        // the crash path's included; see allowedCorsOriginOf.
        let allowedOrigin: string | null = null;

        try {
            await this.ensureInitialized();
            started = true;
            ctx = bindContextTools(createContext(event, lambdaContext, {
                apiPath: this.apiPath,
                trustedClientIpHeaders: this.trustedClientIpHeaders,
                trustedHostHeaders: this.trustedHostHeaders,
            }), this.contextTools);
            if(this.corsConfig) allowedOrigin = allowedCorsOriginOf(this.corsConfig, ctx);
            const resolver = this.getResolver(ctx);

            let response: LambderResponse;
            try {
                // A context a beforeRender hook hands back is the request's
                // from then on, here as in the handler: the afterRender hooks,
                // a thrown answer and a crash's report, reveal and global
                // error handler all read what the hook added, and the session
                // a session route or API read onto it.
                response = await this.resolveRequest(ctx, resolver, (replacement) => { ctx = replacement; });
            } catch(err){
                response = await this.answerThrown(err, ctx, resolver);
            }

            // Everything from here writes into the response, and the object a
            // handler answered with may be one it keeps between requests.
            response = response.copy();

            // What the call wrote goes on before the hooks run, so an
            // afterRender hook can override or delete a header the handler
            // wrote. Applied afterwards, it would put the handler's value
            // straight back over the hook's.
            const responseIntoHooks = response;
            const headersAppliedIntoHooks = ctx.responseHeaders.size;
            ctx.responseHeaders.applyTo(response);

            try {
                for(const hook of this.hookList["afterRender"]){
                    const hookResponse = await hook.hookFn(ctx, resolver, response);
                    if(hookResponse instanceof Error) throw hookResponse;
                    // A response a hook answers with may be one it keeps
                    // between requests, like a handler's, and the hooks after
                    // it write into it: copied for the same reason.
                    if(hookResponse !== response) response = hookResponse.copy();
                }
            } catch(err){
                response = (await this.answerThrown(err, ctx, resolver)).copy();
            }

            // Only what the hooks themselves wrote (res.setHeader inside a
            // hook) is left to apply, which leaves their overrides standing.
            // A hook that answered with a different response takes the whole
            // set instead: headers belong to the call, not to the response
            // that first carried them, so the call's session cookie must
            // reach it.
            ctx.responseHeaders.applyTo(response, response === responseIntoHooks ? headersAppliedIntoHooks : 0);

            this.applyCors(allowedOrigin, response, this.isCorsPreflight(ctx));

            return await finalizeResponse(ctx, response, this.finalizeOptions, ctx.eventFormat);
        }catch(err){
            return await this.answerCrash(err, ctx, allowedOrigin, started, event, lambdaContext);
        }
    }

    /**
     * A thrown value that is an answer rather than a crash, as the response;
     * anything else is rethrown to the crash path.
     *
     * - A LambderResponse IS the response (res.die.*, throw res.html(...)).
     * - A LambderApiRefusal on an API call is its structured refusal
     *   (brand-checked, not instanceof, to survive duplicate installs).
     * - A LambderSessionNotFoundError is a missing session: one that ended
     *   while the request held it (a logout or a password change landing
     *   mid-request), or one a route or hook asked for that the request
     *   never had or whose cookies named several (its subclass
     *   LambderSessionAmbiguousError). It is answered the way a missing
     *   session is answered here, the decision the API pipeline makes for a
     *   handler, applied to the routes and hooks it never sees.
     */
    private async answerThrown(thrown: unknown, ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse> {
        if(thrown instanceof LambderResponse) return thrown;
        if(isLambderApiRefusal(thrown) && ctx.api) return this.apiErrorResponse(thrown, ctx);
        if(thrown instanceof LambderSessionNotFoundError) return await this.sessionMissingResponse(ctx, resolver);
        throw thrown;
    }

    /**
     * A crash, from the thrown value to the answer. It is told to the test
     * watch and reported before anything answers, so the report depends on
     * nothing the answer might break; then the app's global error handler
     * answers it, or the framework's own 500 does when there is none or it
     * failed too.
     */
    private async answerCrash(
        thrown: unknown,
        ctx: LambderRenderContext | null,
        allowedOrigin: string | null,
        started: boolean,
        event: LambderHttpEvent,
        lambdaContext: Context,
    ): Promise<LambderHttpResponse> {
        // Describing the thrown value can itself throw (a null-prototype
        // object, a Proxy, a throwing toString/Symbol.toPrimitive). Unguarded,
        // the crash path would throw too, no handler would run, and the
        // invocation would reject with a 502 no client can parse.
        const error = coerceToError(thrown, "an unstringifiable thrown value");
        this.crashWatcher?.(error);
        const site: LambderCrashSite = !started ? { kind: "startup", lambdaContext }
            : ctx?.api ? { kind: "api", ctx, lambdaContext }
            : { kind: "route", ctx, lambdaContext };
        await this.crashHandling.report(error, site);
        // ctx may be null (createContext failed): derive the format from the raw event.
        const eventFormat = ctx?.eventFormat ?? (isV2HttpEvent(event) ? "v2" : "v1");
        let errorHandlerCrash: Error | null = null;
        try {
            if(this.globalErrorHandler){
                const errorResponse = await this.globalErrorHandler(error, ctx, this.getResponseBuilder(ctx ?? undefined));
                return await finalizeResponse(ctx, this.withCallHeaders(ctx, allowedOrigin, errorResponse), this.finalizeOptions, eventFormat);
            }
        } catch(handlerErr){
            if(handlerErr instanceof LambderResponse){
                try { return await finalizeResponse(ctx, this.withCallHeaders(ctx, allowedOrigin, handlerErr), this.finalizeOptions, eventFormat); } catch { /* fall through */ }
            } else {
                // A second crash, in the code meant to answer the first:
                // reported in its own right, with the thrown value as its
                // cause, so neither of the two disappears.
                errorHandlerCrash = new Error("Lambder: the global error handler threw while answering a crash.", {
                    cause: coerceToError(handlerErr, "an unstringifiable thrown value"),
                });
                await this.crashHandling.report(errorHandlerCrash, site);
            }
        }
        // Emitted directly rather than finalized, because finalization may be
        // what failed; applying the call's headers is plain object work, none
        // of the compression, base64 or size handling finalization does.
        const crashResponse = this.withCallHeaders(ctx, allowedOrigin, await this.crashHandling.frameworkResponse(error, ctx, errorHandlerCrash));
        return emitResponse(
            eventFormat,
            crashResponse.statusCode,
            crashResponse.headers,
            typeof crashResponse.body === "string" ? crashResponse.body : "",
            false,
        );
    }

    /**
     * An answer to a crash, carrying what the call wrote and its CORS headers.
     * As on the success path, headers belong to the call: a call that wrote a
     * session cookie and then threw still owes the browser that cookie, and a
     * cross-origin caller cannot read the error at all without CORS headers.
     * The CORS verdict is the one the request settled before it crashed, so
     * answering a crash runs none of the app's code.
     */
    private withCallHeaders(ctx: LambderRenderContext | null, allowedOrigin: string | null, answer: LambderResponse): LambderResponse {
        // A copy, as on the success path: an error handler may answer with an object it keeps.
        const response = answer.copy();
        if(!ctx) return response;
        ctx.responseHeaders.applyTo(response);
        this.applyCors(allowedOrigin, response, false);
        return response;
    }

    /**
     * Fetch the session for a session route or short-circuit it with the
     * answer for a missing session. Session APIs never come through here:
     * the pipeline answers them with the protocol's { sessionExpired: true }
     * envelope itself.
     */
    private async requireSession(ctx: LambderRenderContext, resolver: LambderResolver): Promise<void> {
        const session = await this.getSessionController(ctx).fetchSessionIfExists();
        if(!session) throw await this.sessionMissingResponse(ctx, resolver);
    }

    /**
     * The answer to a request that needed a session and has none, whether it
     * never had one or it ended while the request held it: an API call gets
     * the protocol's sessionExpired envelope, as the pipeline gives a session
     * API, and anything else the setSessionExpiredRouteHandler answer, a 401
     * by default.
     */
    private async sessionMissingResponse(ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse> {
        if(ctx.api) return responseFromAnswer(sessionExpiredAnswer(this.apiVersion, ctx.logList));
        if(!this.sessionExpiredRouteHandler) return resolver.status(401, "Session required.");
        try {
            return await this.sessionExpiredRouteHandler(ctx, resolver);
        } catch(err){
            // It may answer by throwing, as any handler may.
            if(err instanceof LambderResponse) return err;
            throw err;
        }
    }

    /**
     * Dispatch a non-HTTP Lambda event to the registered actions. What an
     * action throws is reported (crashes.report) and then rethrown untouched,
     * so Lambda's retries and dead-letter queues still see the failure.
     */
    async renderEvent(event: unknown, lambdaContext: Context): Promise<unknown> {
        let started = false;
        try {
            await this.ensureInitialized();
            started = true;
            for(const action of this.eventActionList){
                if(action.match(event)){
                    return await action.actionFn(event, lambdaContext);
                }
            }
            const summary = event && typeof event === "object"
                ? ` (source: ${String((event as Record<string, unknown>).source ?? "?")}, detail-type: ${String((event as Record<string, unknown>)["detail-type"] ?? "?")})`
                : "";
            throw new Error(`Lambder: no action matched non-HTTP event${summary}. Register one with addAction(); a trailing addAction(() => true, ...) acts as a fallback.`);
        } catch(err){
            await this.crashHandling.report(
                coerceToError(err, "an unstringifiable thrown value"),
                started ? { kind: "event", event, lambdaContext } : { kind: "startup", lambdaContext },
            );
            throw err;
        }
    }

    // =====================================================================
    // The API path
    // The steps only an API call takes, around the shared core.
    // =====================================================================
    /**
     * The answer for a rejected input: the app's
     * setApiInputValidationErrorHandler when set, otherwise the standard 422
     * body. The API's own schema and every preflight slice (guard inputs,
     * rate-limit keys) answer through here, so one failure has one shape.
     */
    private async inputValidationRefusal(ctx: LambderRenderContext, zodError: z.ZodError): Promise<LambderApiAnswer | null> {
        if(this.apiInputValidationErrorHandler){
            return answerFromResponse(await this.apiInputValidationErrorHandler(ctx, this.getResolver(ctx), zodError));
        }
        // null asks the pipeline for the standard 422, so that answer is
        // written once, in the core, rather than here as well.
        return null;
    }

    /**
     * One API call through the core: the pipeline runs the protocol steps and
     * calls back for the handler, whose LambderResponse (returned, or thrown
     * via res.die.*) becomes the answer the pipeline stores and hands back.
     * The context is the pipeline's context, so a session it fetched is on
     * ctx.session and the validated payload is on ctx.apiPayload when the
     * handler runs. The handler's resolver knows the API's output schema, so
     * every success payload is parsed through it before it is sent.
     */
    private async runApi(
        ctx: LambderRenderContext,
        definition: LambderApiDefinition,
        handler: (ctx: never, resolver: LambderResolver) => MaybePromise<LambderResponse>,
    ): Promise<LambderResponse> {
        const request = ctx.api;
        if(!request) throw new Error(`Lambder: API "${definition.name}" was matched by a request that is not an API call.`);
        const resolver = new LambderResolver({ files: this.files, apiVersion: this.apiVersion, ctx, apiOutput: definition.output });
        // What the handler produced, in both forms: the answer went to the
        // pipeline, and the response is kept so it can carry on unchanged.
        const handled: { output: { response: LambderResponse; answer: LambderApiAnswer } | null } = { output: null };
        const { answer } = await this.pipeline.run(request, ctx, definition, async () => {
            ctx.apiPayload = request.payload;
            let response: LambderResponse;
            try {
                response = await handler(ctx as never, resolver);
            } catch(err){
                // A thrown LambderResponse IS the response (res.die.*): an
                // answer like a returned one, stored and replayed alike.
                if(err instanceof LambderResponse) response = err;
                else throw err;
            }
            handled.output = { response, answer: answerFromResponse(response) };
            return handled.output.answer;
        });
        // When the pipeline answered with the handler's own answer, its
        // response carries on rather than a rebuild. An answer holds a Buffer
        // body base64-encoded (the plain shape the idempotency store
        // persists), and a response rebuilt from it would hand finalization a
        // base64 string it must pass through uncompressed. Identity decides,
        // since the pipeline may have answered with a stored replay or a
        // refusal instead.
        if(handled.output?.answer === answer) return handled.output.response;
        return responseFromAnswer(answer);
    }

    /** A thrown LambderApiRefusal (from a hook, say) as the structured API envelope: the core's one mapping. */
    private apiErrorResponse(err: LambderApiRefusal, ctx: LambderRenderContext): LambderResponse {
        return responseFromAnswer(refusalAnswer(err, this.apiVersion, ctx.logList));
    }
}

/**
 * The canonical way to create an instance: fix the session data type first,
 * then create with the full configuration in one declaration. The policy,
 * guard and idempotency types are inferred from the options, so the instance
 * is born fully typed and `typeof lambderApp` is the annotation type for api
 * modules. There are no ordering rules, and nothing can be half-configured.
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
 * Curried because TypeScript type arguments are all-or-nothing per call:
 * passing the session data type to `new Lambder<S>(...)` would silently
 * widen the inferred policy and guard types to their {} defaults. Fixing the
 * session type in the first call lets the second infer everything else.
 * `new Lambder(options)` serves untyped or session-data-free instances.
 */
export const initLambder = <TSessionData = any>() => ({
    ...policyBuildersFor<TSessionData>(),
    create<const TOptions extends LambderCreateOptions<TSessionData>>(
        options: LambderNoExtraKeys<TOptions, LambderCreateOptions<TSessionData>> & LambderNestedOptionChecks<TSessionData, TOptions>,
    ): Lambder<
        TSessionData,
        {},
        TOptions["rateLimits"] extends { policies: infer TPolicies extends Record<string, LambderApiRateLimitPolicyConfig> } ? TPolicies : {},
        TOptions["guards"] extends Record<string, LambderApiGuard<any, any, any>> ? LambderGuardMetaMap<TOptions["guards"]> : {},
        TOptions["idempotency"] extends LambderApiIdempotencyConfig ? true : false,
        // Read as "off unless it says otherwise" rather than "on only when it
        // says true", so a widened boolean (a spread of a separately typed
        // options object, or one built in a helper) keeps the requirement
        // instead of quietly losing its compile-time half.
        [LambderGivenOption<TOptions, "requireSessionApiGuards">] extends [false | undefined] ? false : true,
        [LambderGivenOption<TOptions, "requirePublicApiGuards">] extends [false | undefined] ? false : true,
        [LambderGivenOption<TOptions, "session">] extends [undefined] ? false : true
    > {
        return new Lambder(options) as never;
    },
});

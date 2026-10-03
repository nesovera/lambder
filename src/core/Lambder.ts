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
import { compileRouteMatcher, routeNameOf, type CompiledMatcher, type LambderRouteCondition, type LambderRouteConditionFn, type LambderRouteMatcher, type LambderPathParamsOf, type LambderRoutePath } from "./LambderRouting.js";
import type { LambderCallOutcomeHint } from "../shared/wire/LambderCallOutcome.js";
import { allowedCorsOriginOf, applyCorsHeaders, type LambderCorsConfig } from "./LambderCors.js";
import LambderSessionManager, { type LambderSessionDataOptions } from "../session/LambderSessionManager.js";
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
import {
    declaredRefusalVocabulary,
    readRefusalVocabulary,
    resolveAllowedRefusals,
    toRefusalCodes,
    type LambderEndpointRefusals,
    type LambderWireRefusalsOf,
    type LambderHandlerRefusalsOf,
    type LambderRefusalDeclaration,
    type LambderRefusalNamesIn,
    type LambderRefusalsOption,
    type LambderRefusalVocabulary,
    type LambderRefusalVocabularyOption,
    type LambderRefusalVocabularyOptionChecks,
    type LambderMergedRefusalVocabulary,
    type LambderDeclaredVocabulary,
} from "../api/LambderApiRefusals.js";
import { refuse, type LambderDeclaredRefuse } from "../shared/wire/LambderApiRefusal.js";
import { apiSignatureOf, type LambderApiSignatureEntry } from "../api/LambderApiSignature.js";
import { apiNameKeyOf, type LambderApiSignatureMap } from "../shared/wire/LambderApiSignatureMap.js";
import type { LambderApiOptionEntries, LambderApiOptionEntry, LambderGuardDeclarationEntry, LambderRateLimitPolicyEntry } from "../shared/wire/LambderApiOptionEntries.js";
import { assertPlainData } from "../shared/util/assertPlainData.js";
import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type {
    LambderApiIdempotencyOption,
    LambderRefusalsOptionValue,
} from "../shared/wire/LambderApiOptionValues.js";
import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import {
    apiNotFoundAnswer,
    envelopeAnswer,
    sessionExpiredAnswer,
    successEnvelope,
    versionExpiredAnswer,
} from "../api/LambderApiEnvelope.js";
import { describePayloadKind, isObjectPayload } from "../shared/wire/LambderObjectPayload.js";
import { LambderApiOutputValidationError } from "../api/LambderApiOutputValidationError.js";
import type {
    LambderApiGuard,
    LambderGuardMetaMap,
    LambderGuardsOption,
    LambderGuardDataOf,
    LambderGuardInputsOf,
    LambderGuardRefusalNamesOf,
} from "../api/LambderApiGuards.js";
import { toGuardEntries } from "../api/LambderApiGuards.js";
import type {
    LambderApiRateLimitPolicyConfig,
    LambderRateLimitOption,
} from "../api/LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "../api/LambderApiIdempotency.js";
import type { LambderContractEntry, LambderJsonOf } from "../shared/wire/LambderApiContract.js";
import {
    buildApiGroup,
    buildLazyApiGroup,
    isRegistrableApiGroup,
    type LambderActionNamesCheck,
    type LambderApiDeclaration,
    type LambderApiDeclarationOptions,
    type LambderApiDeclarations,
    type LambderApiGroup,
    type LambderApiModeOf,
    type LambderAppTypes,
    type LambderContractOfGroups,
    type LambderGroupNameCheck,
    type LambderGroupPartsCheck,
    type LambderMergedParts,
    type LambderLazyApiGroup,
    type LambderPlainAppTypes,
    type LambderPublicSessionPolicyCheck,
    type LambderRegisteredGroupsCheck,
    type LambderRegistrableApiGroup,
    type LambderSessionModeCheck,
} from "../api/LambderApiDeclarations.js";
import { splitApiName } from "../shared/wire/LambderApiNames.js";
import {
    bindContextTools,
    createContext,
    isV2HttpEvent,
    type LambderContextOptions,
    type LambderContextTools,
    type LambderHttpEvent,
    type LambderOriginProof,
    type LambderRenderContext,
    type LambderSessionRenderContext,
} from "./LambderContext.js";
import { COMPRESSED_PAYLOAD_GZ_FIELD, COMPRESSED_PAYLOAD_BR_FIELD, COMPRESSED_PAYLOAD_BYTES_FIELD } from "../shared/wire/LambderRequestPayload.js";
import type { LambderReadonlyDeep, MaybePromise } from "../shared/util/LambderTypeUtilities.js";
import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import { LambderCrashHandling } from "./LambderCrashHandling.js";
import { currentInvocation, runInvocation, type LambderInvocationRecord } from "./LambderInvocationScope.js";
import { roundedMilliseconds, writeCallSummaryLine, type LambderCallSummary } from "./LambderCallSummary.js";
import { outcomeOfAnswerText } from "../shared/wire/LambderCallOutcome.js";
import { LAMBDER_INVOKE_API_ID, LAMBDER_PARENT_REQUEST_HEADER } from "../shared/wire/LambderInvokeApiId.js";
import { policyBuildersFor } from "./LambderPolicyBuilders.js";
import {
    assertCreateOptions,
    mergeNamedMaps,
    type LambderGuardsMap,
    type LambderMergedCreateOptions,
    type LambderMergedNamedMaps,
    type LambderNamedMapsOption,
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
    type LambderObjectOutputCheck,
    type LambderPayloadSliceCheck,
    type LambderRequirableGuardsField,
    type LambderSessionEnabledInstance,
    type LambderSessionRouteHandler,
    type LambderActionHandler,
    type LambderCrashSite,
} from "./LambderCreateOptions.js";

/** Everything `lambder/testing` may put under a built instance: the pipeline's stores, and the source its files are read from. */
export type LambderInstanceBackends = LambderPipelineBackends & {
    fileSource?: LambderFileSource;
    /** Where call summaries go instead of the app's own callSummary; null writes none. */
    callSummary?: ((summary: LambderCallSummary) => void) | null;
};
/** What the instance had a place for; see LambderPipelineBackendSwap. `files` is false on an instance created without the files option. */
export type LambderInstanceBackendSwap = LambderPipelineBackendSwap & { files: boolean };

/**
 * The "created" hook: run once the instance exists, with the instance. It is
 * declared here rather than beside the other hooks in LambderCreateOptions
 * because its parameter is the class, and an options module that names the
 * class cannot be read without it.
 */
export type LambderCreatedHook = (lambderInstance: Lambder<any, any>) => void | Promise<void>;

/** The codes one API may refuse with, typed: its own refusals option's and its declared guards', as the vocabulary holds them. */
type LambderApiRefusalCodes<TVocabulary, TGuards, TRefusalsOpt, TGuardsOpt> =
    (LambderRefusalNamesIn<TRefusalsOpt> | LambderGuardRefusalNamesOf<TGuards, TGuardsOpt>) & keyof TVocabulary & string;

/**
 * What an endpoint's handler is handed: the session context when one of its
 * guards needs a session (so ctx.session is typed present), the plain one
 * otherwise, with the payload, the guards' data and a refuse() typed to the
 * codes the endpoint may refuse with.
 */
type LambderApiHandlerContext<TApp extends LambderAppTypes, TPayload, TGuardsOpt, TRefusalsOpt> =
    (LambderApiModeOf<TApp["guards"], TGuardsOpt> extends "session"
        ? LambderSessionRenderContext<TPayload, TApp["session"], Record<string, string>, LambderGuardDataOf<TApp["guards"], TGuardsOpt>, TApp["policies"]>
        : LambderRenderContext<TPayload, Record<string, string>, LambderGuardDataOf<TApp["guards"], TGuardsOpt>, TApp["session"], TApp["policies"]>)
    & { refuse: LambderDeclaredRefuse<LambderHandlerRefusalsOf<TApp["refusals"], LambderApiRefusalCodes<TApp["refusals"], TApp["guards"], TRefusalsOpt, TGuardsOpt>>, TApp["refusalCodesRequired"]> };

/** One endpoint checked for registration, and not yet recorded (see Lambder.prepareApi and commitApi). */
type LambderPreparedApi = {
    definition: LambderApiDefinition;
    refusalsOption: LambderRefusalsOptionValue | undefined;
    output: z.ZodType;
    compress: boolean | "auto";
    handler: (ctx: never) => MaybePromise<unknown>;
};

/** The refusals of a name no API is registered under: no code, and none required. */
const NO_DECLARED_REFUSALS: LambderEndpointRefusals = { codes: new Map(), codeRequired: false };

/** Longest endpoint name a call summary carries: a page built before paths posts the name in its body, and a line is no place for a long one. */
const MAX_SUMMARY_NAME_CHARS = 200;

/** A request id as the parent header may carry one: what Lambda's own ids look like, and no longer than any of them. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/**
 * The request id of the invocation that invoked this one, from an invoke's
 * event alone: over HTTP the header is whatever a client wrote, and an
 * invoke's apiId is one no gateway lets a client set.
 */
const parentRequestIdOf = (event: LambderHttpEvent): string | null => {
    if(event.requestContext?.apiId !== LAMBDER_INVOKE_API_ID) return null;
    const value = Object.entries(event.headers ?? {}).find(([name]) => name.toLowerCase() === LAMBDER_PARENT_REQUEST_HEADER)?.[1];
    return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : null;
};

/** The API call a request is, as its invocation records it; null for a request that is no API call. */
const apiCallOf = (ctx: LambderRenderContext, event: LambderHttpEvent): LambderInvocationRecord["call"] =>
    ctx.api ? { api: ctx.api.apiName, route: null, parentRequestId: parentRequestIdOf(event) } : null;

/** The call a request a route answered is: the route by its registered name, never by the path asked for. */
const routeCallOf = (ctx: LambderRenderContext, route: string | null): LambderInvocationRecord["call"] =>
    ({ api: null, route, parentRequestId: parentRequestIdOf(ctx.event) });

/** A route's outcome, which no envelope names: read from the status it answered with, as an API call's 5xx reads. */
const outcomeOfStatus = (status: number): LambderCallOutcomeHint =>
    ({ outcome: status >= 500 ? "crash" : status >= 400 ? "other" : "success", code: null });

// The two shapes the class keeps for its own handler lists: a compiled route
// matcher beside the action it dispatches to, with what its summary line
// names the route by (null for the API's own action, whose calls are named
// by their endpoint, and for a route with no name), and the non-HTTP twin.
type ActionObject = { match: CompiledMatcher, name: string | null, actionFn: LambderRouteHandler };
type EventActionObject = { match: (event: unknown) => boolean, actionFn: (event: unknown, lambdaContext: Context) => MaybePromise<unknown> };

/**
 * Main Lambder class for building type-safe serverless APIs. Create
 * instances with initLambder<SessionData>().create({...}) (see below): the
 * whole configuration, including the typed policy layer, is given at
 * construction. Endpoints are declared as values on the instance
 * (defineApi, defineApiGroup) and registered in one registerApiGroups()
 * call; routes, hooks and actions chain.
 *
 * @typeParam TApp - @internal What create() configured, as LambderAppTypes: the session data, policies, guards, idempotency, the guard requirement, sessions and the refusal vocabulary (do not pass manually)
 * @typeParam _TContract - @internal The contract of the groups registered so far (do not pass manually)
 *
 * @example
 * ```typescript
 * interface SessionData { userId: string; role: string; }
 *
 * const app = initLambder<SessionData>().create({ apiPath: '/api', session, guards });
 * const userApis = app.defineApiGroup("users", {
 *     get: app.defineApi({ input: z.object({...}), output: z.object({...}), guards: "signedIn" }, handler),
 * });
 * const lambder = app.registerApiGroups(userApis);
 * ```
 */
export default class Lambder<
    TApp extends LambderAppTypes = LambderPlainAppTypes,
    _TContract extends Record<string, any> = {},
> {
    // =====================================================================
    // Construction
    // Everything an instance is, fixed before the first registration.
    // =====================================================================
    // Fixed at construction, because what was built from them keeps its own
    // copy: the pipeline and the crash handling stamp the apiVersion they
    // were given, servePublicFiles serves through the reader it was given,
    // and the callers of an instance post to the apiPath they were built
    // with. A later write would leave the instance disagreeing with itself.
    /** Where API calls go: `{apiPath}/{group}/{action}`. */
    public readonly apiPath: string;
    /** Stamped on every API answer's envelope as apiVersion. Informational: a client's staleness is judged per endpoint by its signature, see apiSignatures(). */
    public readonly apiVersion: null | string;
    /** The instance's file reader (source + caches), or null without the files option. */
    public readonly files: LambderFiles | null;

    /**
     * Type property for extracting the API contract: every registered API's
     * input, output, mode and declared options, as a client calls it.
     *
     * A small app's client imports it as it is. A large app's client reads
     * the plain types writeApiContract (lambder/build) prints from this
     * property instead, which cost it nothing to resolve.
     *
     * @example
     * ```typescript
     * export const lambder = lambderApp.registerApiGroups(userApis, orderApis);
     * export type ApiContractType = typeof lambder.ApiContract;
     * ```
     */
    public readonly ApiContract!: _TContract;

    /**
     * Type property for what create() configured (LambderAppTypes): the
     * session data, policies, guards and the rest, for code that takes any
     * instance and needs one of them (lambderTestApp reads the session data
     * type here). Like ApiContract, it has no value.
     */
    public readonly AppTypes!: TApp;

    private actionList: ActionObject[] = [];
    /** The API core: the pipeline every API call runs through, shared in shape with the mock runtime. */
    private readonly pipeline: LambderApiPipeline<LambderRenderContext, TApp["session"]>;
    /** Every registered API by name: what dispatch, apiSignatures() and apiOptionEntries() read. */
    private readonly apiDefinitions = new Map<string, LambderApiDefinition>();
    /** What answers each registered API: its output schema, compression setting and handler. */
    private readonly apiHandlers = new Map<string, { output: z.ZodType; compress: boolean | "auto"; handler: (ctx: never) => MaybePromise<unknown> }>();
    /** Every group name registered, lazy or not: the duplicate-group check. */
    private readonly apiGroupNames = new Set<string>();
    /** The lazy groups not loaded yet, each with its load in progress, if one is. */
    private readonly lazyApiGroups = new Map<string, { group: LambderLazyApiGroup; loading: Promise<void> | null }>();
    /** The guards given at creation, merged into one map, kept for apiSignatures(): a guard's schema is part of the signature of every endpoint declaring it. */
    private readonly guards: LambderGuardsMap<TApp["session"]> | undefined;
    /** The rate-limit policies given at creation, kept for apiOptionEntries(), which records each one less its key handler. */
    private readonly rateLimitPolicies: Record<string, LambderApiRateLimitPolicyConfig> | undefined;
    /** The refusal vocabulary given at creation: what each API's and each guard's refusal codes resolve against. Null without the option. */
    private readonly refusalVocabulary: ReadonlyMap<string, LambderRefusalDeclaration> | null;
    /** Every API's refusals option as written, for apiOptionEntries(); its definition holds the resolved set. */
    private readonly refusalOptions = new Map<string, LambderRefusalsOptionValue>();
    private hookList: {
        "created": { priority: number, hookFn: LambderCreatedHook }[],
        "beforeRender": { priority: number, hookFn: LambderBeforeRenderHook }[],
        "afterRender": { priority: number, hookFn: LambderAfterRenderHook }[],
        "fallback": { priority: number, hookFn: LambderFallbackHook }[],
    } = { "created": [], "beforeRender": [], "afterRender": [], "fallback": [] };
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
    /** Whether every endpoint has to declare guards (create()'s requireApiGuards). */
    private readonly requireApiGuards: boolean;
    /** Whether every refusal an API answers with has to name a code (declareRefusals's requireCodes). */
    private readonly requireRefusalCodes: boolean;
    /** Told what a request threw, beside whatever answers it; null outside a test. See LAMBDER_CRASH_WATCH. */
    private crashWatcher: ((error: Error) => void) | null = null;
    /** The crashes option applied: reporting, and the framework's own 500. */
    private readonly crashHandling: LambderCrashHandling;
    /** What this instance binds onto every context it renders (ctx.sessionController, ctx.rateLimit, ctx.isRateLimited). */
    private readonly contextTools: LambderContextTools;
    private readonly trustedClientIpHeaders: readonly string[];
    private readonly trustedHostHeaders: readonly string[];
    private readonly originProof: LambderOriginProof | null;
    /** Where each call's summary goes, an API call's or a route's (the callSummary option); null writes none. Replaceable through the backend swap alone. */
    private callSummaryWriter: ((summary: LambderCallSummary) => void) | null;

    constructor(given: LambderCreateOptions<TApp["session"]> = {}){
        // The guards and the rate-limit policies as one map each, whether
        // they were given as one or as a list; a name two maps declare
        // throws here.
        const options: LambderMergedCreateOptions<TApp["session"]> = {
            ...given,
            guards: given.guards && mergeNamedMaps(given.guards, "guard"),
            rateLimits: given.rateLimits && { ...given.rateLimits, policies: mergeNamedMaps(given.rateLimits.policies, "rate-limit policy") },
        };
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
        this.rateLimitPolicies = options.rateLimits?.policies;
        this.refusalVocabulary = readRefusalVocabulary(options.refusals);
        this.pipeline = new LambderApiPipeline<LambderRenderContext, TApp["session"]>({
            apiVersion: this.apiVersion,
            minApiVersion: options.minApiVersion,
            apiSignatures: options.apiSignatures,
            maxRequestPayloadBytes: options.maxRequestPayloadBytes,
            // The app's own validation handler is read at call time, since
            // setApiInputValidationErrorHandler runs after creation.
            onInvalidInput: (zodError, ctx) => this.inputValidationRefusal(ctx, zodError),
            sessions: session
                ? {
                    manager: new LambderSessionManager<TApp["session"]>({
                        store: session.store,
                        sessionSalt: session.sessionSalt,
                        enableSlidingExpiration: session.enableSlidingExpiration,
                        slidingWriteIntervalSeconds: session.slidingWriteIntervalSeconds,
                        // As given: the manager refuses dataRefresh without
                        // the schema, which an untyped caller can still pass.
                        ...{ dataRefresh: session.dataRefresh, dataSchema: session.dataSchema } as LambderSessionDataOptions<TApp["session"]>,
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
            atRestSecret: session?.sessionSalt,
        });

        this.trustedClientIpHeaders = options.trustedClientIpHeaders ?? [];
        this.trustedHostHeaders = options.trustedHostHeaders ?? [];
        this.originProof = options.originProof ?? null;
        this.callSummaryWriter = options.callSummary === false ? null : options.callSummary ?? writeCallSummaryLine;
        this.requireApiGuards = options.requireApiGuards ?? false;
        this.requireRefusalCodes = options.requireRefusalCodes ?? false;
        this.crashHandling = new LambderCrashHandling(options.crashes ?? {}, this.apiVersion);
        this.contextTools = {
            sessionControllerFor: (ctx) => this.getSessionController(ctx),
            chargeRateLimit: async (ctx, policy, key, refuse) => {
                // A per-API budget counts per registered API. The posted name
                // of a call no API matched (a hook or the fallback charging
                // it) is the caller's choice, and a fresh name per request
                // would be a fresh counter.
                const apiName = ctx.api && await this.registeredDefinitionOf(ctx.api.apiName) ? ctx.api.apiName : null;
                const { checkResult, refusal: refusalToThrow } = await this.pipeline.chargeRateLimit(policy, {
                    apiName,
                    ip: ctx.ip,
                    session: ctx.session,
                    key,
                });
                if(refuse && refusalToThrow){
                    if(ctx.api) throw refusalToThrow;
                    // A route has no envelope to carry a refusal, so it
                    // answers the same 429 as text, with the same Retry-After
                    // and the policy's own words.
                    throw this.getResolver(ctx).text(refusalToThrow.refusal.content, { statusCode: 429, headers: refusalToThrow.headers });
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
        actionFn: (ctx: LambderRenderContext<any, LambderPathParamsOf<TPath>, {}, TApp["session"], TApp["policies"]>, resolver: LambderResolver) => MaybePromise<LambderResponse>,
    ): this;
    addRoute(condition: RegExp | LambderRouteConditionFn | LambderRouteMatcher, actionFn: LambderRouteHandler): this;
    addRoute(condition: LambderRouteCondition, actionFn: (ctx: any, resolver: LambderResolver) => MaybePromise<LambderResponse>): this {
        this.actionList.push({
            match: compileRouteMatcher(condition),
            name: routeNameOf(condition),
            actionFn: (ctx, resolver) => actionFn(ctx, resolver),
        });
        return this;
    }

    addSessionRoute<TPath extends LambderRoutePath>(
        condition: TPath,
        actionFn: ((ctx: LambderSessionRenderContext<any, TApp["session"], LambderPathParamsOf<TPath>, {}, TApp["policies"]>, resolver: LambderResolver) => MaybePromise<LambderResponse>) & LambderSessionEnabledInstance<TApp["sessions"]>,
    ): this;
    addSessionRoute(condition: RegExp | LambderRouteConditionFn | LambderRouteMatcher, actionFn: LambderSessionRouteHandler<TApp["session"]> & LambderSessionEnabledInstance<TApp["sessions"]>): this;
    addSessionRoute(condition: LambderRouteCondition, actionFn: (ctx: any, resolver: LambderResolver) => MaybePromise<LambderResponse>): this {
        this.actionList.push({
            match: compileRouteMatcher(condition),
            name: routeNameOf(condition),
            actionFn: async (ctx, resolver) => {
                await this.requireSession(ctx, resolver);
                // requireSession answered already if there was no session, so
                // the only narrowing left is null to non-null.
                return await actionFn(ctx as LambderSessionRenderContext<any, TApp["session"]>, resolver);
            },
        });
        return this;
    }

    // =====================================================================
    // Endpoints
    // Declared as values, gathered into named groups, registered in one call.
    // =====================================================================
    /**
     * Declares one endpoint, typed on this instance's types: its input and
     * output schemas, its guards, rate limits, idempotency and refusals, and
     * its handler. Nothing is registered until the declaration is put in a
     * group (defineApiGroup) and the group is registered (registerApiGroups).
     *
     * The guards say who may call it, and so its mode: an endpoint whose
     * guards include one that needs a session (`session: true`) is a session
     * endpoint, its session read before the guards run and a call without
     * one answered sessionExpired, and its handler's ctx.session is typed
     * present. Any other endpoint is public.
     *
     * An arrow property rather than a method, so an app can hand it out
     * detached: `export const { defineApi, defineApiGroup } = lambderApp;`.
     */
    public readonly defineApi = <
        TInput extends z.ZodType,
        TOutput extends z.ZodType,
        const TAnswer extends LambderReadonlyDeep<z.input<TOutput>>,
        const TRateOpt extends LambderRateLimitOption<TApp["policies"]> = never,
        const TGuardsOpt extends LambderGuardsOption<TApp["guards"]> = never,
        const TIdempotencyOpt extends LambderApiIdempotencyOption = never,
        const TRefusalsOpt extends LambderRefusalsOption<TApp["refusals"]> = never,
    >(
        options: { input: TInput, output: TOutput } & {
            /** Named rate limits, checked in declared order within their phase (per ip before the session read, per session before the guards, a custom key after the guards and input validation): a name, a list of names, or a { name: true | override } map (windows overridable on perApi budgets, refusal on any). The first exceeded one refuses (429 envelope + Retry-After); attempts count on every counter checked before it. A per-session policy needs one of the endpoint's guards to need a session. */
            rateLimit?: TRateOpt;
            /** Replay-protect this API per client idempotencyKey. Requires the idempotency option at creation. */
            idempotency?: TApp["idempotency"] extends true ? TIdempotencyOpt : never;
            /**
             * The refusal codes this API may refuse with, from the vocabulary given at creation: one code or a
             * non-empty list. Its guards' codes join them. The handler raises one with `ctx.refuse(content, { code, data })`,
             * its callers narrow on them, and a refusal with any other code is a crash rather than an answer.
             */
            refusals?: TRefusalsOpt;
            /**
             * Whether this API's answers are compressed for a caller that accepts it: "auto" (the default) when the
             * body is large enough to gain, false never, true always. false suits an answer of base64 bytes: once
             * compressed it leaves the function base64-encoded again, so it is no smaller under Lambda's response
             * cap or to a lambda caller, and a browser gets it only about a quarter smaller for the time spent at
             * both ends. A transport setting of this server's, not part of the API's contract.
             */
            compress?: boolean | "auto";
        } & LambderRequirableGuardsField<TApp["guardsRequired"], TGuardsOpt> & LambderObjectOutputCheck<TOutput>
            & LambderPayloadSliceCheck<TApp["guards"], TApp["policies"], TGuardsOpt, TRateOpt, z.input<TInput>>
            & LambderPublicSessionPolicyCheck<LambderApiModeOf<TApp["guards"], TGuardsOpt>, TApp["policies"], TRateOpt>
            & LambderSessionModeCheck<LambderApiModeOf<TApp["guards"], TGuardsOpt>, TApp["sessions"]>,
        /** Answers the call by returning its output (parsed through `output` before it is sent), or refuses it with ctx.refuse() or refuse(). */
        handler: (ctx: LambderApiHandlerContext<TApp, z.infer<TInput>, TGuardsOpt, TRefusalsOpt>) => MaybePromise<TAnswer>,
    ): LambderApiDeclaration<LambderContractEntry<
        z.input<TInput>,
        LambderJsonOf<z.output<TOutput>>,
        LambderApiModeOf<TApp["guards"], TGuardsOpt>,
        LambderGuardInputsOf<TApp["guards"], TGuardsOpt>,
        TGuardsOpt,
        TRateOpt,
        TIdempotencyOpt,
        LambderWireRefusalsOf<TApp["refusals"], LambderApiRefusalCodes<TApp["refusals"], TApp["guards"], TRefusalsOpt, TGuardsOpt>>>> =>
        ({ kind: "lambderApi", options: options as LambderApiDeclarationOptions, handler: handler as never }) as never;

    /**
     * Gathers endpoints into a named group: each is registered as
     * `name.action` and called at `{apiPath}/{name}/{action}`, and every
     * Lambder caller reaches it as `caller.name.action(input)`. A group's
     * name and its actions are identifiers, and a group may not take a name
     * a caller already answers for (see LAMBDER_RESERVED_GROUP_NAMES).
     *
     * A group declared across files takes each file's part:
     * `defineApiGroup("orders", orderReadApis, orderWriteApis)`. An action
     * two parts declare is refused, at compile time and at startup, rather
     * than one silently replacing the other as an object spread would.
     */
    public readonly defineApiGroup = <const TName extends string, const TParts extends readonly [LambderApiDeclarations, ...LambderApiDeclarations[]]>(
        name: TName & LambderGroupNameCheck<TName>,
        ...parts: TParts & LambderGroupPartsCheck<TParts> & { [TIndex in keyof TParts]: LambderActionNamesCheck<TParts[TIndex]> }
    ): LambderApiGroup<TName, LambderMergedParts<TParts>> => buildApiGroup<TName, LambderMergedParts<TParts>>(name as TName, parts as readonly LambderApiDeclarations[]);

    /**
     * A group loaded on the first call to one of its endpoints:
     * `lazyApiGroup("orders", () => import("./orders.js").then((m) => m.orderApis))`.
     * A cold start then parses none of it, nor anything only it imports,
     * until a request calls it; the contract is the loaded group's, read off
     * its type. The group loaded must carry the same name, which the type
     * checks and loading checks again. `loadApiGroups()` loads every group,
     * for a build step or a boot check that has to see them all.
     */
    public readonly lazyApiGroup = <const TName extends string, TGroup extends LambderApiGroup<TName, any>>(
        name: TName & LambderGroupNameCheck<TName>,
        load: () => Promise<TGroup>,
        // NoInfer: the group is read off the loader alone. Written where a
        // type is expected (a `satisfies`, an annotated list), the expected
        // LambderLazyApiGroup<string, any> would otherwise be inferred from
        // first and make the loaded group any.
    ): LambderLazyApiGroup<TName, NoInfer<TGroup>> => buildLazyApiGroup<TName, TGroup>(name as TName, load);

    /**
     * Registers groups of endpoints, as one contract: `typeof
     * lambder.ApiContract` then maps every `group.action` to its entry, one
     * flat object type the api-contract generator prints as it is. Register
     * every group in one call where you can: the contract of one call is one
     * mapped type, and a second call intersects it with the first.
     *
     * The call's groups take their place in the first-match chain here, as
     * a route does: a route or action registered before them sees their calls
     * first, one registered after them never does. The beforeRender hooks run
     * before a lazy group loads, so a hook that answers a request spares it
     * the import; one that throws a refusal or charges a per-API budget loads
     * it (see registeredDefinitionOf).
     *
     * Refused at compile time: a group typed `any`, or a lazy one loading a
     * group typed `any`, or a group whose endpoints are (its endpoints would
     * be `any` to every client), and a group name given twice. Refused at
     * registration, which is at startup for a group and at its first call for
     * a lazy one: everything registration refuses of one endpoint (an unknown
     * guard or policy, a missing guard where requireApiGuards is on, a
     * refusal code outside the vocabulary).
     */
    registerApiGroups<const TGroups extends readonly LambderRegistrableApiGroup[]>(
        // The checks sit on `this` rather than on the groups: an argument
        // typed any satisfies any parameter type, so only the receiver can
        // refuse a call whose group is any.
        this: LambderRegisteredGroupsCheck<TGroups, Lambder<TApp, _TContract>>,
        ...groups: TGroups
    ): Lambder<TApp, _TContract & LambderContractOfGroups<TGroups>> {
        const instance = this as unknown as Lambder<TApp, _TContract>;
        // Every group and every endpoint is checked before anything is
        // claimed, so a registration refused anywhere leaves the instance as
        // it was: no group name taken, no endpoint half registered, and a
        // caller that catches the error and fixes the declaration is told the
        // real problem on its next try.
        const names = new Set<string>();
        const prepared: LambderPreparedApi[] = [];
        for(const group of groups as readonly unknown[]){
            if(!isRegistrableApiGroup(group)){
                throw new Error("Lambder: registerApiGroups takes groups built by defineApiGroup() or lazyApiGroup().");
            }
            if(instance.apiGroupNames.has(group.name) || names.has(group.name)){
                throw new Error(`Lambder: group "${group.name}" is registered twice. A group is one namespace, so its endpoints belong in one defineApiGroup().`);
            }
            names.add(group.name);
            if(group.kind === "lambderApiGroup") prepared.push(...instance.prepareApiGroup(group));
        }
        for(const group of groups as readonly LambderRegistrableApiGroup[]){
            instance.apiGroupNames.add(group.name);
            if(group.kind === "lambderLazyApiGroup") instance.lazyApiGroups.set(group.name, { group, loading: null });
        }
        for(const api of prepared) instance.commitApi(api);
        instance.actionList.push({
            match: (ctx) => {
                const group = ctx.api ? splitApiName(ctx.api.apiName)?.group : undefined;
                return group !== undefined && names.has(group) ? {} : false;
            },
            name: null,
            actionFn: (ctx, resolver) => instance.dispatchApiCall(ctx, resolver),
        });
        return instance as never;
    }

    /**
     * Loads every lazy group not loaded yet, registering its endpoints: what
     * a build step digesting the signatures, a generator writing the options
     * or a boot check has to do before it sees every endpoint. A group whose
     * registration fails rejects here, which is the point of calling it.
     */
    async loadApiGroups(): Promise<void> {
        for(const name of [...this.lazyApiGroups.keys()]) await this.loadLazyApiGroup(name);
    }

    /**
     * An API call to a registered group, its hooks run: its group loaded
     * first when it is a lazy one no call has reached yet, then its endpoint
     * run. An action the group does not have is answered as any unmatched API
     * call is, fallback hooks first.
     */
    private async dispatchApiCall(ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse> {
        const apiName = ctx.api!.apiName;
        const definition = await this.registeredDefinitionOf(apiName);
        const endpoint = this.apiHandlers.get(apiName);
        if(!definition || !endpoint) return await this.answerUnmatched(ctx, resolver);
        return await this.runApi(ctx, definition, endpoint.output, endpoint.compress, endpoint.handler);
    }

    /**
     * The definition of the endpoint a call names, its group loaded first
     * when it is a lazy one no call has reached yet; undefined for a name no
     * registered group declares. Everything that reads an endpoint's
     * declarations for a call asks here (its dispatch, a refusal a hook
     * throws on the way to it, a per-API budget a hook charges), so a lazy
     * group answers each of them as an eager one does.
     */
    private async registeredDefinitionOf(apiName: string): Promise<LambderApiDefinition | undefined> {
        const group = splitApiName(apiName)?.group;
        if(group !== undefined && this.lazyApiGroups.has(group)) await this.loadLazyApiGroup(group);
        return this.apiDefinitions.get(apiName);
    }

    /** The endpoints of one group, each checked as `group.action`; nothing is registered until they are committed. */
    private prepareApiGroup(group: LambderApiGroup): LambderPreparedApi[] {
        return Object.entries(group.apis).map(([action, declaration]) =>
            this.prepareApi(`${group.name}.${action}`, declaration.options, declaration.handler));
    }

    /**
     * A lazy group, loaded once: its import, checked to be the group it was
     * registered as, then registered. Concurrent first calls share one load;
     * a failed load is forgotten, so the next call tries again rather than
     * answering every later call with the first failure.
     */
    private async loadLazyApiGroup(name: string): Promise<void> {
        const lazy = this.lazyApiGroups.get(name);
        if(!lazy) return;
        if(!lazy.loading){
            const loading = (async () => {
                const loaded: unknown = await lazy.group.load();
                if(!isRegistrableApiGroup(loaded) || loaded.kind !== "lambderApiGroup"){
                    throw new Error(`Lambder: the loader of lazy group "${name}" resolved to something that is not a group. Resolve to the value defineApiGroup() built.`);
                }
                if(loaded.name !== name){
                    throw new Error(`Lambder: lazy group "${name}" loaded the group "${loaded.name}". The loader must resolve to the group of the name it was registered under.`);
                }
                for(const api of this.prepareApiGroup(loaded)) this.commitApi(api);
                this.lazyApiGroups.delete(name);
            })();
            lazy.loading = loading;
            loading.catch(() => { if(lazy.loading === loading) lazy.loading = null; });
        }
        await lazy.loading;
    }

    /**
     * What registering an endpoint takes: the checks that can refuse it and
     * its mode read off its guards, into the definition apiSignatures()
     * digests, beside its handler. Nothing is recorded here (commitApi does
     * that), so a refusal anywhere in a registration leaves nothing behind.
     */
    private prepareApi(
        name: string,
        schema: LambderApiDeclarationOptions,
        handler: (ctx: never) => MaybePromise<unknown>,
    ): LambderPreparedApi {
        const guardEntries = toGuardEntries(schema.guards);
        const guardNeedsSession = (guard: string) =>
            !!this.guards && Object.prototype.hasOwnProperty.call(this.guards, guard) && this.guards[guard]?.session === true;
        const mode: LambderApiMode = guardEntries.some(({ name: guard }) => guardNeedsSession(guard)) ? "session" : "public";
        if(mode === "session" && !this.pipeline.hasSessions){
            throw new Error(`Lambder: a guard of API "${name}" needs a session, and the instance was created without the session option.`);
        }
        if(this.requireApiGuards && schema.guards === undefined){
            throw new Error(
                `Lambder: API "${name}" declares no guards, and requireApiGuards is on. ` +
                `Declare the guard that authorizes it, or the named no-op guard that records why it needs nothing more.`
            );
        }
        // The option, like guards and rateLimit, is a declaration or absent:
        // an empty list would read as declaring codes while declaring none.
        const ownRefusals = toRefusalCodes(schema.refusals);
        if(schema.refusals !== undefined && ownRefusals.length === 0){
            throw new Error(`Lambder: API "${name}" declares an empty refusals option, which declares no code. Name the codes it refuses with, or omit the option entirely.`);
        }
        const allowedCodes = resolveAllowedRefusals(
            name,
            this.refusalVocabulary,
            ownRefusals,
            guardEntries.map(({ name: guard }) => ({
                guard,
                codes: (this.guards && Object.prototype.hasOwnProperty.call(this.guards, guard) ? this.guards[guard]?.refusals : undefined) ?? [],
            })),
        );
        const refusals: LambderEndpointRefusals = { codes: allowedCodes, codeRequired: this.requireRefusalCodes };
        const definition: LambderApiDefinition = { name, mode, guards: schema.guards, rateLimit: schema.rateLimit, idempotency: schema.idempotency, input: schema.input, output: schema.output, refusals };
        this.pipeline.assertRegistration(definition);
        return { definition, refusalsOption: schema.refusals, output: schema.output, compress: schema.compress ?? "auto", handler };
    }

    /** Records a checked endpoint: its definition, its refusals option as written, and what answers it. */
    private commitApi(api: LambderPreparedApi): void {
        const { name } = api.definition;
        this.apiDefinitions.set(name, api.definition);
        if(api.refusalsOption !== undefined) this.refusalOptions.set(name, api.refusalsOption);
        this.apiHandlers.set(name, { output: api.output, compress: api.compress, handler: api.handler });
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
        // In priority order, lower first; the sort is stable, so hooks of one
        // priority run in the order they were added. A created hook runs once,
        // lazily, before the first request or event is handled.
        this.hookList[hookEvent].push({ priority, hookFn });
        this.hookList[hookEvent].sort((a, b) => a.priority - b.priority);
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
            name: null,
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

    /**
     * Hands the instance to a function that registers on it (routes, hooks,
     * actions) and continues the chain with what it returns. Endpoints are
     * not registered this way: they are values, registered by
     * registerApiGroups(), so a plugin adds nothing to the contract.
     */
    public use(plugin: (lambder: this) => unknown): this {
        plugin(this);
        return this;
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
    getSessionController(ctx: LambderRenderContext | LambderSessionRenderContext<any, TApp["session"]>): LambderSessionController<TApp["session"]>{
        const context = ctx as LambderRenderContext;
        return this.pipeline.sessionController(
            context,
            context.api ? LambderApiPipeline.sessionInfoOf(context.api) : { host: context.host, cookies: context.cookieList, csrfToken: null },
        );
    }

    /** The session manager, for code that works on sessions outside a request (maintenance, tests). */
    getSessionManager(): LambderSessionManager<TApp["session"]> {
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
        if(backends.callSummary !== undefined) this.callSummaryWriter = backends.callSummary;
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
        await this.loadApiGroups();
        const entries = await Promise.all([...this.apiDefinitions.values()].map(async (definition): Promise<LambderApiSignatureEntry> => ({
            name: definition.name,
            key: await apiNameKeyOf(definition.name),
            signature: await apiSignatureOf(definition, this.guards),
        })));
        entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return entries;
    }

    /**
     * Every registered API's mode and declared options as plain data, with
     * the rate-limit policies and guards they name reduced to what is not
     * code: what writeApiOptions (lambder/build) writes to a module a client,
     * a mock or a test imports instead of the server. The contract carries
     * the same options as types; this is the same fact as a value, for code
     * that decides something at runtime with it.
     *
     * Nothing here is a secret or a handler by construction. A guard's
     * parameter is written as it was declared, so it has to be plain data
     * (a permission string, a list, a reason); one that is not fails by API
     * and guard name. A policy's key handler is never written: its `per`
     * says "custom" and no more. A guard's input schema is never written
     * either; its declaration says only which of the three input modes it
     * has. The refusal vocabulary is not written at all: it is shared code
     * (codes, zod schemas, statuses and flags), and the mock declares the
     * same object. Every table is sorted by name, so the module diffs by
     * endpoint and never moves when registrations are reordered.
     */
    async apiOptionEntries(): Promise<LambderApiOptionEntries> {
        await this.loadApiGroups();
        const apis: Record<string, LambderApiOptionEntry> = {};
        for(const name of [...this.apiDefinitions.keys()].sort()){
            const { mode, guards, rateLimit, idempotency } = this.apiDefinitions.get(name)!;
            const refusals = this.refusalOptions.get(name);
            const entry: LambderApiOptionEntry = { mode };
            if(guards !== undefined){
                assertPlainData(guards, `the guards option of API "${name}"`);
                entry.guards = guards;
            }
            if(rateLimit !== undefined){
                assertPlainData(rateLimit, `the rateLimit option of API "${name}"`);
                entry.rateLimit = rateLimit;
            }
            if(idempotency !== undefined) entry.idempotency = idempotency;
            if(refusals !== undefined) entry.refusals = refusals;
            apis[name] = entry;
        }
        const rateLimitPolicies: Record<string, LambderRateLimitPolicyEntry> = {};
        for(const name of Object.keys(this.rateLimitPolicies ?? {}).sort()){
            const { per, budget, chargeAt, refusal, ...windows } = this.rateLimitPolicies![name]!;
            const entry: LambderRateLimitPolicyEntry = {};
            for(const [window, limit] of Object.entries(windows)){
                if(limit !== undefined) (entry as Record<string, unknown>)[window] = limit;
            }
            if(per !== undefined) entry.per = per === "ip" || per === "session" ? per : "custom";
            if(budget !== undefined) entry.budget = budget;
            if(chargeAt !== undefined) entry.chargeAt = chargeAt;
            if(refusal !== undefined){
                assertPlainData(refusal, `the refusal of rate-limit policy "${name}"`);
                entry.refusal = refusal;
            }
            rateLimitPolicies[name] = entry;
        }
        const guards: Record<string, LambderGuardDeclarationEntry> = {};
        for(const name of Object.keys(this.guards ?? {}).sort()){
            const guard = this.guards![name]!;
            guards[name] = {
                input: guard.apiInput ? "apiInput" : guard.guardInput ? "guardInput" : "none",
                session: guard.session === true,
                runAt: guard.runAt ?? "beforeInputValidation",
                ...(guard.refusals?.length ? { refusals: guard.refusals } : {}),
            };
        }
        return { apis, rateLimitPolicies, guards };
    }

    /**
     * Every registered API's input and output schemas by name, sorted by
     * name: what writeApiSchemas (lambder/build) writes as JSON Schema to a
     * module the mock validates its calls against. A build-time view, as
     * apiSignatureEntries() is: it comes off the server instance, which a
     * generator imports and a client never does.
     */
    async apiSchemaEntries(): Promise<Record<string, { input: z.ZodType; output: z.ZodType }>> {
        await this.loadApiGroups();
        const entries: Record<string, { input: z.ZodType; output: z.ZodType }> = {};
        for(const name of [...this.apiDefinitions.keys()].sort()){
            // Both are always there on the server: registration takes them from the declaration, which requires them.
            const { input, output } = this.apiDefinitions.get(name)!;
            entries[name] = { input: input!, output: output! };
        }
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
                for(const hook of this.hookList["created"]){ await hook.hookFn(this); }
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
        return await this.answerUnmatched(beforeRenderResult, resolver);
    }

    /**
     * What answers a request nothing matched, its beforeRender hooks run:
     * the fallback hooks, then the API fallback for an API call, and
     * otherwise the public files, the shell and the route fallback in turn.
     */
    private async answerUnmatched(currentCtx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse> {
        for(const hook of this.hookList["fallback"]){ await hook.hookFn(currentCtx, resolver); }

        // A request at or under apiPath is the API's to answer, whatever it
        // asked for. A root apiPath shares every path with the site, the site
        // root included, so there only the calls are.
        const apiArea = this.apiPath.replace(/\/+$/, "");
        const isAPI = currentCtx.api !== null
            || (apiArea !== "" && (currentCtx.path === this.apiPath || currentCtx.path.startsWith(`${apiArea}/`)));
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
            // A page built before endpoints had paths: its call cannot be
            // answered, and telling it its version expired is what reloads it.
            if(ctx.api.retiredPath) return responseFromAnswer(versionExpiredAnswer(this.apiVersion));
            // The protocol's own pre-pass, run here rather than left to the
            // pipeline so that hooks and route matching see a plain payload,
            // and so a stale client, or a body that is no envelope, is
            // answered before any of them, whether or not the name it asked
            // for exists.
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
        // A route's call is named as soon as it has matched, before the hooks
        // run, so the line a hook's answer ends in is the route's too. An API
        // call keeps the name its path gave it, whatever action answers it.
        const invocation = currentInvocation();
        if(invocation && !invocation.call) invocation.call = routeCallOf(ctx, matched.action.name);

        const beforeRenderResult = await this.runBeforeRenderHooks(ctx, resolver, onContextReplaced);
        if(beforeRenderResult instanceof LambderResponse) return beforeRenderResult;

        // An API call's handler time is the pipeline's to measure, inside its
        // own work; a route's is the whole action.
        if(ctx.api) return await matched.action.actionFn(beforeRenderResult, resolver);
        const handlerStarted = performance.now();
        try {
            return await matched.action.actionFn(beforeRenderResult, resolver);
        } finally {
            if(invocation) invocation.handlerMs = performance.now() - handlerStarted;
        }
    }

    /**
     * One HTTP invocation, from the event to the finalized response, under
     * an invocation record of its own (see LambderInvocationScope): what its
     * call summary line is written from once the response is final.
     */
    async render(
        event: LambderHttpEvent,
        lambdaContext: Context
    ): Promise<LambderHttpResponse> {
        return await runInvocation(lambdaContext, async (invocation) => {
            const response = await this.renderRequest(event, lambdaContext, invocation);
            this.writeCallSummary(invocation, response.statusCode);
            return response;
        });
    }

    private async renderRequest(
        event: LambderHttpEvent,
        lambdaContext: Context,
        invocation: LambderInvocationRecord,
    ): Promise<LambderHttpResponse> {
        let ctx: LambderRenderContext | null = null;
        let started = false;
        // Settled as soon as the context exists and reused by every answer,
        // the crash path's included; see allowedCorsOriginOf.
        let allowedOrigin: string | null = null;

        try {
            await this.ensureInitialized();
            started = true;
            ctx = bindContextTools(createContext(event, lambdaContext, this.contextOptions()), this.contextTools);
            invocation.call = apiCallOf(ctx, event);
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

            // Only what the hooks themselves wrote (ctx.setResponseHeader
            // inside a hook) is left to apply, which leaves their overrides standing.
            // A hook that answered with a different response takes the whole
            // set instead: headers belong to the call, not to the response
            // that first carried them, so the call's session cookie must
            // reach it.
            ctx.responseHeaders.applyTo(response, response === responseIntoHooks ? headersAppliedIntoHooks : 0);

            this.applyCors(allowedOrigin, response, this.isCorsPreflight(ctx));

            // An API answer names its outcome; a route's answer names none, and reads from its status.
            invocation.outcome = response.callOutcome ?? (ctx.api ? { outcome: "other", code: null } : outcomeOfStatus(response.statusCode));
            return await finalizeResponse(ctx, response, this.finalizeOptions, ctx.eventFormat);
        }catch(err){
            // A crash before the context existed (a created hook that failed)
            // still answers an API call, and its summary line is the one a
            // dashboard counts the crash by. The context is read from the
            // event and the instance's options alone, so it can be read here;
            // an event it cannot be read from has no call to name.
            if(!ctx){
                try { invocation.call = apiCallOf(createContext(event, lambdaContext, this.contextOptions()), event); } catch { /* no call to name */ }
            }
            return await this.answerCrash(err, ctx, allowedOrigin, started, event, lambdaContext);
        }
    }

    /** What createContext reads this instance's requests with. */
    private contextOptions(): LambderContextOptions {
        return {
            apiPath: this.apiPath,
            trustedClientIpHeaders: this.trustedClientIpHeaders,
            trustedHostHeaders: this.trustedHostHeaders,
            originProof: this.originProof,
        };
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
        if(isLambderApiRefusal(thrown) && ctx.api) return await this.apiErrorResponse(thrown, ctx);
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
        // A crash, whatever the global error handler then answers with.
        const invocation = currentInvocation();
        if(invocation) invocation.outcome = { outcome: "crash", code: null };
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
     * The summary line of an API call or of a request a route answered, once
     * its response is final: nothing for an invocation that served neither. A
     * writer that throws costs the call its line and nothing else.
     */
    private writeCallSummary(invocation: LambderInvocationRecord, status: number): void {
        const { call } = invocation;
        if(!call || !this.callSummaryWriter) return;
        const summary: LambderCallSummary = {
            kind: "lambder.call",
            // The path form is two identifiers; a page built before paths
            // posts the name in its body, which is whatever it sent. A route's
            // name is the app's own, cut the same way.
            api: call.api === null ? null : call.api.slice(0, MAX_SUMMARY_NAME_CHARS),
            route: call.route === null ? null : call.route.slice(0, MAX_SUMMARY_NAME_CHARS),
            outcome: invocation.outcome?.outcome ?? "other",
            code: invocation.outcome?.code ?? null,
            status,
            durationMs: roundedMilliseconds(performance.now() - invocation.startedAt),
            handlerMs: invocation.handlerMs === null ? null : roundedMilliseconds(invocation.handlerMs),
            replayed: invocation.replayed,
            coldStart: invocation.coldStart,
            requestId: invocation.requestId,
            parentRequestId: call.parentRequestId,
        };
        try {
            this.callSummaryWriter(summary);
        } catch(err) {
            console.error(`Lambder: the callSummary writer threw, so the summary of "${summary.api ?? summary.route ?? "a route"}" was not written. ${coerceToError(err).message}`);
        }
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
     * API, and anything else the setSessionExpiredRouteHandler answer, a
     * plain-text 401 by default, as the framework's own 404 and 500 are.
     */
    private async sessionMissingResponse(ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse> {
        if(ctx.api) return responseFromAnswer(sessionExpiredAnswer(this.apiVersion, ctx.logList));
        if(!this.sessionExpiredRouteHandler) return resolver.text("Session required.", { statusCode: 401 });
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
        // Under an invocation record, like an HTTP invocation, so the calls an
        // action makes over invoke carry its request id.
        return await runInvocation(lambdaContext, () => this.renderEventAction(event, lambdaContext));
    }

    private async renderEventAction(event: unknown, lambdaContext: Context): Promise<unknown> {
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
            // A validation refusal, however the app words it.
            return { ...answerFromResponse(await this.apiInputValidationErrorHandler(ctx, this.getResolver(ctx), zodError)), outcome: { outcome: "validation", code: null } };
        }
        // null asks the pipeline for the standard 422, so that answer is
        // written once, in the core, rather than here as well.
        return null;
    }

    /**
     * One API call through the core: the pipeline runs the protocol steps and
     * calls back for the handler, whose returned output becomes the answer
     * the pipeline stores and hands back. The context is the pipeline's
     * context, so a session it fetched is on ctx.session and the validated
     * payload is on ctx.apiPayload when the handler runs.
     *
     * The output goes out as the API's schema declares it. The type system
     * accepts a value that carries more than the schema (a row read straight
     * from a table is assignable to a narrower object type), and without the
     * parse the extra fields, a password hash included, would reach the
     * client. zod strips what the schema does not declare, fills its defaults
     * and applies its transforms, so the wire and the idempotency store only
     * see the declared shape. The handler returns the schema's input form, so
     * a transform runs exactly once.
     *
     * An output the schema rejects, or one that is not an object or an array
     * (isObjectPayload: what makes a caller's success never falsy), is the
     * handler breaking its contract,
     * answered as a crash rather than sent (LambderApiOutputValidationError,
     * which an idempotency key records as its answer, since the handler has
     * already run). The parse is synchronous, so an output schema cannot be
     * async: zod throws from a synchronous parse that meets an async
     * refinement or transform, and a transform may throw of its own accord.
     * Either throw becomes the same error, carrying what was thrown as its
     * cause. Left to escape as it is, it would read as the handler crashing
     * before its answer: the idempotency engine would release the key's claim
     * and every retry would run the operation again.
     */
    private async runApi(
        ctx: LambderRenderContext,
        definition: LambderApiDefinition,
        output: z.ZodType,
        compress: boolean | "auto",
        handler: (ctx: never) => MaybePromise<unknown>,
    ): Promise<LambderResponse> {
        const request = ctx.api;
        if(!request) throw new Error(`Lambder: API "${definition.name}" was matched by a request that is not an API call.`);
        const invocation = currentInvocation();
        const { answer, replayed } = await this.pipeline.run(request, ctx, definition, async () => {
            ctx.apiPayload = request.payload;
            const handlerStarted = performance.now();
            let returned: unknown;
            try {
                returned = await handler(ctx as never);
            } finally {
                if(invocation) invocation.handlerMs = performance.now() - handlerStarted;
            }
            let parsed: z.ZodSafeParseResult<unknown>;
            try {
                parsed = output.safeParse(returned);
            }catch(thrown){
                throw new LambderApiOutputValidationError(definition.name, { thrown });
            }
            if(!parsed.success) throw new LambderApiOutputValidationError(definition.name, { zodError: parsed.error });
            if(!isObjectPayload(parsed.data)) throw new LambderApiOutputValidationError(definition.name, { notObject: describePayloadKind(parsed.data) });
            return envelopeAnswer(successEnvelope(this.apiVersion, parsed.data, ctx.logList));
        });
        // The API's compress option, on whatever answer the call ended with:
        // a replayed one comes back from its store without the hints, and
        // its outcome is read back from its text, which only a replay costs.
        if(invocation) invocation.replayed = replayed;
        return responseFromAnswer({ ...answer, compress, outcome: answer.outcome ?? outcomeOfAnswerText(answer.statusCode, answer.body) });
    }

    /**
     * A thrown LambderApiRefusal (from a hook, say) as the structured API
     * envelope: the pipeline's own answer to a refusal (answerRefusal), so
     * it is checked against the endpoint the call names, its lazy group
     * loaded if the refusal came before the call reached it, and one saying
     * the session is over ends it. A name no API is registered under
     * declares no code, so only an uncoded or a framework refusal goes out
     * for it.
     */
    private async apiErrorResponse(err: LambderApiRefusal, ctx: LambderRenderContext): Promise<LambderResponse> {
        const apiName = ctx.apiName ?? "";
        const refusals = (await this.registeredDefinitionOf(apiName))?.refusals ?? NO_DECLARED_REFUSALS;
        return responseFromAnswer(await this.pipeline.answerRefusal(apiName, refusals, err, ctx));
    }
}

/** The options create() takes: the constructor's, less the two declareRefusals() supplies. */
export type LambderInitCreateOptions<TSessionData> = Omit<LambderCreateOptions<TSessionData>, "refusals" | "requireRefusalCodes">;

/** The init bound to one vocabulary (or none): the policy builders, refuse and create() that share it. */
const lambderInitOf = <TSessionData, TRefusals extends LambderRefusalVocabulary, TCodesRequired extends boolean>(
    declared: LambderDeclaredVocabulary<TRefusals, TCodesRequired> | null,
) => ({
    ...policyBuildersFor<TSessionData, TRefusals, TCodesRequired>(declared?.vocabulary ?? null),
    /**
     * refuse() typed to the app's whole vocabulary, for a shared helper or a
     * hook that raises a declared code with no endpoint in hand: `code` is
     * one of the vocabulary's and `data` follows it. Which endpoint may send
     * the code is checked where the refusal is rendered, as for the free
     * refuse(). Inside an API handler ctx.refuse is narrower, that
     * endpoint's codes alone.
     */
    refuse: refuse as LambderDeclaredRefuse<LambderHandlerRefusalsOf<TRefusals, keyof TRefusals & string>, TCodesRequired>,
    create<const TOptions extends LambderInitCreateOptions<TSessionData>>(
        options: LambderNoExtraKeys<TOptions, LambderInitCreateOptions<TSessionData>> & LambderNestedOptionChecks<TSessionData, TOptions, TRefusals>,
    ): Lambder<{
        session: TSessionData;
        policies: TOptions["rateLimits"] extends { policies: infer TPolicies }
            ? LambderMergedNamedMaps<TPolicies> extends infer TMerged extends Record<string, LambderApiRateLimitPolicyConfig> ? TMerged : {}
            : {};
        guards: TOptions["guards"] extends LambderNamedMapsOption<Record<string, LambderApiGuard<any, any, any>>> ? LambderGuardMetaMap<LambderMergedNamedMaps<TOptions["guards"]>> : {};
        idempotency: TOptions["idempotency"] extends LambderApiIdempotencyConfig ? true : false;
        // Read as "off unless it says otherwise" rather than "on only when it
        // says true", so a widened boolean (a spread of a separately typed
        // options object, or one built in a helper) keeps the requirement
        // instead of quietly losing its compile-time half.
        guardsRequired: [LambderGivenOption<TOptions, "requireApiGuards">] extends [false | undefined] ? false : true;
        sessions: [LambderGivenOption<TOptions, "session">] extends [undefined] ? false : true;
        refusals: TRefusals;
        refusalCodesRequired: TCodesRequired;
    }, {}> {
        const withRefusals: LambderCreateOptions<TSessionData> = { ...options, refusals: declared?.refusals, requireRefusalCodes: declared?.requireCodes ?? false };
        return new Lambder(withRefusals) as never;
    },
});

/**
 * The entry point of an app, and the canonical way to create an instance:
 * fix the session data type first, then create with the full configuration
 * in one declaration. The policy, guard and idempotency types are inferred
 * from the options, so the instance is born fully typed, and the endpoints
 * declared with its defineApi are typed against it. There are no ordering
 * rules, and nothing can be half-configured.
 *
 * Beside create() it hands out the builders that share the session data
 * type (guard, rateLimitKey, refuse). `declareRefusals()` binds the app's
 * refusal vocabulary too, so a guard's ctx.refuse and the init's own refuse
 * are typed to it before any instance exists, and create() gives it to the
 * instance for every API's refusals option to name codes from.
 *
 * ```typescript
 * // app.ts (imports no api modules, so modules can import from it)
 * export const lambderApp = initLambder<SessionData>().create({
 *     apiPath: "/api",
 *     session: { store: new LambderDdbSessionStore({ tableName: "app-session", region: "us-east-1" }), sessionSalt: "..." },
 *     rateLimits: { limiter, policies },
 *     guards,
 *     idempotency: { store },
 * });
 * export const { defineApi, defineApiGroup, lazyApiGroup } = lambderApp;
 *
 * // orders.ts
 * export const orderApis = defineApiGroup("orders", {
 *     place: defineApi({ input, output, guards: "signedIn" }, async (ctx) => ...),
 * });
 *
 * // index.ts: registration only
 * const lambder = lambderApp.registerApiGroups(orderApis).addHook(...);
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
    ...lambderInitOf<TSessionData, {}, false>(null),
    /**
     * Declares the app's refusal vocabulary: every code once, with the schema
     * of its data (`{ data: schema }`) or none (`{}`), the status every
     * refusal with it leaves with (`status`, 200 by default) and whether it
     * sets the notAuthorized flag (`notAuthorized: true`). One map of codes,
     * or a list of them, as guards and rate-limit policies are declared, so
     * each part of an app declares its own codes; a code two maps declare is
     * refused, at compile time and at the call. Returns the init
     * bound to it: its guard() types ctx.refuse to a guard's refusals and
     * refuses a guard naming a code outside the vocabulary, its refuse is
     * typed to the whole vocabulary, and its create() hands the vocabulary to
     * the instance. With `requireCodes`, an uncoded refusal from an API
     * handler, a guard or a helper is a crash rather than an answer, so every
     * "no" a client reads names a code.
     */
    declareRefusals<const TRefusals extends LambderRefusalVocabularyOption, const TRequireCodes extends boolean = false>(
        refusals: TRefusals & LambderRefusalVocabularyOptionChecks<TRefusals>,
        options: { requireCodes?: TRequireCodes } = {},
    ){
        const declared = declaredRefusalVocabulary(refusals, "Lambder");
        return lambderInitOf<TSessionData, LambderMergedRefusalVocabulary<TRefusals>, TRequireCodes>({
            refusals: declared.refusals as LambderMergedRefusalVocabulary<TRefusals>,
            vocabulary: declared.vocabulary,
            requireCodes: (options.requireCodes ?? false) as TRequireCodes,
        });
    },
});

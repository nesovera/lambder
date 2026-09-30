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
import { type LambderWireRefusalsOf, type LambderHandlerRefusalsOf, type LambderRefusalNamesIn, type LambderRefusalsOption, type LambderRefusalVocabularyOption, type LambderRefusalVocabularyOptionChecks, type LambderMergedRefusalVocabulary } from "../api/LambderApiRefusals.js";
import { type LambderDeclaredRefuse } from "../shared/wire/LambderApiRefusal.js";
import { type LambderApiSignatureEntry } from "../api/LambderApiSignature.js";
import { type LambderApiSignatureMap } from "../shared/wire/LambderApiSignatureMap.js";
import type { LambderApiOptionEntries } from "../shared/wire/LambderApiOptionEntries.js";
import type { LambderApiIdempotencyOption } from "../shared/wire/LambderApiOptionValues.js";
import type { LambderApiGuard, LambderGuardMetaMap, LambderGuardsOption, LambderGuardDataOf, LambderGuardInputsOf, LambderGuardRefusalNamesOf } from "../api/LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig, LambderRateLimitOption } from "../api/LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "../api/LambderApiIdempotency.js";
import type { LambderContractEntry, LambderJsonOf } from "../shared/wire/LambderApiContract.js";
import { type LambderActionNamesCheck, type LambderApiDeclaration, type LambderApiDeclarations, type LambderApiGroup, type LambderApiModeOf, type LambderAppTypes, type LambderContractOfGroups, type LambderGroupNameCheck, type LambderGroupPartsCheck, type LambderMergedParts, type LambderLazyApiGroup, type LambderPlainAppTypes, type LambderPublicSessionPolicyCheck, type LambderRegisteredGroupsCheck, type LambderRegistrableApiGroup, type LambderSessionModeCheck } from "../api/LambderApiDeclarations.js";
import { type LambderHttpEvent, type LambderRenderContext, type LambderSessionRenderContext } from "./LambderContext.js";
import type { LambderReadonlyDeep, MaybePromise } from "../shared/util/LambderTypeUtilities.js";
import { type LambderCallSummary } from "./LambderCallSummary.js";
import { type LambderMergedNamedMaps, type LambderNamedMapsOption, type LambderRouteHandler, type LambderInputValidationHandler, type LambderFallbackHandler, type LambderGlobalErrorHandler, type LambderAfterRenderHook, type LambderBeforeRenderHook, type LambderFallbackHook, type LambderActionTools, type LambderCreateOptions, type LambderGivenOption, type LambderHandler, type LambderNestedOptionChecks, type LambderObjectOutputCheck, type LambderPayloadSliceCheck, type LambderRequirableGuardsField, type LambderSessionEnabledInstance, type LambderSessionRouteHandler } from "./LambderCreateOptions.js";
/** Everything `lambder/testing` may put under a built instance: the pipeline's stores, and the source its files are read from. */
export type LambderInstanceBackends = LambderPipelineBackends & {
    fileSource?: LambderFileSource;
    /** Where call summaries go instead of the app's own callSummary; null writes none. */
    callSummary?: ((summary: LambderCallSummary) => void) | null;
};
/** What the instance had a place for; see LambderPipelineBackendSwap. `files` is false on an instance created without the files option. */
export type LambderInstanceBackendSwap = LambderPipelineBackendSwap & {
    files: boolean;
};
/**
 * The "created" hook: run once the instance exists, with the instance. It is
 * declared here rather than beside the other hooks in LambderCreateOptions
 * because its parameter is the class, and an options module that names the
 * class cannot be read without it.
 */
export type LambderCreatedHook = (lambderInstance: Lambder<any, any>) => void | Promise<void>;
/** The codes one API may refuse with, typed: its own refusals option's and its declared guards', as the vocabulary holds them. */
type LambderApiRefusalCodes<TVocabulary, TGuards, TRefusalsOpt, TGuardsOpt> = (LambderRefusalNamesIn<TRefusalsOpt> | LambderGuardRefusalNamesOf<TGuards, TGuardsOpt>) & keyof TVocabulary & string;
/**
 * What an endpoint's handler is handed: the session context when one of its
 * guards needs a session (so ctx.session is typed present), the plain one
 * otherwise, with the payload, the guards' data and a refuse() typed to the
 * codes the endpoint may refuse with.
 */
type LambderApiHandlerContext<TApp extends LambderAppTypes, TPayload, TGuardsOpt, TRefusalsOpt> = (LambderApiModeOf<TApp["guards"], TGuardsOpt> extends "session" ? LambderSessionRenderContext<TPayload, TApp["session"], Record<string, string>, LambderGuardDataOf<TApp["guards"], TGuardsOpt>, TApp["policies"]> : LambderRenderContext<TPayload, Record<string, string>, LambderGuardDataOf<TApp["guards"], TGuardsOpt>, TApp["session"], TApp["policies"]>) & {
    refuse: LambderDeclaredRefuse<LambderHandlerRefusalsOf<TApp["refusals"], LambderApiRefusalCodes<TApp["refusals"], TApp["guards"], TRefusalsOpt, TGuardsOpt>>, TApp["refusalCodesRequired"]>;
};
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
export default class Lambder<TApp extends LambderAppTypes = LambderPlainAppTypes, _TContract extends Record<string, any> = {}> {
    apiPath: string;
    /** Stamped on every API answer's envelope as apiVersion. Informational: a client's staleness is judged per endpoint by its signature, see apiSignatures(). */
    apiVersion: null | string;
    /** The instance's file reader (source + caches), or null without the files option. */
    files: LambderFiles | null;
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
    readonly ApiContract: _TContract;
    /**
     * Type property for what create() configured (LambderAppTypes): the
     * session data, policies, guards and the rest, for code that takes any
     * instance and needs one of them (lambderTestApp reads the session data
     * type here). Like ApiContract, it has no value.
     */
    readonly AppTypes: TApp;
    private actionList;
    /** The API core: the pipeline every API call runs through, shared in shape with the mock runtime. */
    private readonly pipeline;
    /** Every registered API by name: what dispatch, apiSignatures() and apiOptionEntries() read. */
    private readonly apiDefinitions;
    /** What answers each registered API: its output schema, compression setting and handler. */
    private readonly apiHandlers;
    /** Every group name registered, lazy or not: the duplicate-group check. */
    private readonly apiGroupNames;
    /** The lazy groups not loaded yet, each with its load in progress, if one is. */
    private readonly lazyApiGroups;
    /** The guards given at creation, merged into one map, kept for apiSignatures(): a guard's schema is part of the signature of every endpoint declaring it. */
    private readonly guards;
    /** The rate-limit policies given at creation, kept for apiOptionEntries(), which records each one less its key handler. */
    private readonly rateLimitPolicies;
    /** The refusal vocabulary given at creation: what each API's and each guard's refusal codes resolve against. Null without the option. */
    private readonly refusalVocabulary;
    /** Every API's refusals option as written, for apiOptionEntries(); its definition holds the resolved set. */
    private readonly refusalOptions;
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
    /** Whether every endpoint has to declare guards (create()'s requireApiGuards). */
    private readonly requireApiGuards;
    /** Whether every refusal an API answers with has to name a code (declareRefusals's requireCodes). */
    private readonly requireRefusalCodes;
    /** Told what a request threw, beside whatever answers it; null outside a test. See LAMBDER_CRASH_WATCH. */
    private crashWatcher;
    /** The crashes option applied: reporting, and the framework's own 500. */
    private readonly crashHandling;
    /** What this instance binds onto every context it renders (ctx.sessionController, ctx.rateLimit, ctx.isRateLimited). */
    private readonly contextTools;
    private readonly trustedClientIpHeaders;
    private readonly trustedHostHeaders;
    private readonly originProof;
    /** Where each API call's summary goes (the callSummary option); null writes none. Replaceable through the backend swap alone. */
    private callSummaryWriter;
    constructor(given?: LambderCreateOptions<TApp["session"]>);
    setRouteFallbackHandler(routeFallbackHandler: LambderFallbackHandler): this;
    setApiFallbackHandler(apiFallbackHandler: LambderFallbackHandler): this;
    setApiInputValidationErrorHandler(apiInputValidationErrorHandler: LambderInputValidationHandler): this;
    setGlobalErrorHandler(globalErrorHandler: LambderGlobalErrorHandler): this;
    /**
     * Response for a session route when the session is missing or expired,
     * and for any non-API request whose route or hook meets a
     * LambderSessionNotFoundError (the session ended while the request held
     * it, or a session read found none, or cookies naming several: a
     * LambderSessionAmbiguousError). Default: 401.
     */
    setSessionExpiredRouteHandler(handler: LambderFallbackHandler): this;
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
    addRoute<TPath extends LambderRoutePath>(condition: TPath, actionFn: (ctx: LambderRenderContext<any, LambderPathParamsOf<TPath>, {}, TApp["session"], TApp["policies"]>, resolver: LambderResolver) => MaybePromise<LambderResponse>): this;
    addRoute(condition: RegExp | LambderRouteConditionFn | LambderRouteMatcher, actionFn: LambderRouteHandler): this;
    addSessionRoute<TPath extends LambderRoutePath>(condition: TPath, actionFn: ((ctx: LambderSessionRenderContext<any, TApp["session"], LambderPathParamsOf<TPath>, {}, TApp["policies"]>, resolver: LambderResolver) => MaybePromise<LambderResponse>) & LambderSessionEnabledInstance<TApp["sessions"]>): this;
    addSessionRoute(condition: RegExp | LambderRouteConditionFn | LambderRouteMatcher, actionFn: LambderSessionRouteHandler<TApp["session"]> & LambderSessionEnabledInstance<TApp["sessions"]>): this;
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
    readonly defineApi: <TInput extends z.ZodType, TOutput extends z.ZodType, const TAnswer extends LambderReadonlyDeep<z.input<TOutput>>, const TRateOpt extends LambderRateLimitOption<TApp["policies"]> = never, const TGuardsOpt extends LambderGuardsOption<TApp["guards"]> = never, const TIdempotencyOpt extends LambderApiIdempotencyOption = never, const TRefusalsOpt extends LambderRefusalsOption<TApp["refusals"]> = never>(options: {
        input: TInput;
        output: TOutput;
    } & {
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
    } & LambderRequirableGuardsField<TApp["guardsRequired"], TGuardsOpt> & LambderObjectOutputCheck<TOutput> & LambderPayloadSliceCheck<TApp["guards"], TApp["policies"], TGuardsOpt, TRateOpt, z.input<TInput>> & LambderPublicSessionPolicyCheck<LambderApiModeOf<TApp["guards"], TGuardsOpt>, TApp["policies"], TRateOpt> & LambderSessionModeCheck<LambderApiModeOf<TApp["guards"], TGuardsOpt>, TApp["sessions"]>, 
    /** Answers the call by returning its output (parsed through `output` before it is sent), or refuses it with ctx.refuse() or refuse(). */
    handler: (ctx: LambderApiHandlerContext<TApp, z.infer<TInput>, TGuardsOpt, TRefusalsOpt>) => MaybePromise<TAnswer>) => LambderApiDeclaration<LambderContractEntry<z.input<TInput>, LambderJsonOf<z.output<TOutput>>, LambderApiModeOf<TApp["guards"], TGuardsOpt>, LambderGuardInputsOf<TApp["guards"], TGuardsOpt>, TGuardsOpt, TRateOpt, TIdempotencyOpt, LambderWireRefusalsOf<TApp["refusals"], LambderApiRefusalCodes<TApp["refusals"], TApp["guards"], TRefusalsOpt, TGuardsOpt>>>>;
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
    readonly defineApiGroup: <const TName extends string, const TParts extends readonly [LambderApiDeclarations, ...LambderApiDeclarations[]]>(name: TName & LambderGroupNameCheck<TName>, ...parts: TParts & LambderGroupPartsCheck<TParts> & { [TIndex in keyof TParts]: LambderActionNamesCheck<TParts[TIndex]>; }) => LambderApiGroup<TName, LambderMergedParts<TParts>>;
    /**
     * A group loaded on the first call to one of its endpoints:
     * `lazyApiGroup("orders", () => import("./orders.js").then((m) => m.orderApis))`.
     * A cold start then parses none of it, nor anything only it imports,
     * until a request calls it; the contract is the loaded group's, read off
     * its type. The group loaded must carry the same name, which the type
     * checks and loading checks again. `loadApiGroups()` loads every group,
     * for a build step or a boot check that has to see them all.
     */
    readonly lazyApiGroup: <const TName extends string, TGroup extends LambderApiGroup<TName, any>>(name: TName & LambderGroupNameCheck<TName>, load: () => Promise<TGroup>) => LambderLazyApiGroup<TName, NoInfer<TGroup>>;
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
    registerApiGroups<const TGroups extends readonly LambderRegistrableApiGroup[]>(this: LambderRegisteredGroupsCheck<TGroups, Lambder<TApp, _TContract>>, ...groups: TGroups): Lambder<TApp, _TContract & LambderContractOfGroups<TGroups>>;
    /**
     * Loads every lazy group not loaded yet, registering its endpoints: what
     * a build step digesting the signatures, a generator writing the options
     * or a boot check has to do before it sees every endpoint. A group whose
     * registration fails rejects here, which is the point of calling it.
     */
    loadApiGroups(): Promise<void>;
    /**
     * An API call to a registered group, its hooks run: its group loaded
     * first when it is a lazy one no call has reached yet, then its endpoint
     * run. An action the group does not have is answered as any unmatched API
     * call is, fallback hooks first.
     */
    private dispatchApiCall;
    /**
     * The definition of the endpoint a call names, its group loaded first
     * when it is a lazy one no call has reached yet; undefined for a name no
     * registered group declares. Everything that reads an endpoint's
     * declarations for a call asks here (its dispatch, a refusal a hook
     * throws on the way to it, a per-API budget a hook charges), so a lazy
     * group answers each of them as an eager one does.
     */
    private registeredDefinitionOf;
    /** The endpoints of one group, each checked as `group.action`; nothing is registered until they are committed. */
    private prepareApiGroup;
    /**
     * A lazy group, loaded once: its import, checked to be the group it was
     * registered as, then registered. Concurrent first calls share one load;
     * a failed load is forgotten, so the next call tries again rather than
     * answering every later call with the first failure.
     */
    private loadLazyApiGroup;
    /**
     * What registering an endpoint takes: the checks that can refuse it and
     * its mode read off its guards, into the definition apiSignatures()
     * digests, beside its handler. Nothing is recorded here (commitApi does
     * that), so a refusal anywhere in a registration leaves nothing behind.
     */
    private prepareApi;
    /** Records a checked endpoint: its definition, its refusals option as written, and what answers it. */
    private commitApi;
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
    /**
     * Hands the instance to a function that registers on it (routes, hooks,
     * actions) and continues the chain with what it returns. Endpoints are
     * not registered this way: they are values, registered by
     * registerApiGroups(), so a plugin adds nothing to the contract.
     */
    use(plugin: (lambder: this) => unknown): this;
    /**
     * A session controller for a context: what creates, rotates, refreshes
     * and ends sessions. An API call presents its posted CSRF token; a route
     * presents cookies alone. A context this instance renders already
     * carries one as `ctx.sessionController`; this is for a context it did
     * not render, such as one createContext() built from an event on its own.
     */
    getSessionController(ctx: LambderRenderContext | LambderSessionRenderContext<any, TApp["session"]>): LambderSessionController<TApp["session"]>;
    /** The session manager, for code that works on sessions outside a request (maintenance, tests). */
    getSessionManager(): LambderSessionManager<TApp["session"]>;
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
     * finished instance, awaits this, and writes a file that LambderCaller
     * and create() both take as apiSignatures; at request time the pipeline
     * compares a call's signature with the server's copy. This is the only
     * place a digest is computed, so there is no second computation to drift
     * from it. Keys are sorted, so the generated file diffs by endpoint.
     */
    apiSignatures(): Promise<LambderApiSignatureMap>;
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
    apiSignatureEntries(): Promise<LambderApiSignatureEntry[]>;
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
    apiOptionEntries(): Promise<LambderApiOptionEntries>;
    getResponseBuilder(ctx?: LambderRenderContext): LambderResponseBuilder;
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
    private runBeforeRenderHooks;
    private handleNoMatchedAction;
    /**
     * What answers a request nothing matched, its beforeRender hooks run:
     * the fallback hooks, then the API fallback for an API call, and
     * otherwise the public files, the shell and the route fallback in turn.
     */
    private answerUnmatched;
    /**
     * True for the OPTIONS request the CORS layer answers by itself. Asked
     * twice: once to build the 204, once at the end of render() to pick which
     * form of the headers goes on. Applying the ordinary headers on top of
     * the 204's would put both forms on a preflight: `Vary: Origin, Origin`
     * and an Access-Control-Expose-Headers that means nothing before a
     * request.
     */
    private isCorsPreflight;
    private resolveRequest;
    /**
     * One HTTP invocation, from the event to the finalized response, under
     * an invocation record of its own (see LambderInvocationScope): what an
     * API call's summary line is written from once the response is final.
     */
    render(event: LambderHttpEvent, lambdaContext: Context): Promise<LambderHttpResponse>;
    private renderRequest;
    /** What createContext reads this instance's requests with. */
    private contextOptions;
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
    private answerThrown;
    /**
     * A crash, from the thrown value to the answer. It is told to the test
     * watch and reported before anything answers, so the report depends on
     * nothing the answer might break; then the app's global error handler
     * answers it, or the framework's own 500 does when there is none or it
     * failed too.
     */
    private answerCrash;
    /**
     * The summary line of an API call, once its response is final: nothing
     * for an invocation that served no API call. A writer that throws costs
     * the call its line and nothing else.
     */
    private writeCallSummary;
    /**
     * An answer to a crash, carrying what the call wrote and its CORS headers.
     * As on the success path, headers belong to the call: a call that wrote a
     * session cookie and then threw still owes the browser that cookie, and a
     * cross-origin caller cannot read the error at all without CORS headers.
     * The CORS verdict is the one the request settled before it crashed, so
     * answering a crash runs none of the app's code.
     */
    private withCallHeaders;
    /**
     * Fetch the session for a session route or short-circuit it with the
     * answer for a missing session. Session APIs never come through here:
     * the pipeline answers them with the protocol's { sessionExpired: true }
     * envelope itself.
     */
    private requireSession;
    /**
     * The answer to a request that needed a session and has none, whether it
     * never had one or it ended while the request held it: an API call gets
     * the protocol's sessionExpired envelope, as the pipeline gives a session
     * API, and anything else the setSessionExpiredRouteHandler answer, a 401
     * by default.
     */
    private sessionMissingResponse;
    /**
     * Dispatch a non-HTTP Lambda event to the registered actions. What an
     * action throws is reported (crashes.report) and then rethrown untouched,
     * so Lambda's retries and dead-letter queues still see the failure.
     */
    renderEvent(event: unknown, lambdaContext: Context): Promise<unknown>;
    private renderEventAction;
    /**
     * The answer for a rejected input: the app's
     * setApiInputValidationErrorHandler when set, otherwise the standard 422
     * body. The API's own schema and every preflight slice (guard inputs,
     * rate-limit keys) answer through here, so one failure has one shape.
     */
    private inputValidationRefusal;
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
    private runApi;
    /**
     * A thrown LambderApiRefusal (from a hook, say) as the structured API
     * envelope: the core's one mapping, after the same check the pipeline
     * applies, against the endpoint the call names, its lazy group loaded if
     * the refusal came before the call reached it. A name no API is
     * registered under declares no code, so only an uncoded or a framework
     * refusal goes out for it.
     */
    private apiErrorResponse;
}
/**
 * The canonical way to create an instance: fix the session data type first,
 * then create with the full configuration in one declaration. The policy,
 * guard and idempotency types are inferred from the options, so the instance
 * is born fully typed, and the endpoints declared with its defineApi are
 * typed against it. There are no ordering rules, and nothing can be
 * half-configured.
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
/** The options create() takes: the constructor's, less the two declareRefusals() supplies. */
export type LambderInitCreateOptions<TSessionData> = Omit<LambderCreateOptions<TSessionData>, "refusals" | "requireRefusalCodes">;
/**
 * The entry point of an app: binds the session data type, and hands out the
 * builders and create() that share it. `declareRefusals()` binds the app's
 * refusal vocabulary too, so a guard's ctx.refuse and the init's own refuse
 * are typed to it before any instance exists, and create() gives it to the
 * instance for every API's refusals option to name codes from.
 */
export declare const initLambder: <TSessionData = any>() => {
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
    declareRefusals<const TRefusals extends LambderRefusalVocabularyOption, const TRequireCodes extends boolean = false>(refusals: TRefusals & LambderRefusalVocabularyOptionChecks<TRefusals>, options?: {
        requireCodes?: TRequireCodes;
    }): {
        /**
         * refuse() typed to the app's whole vocabulary, for a shared helper or a
         * hook that raises a declared code with no endpoint in hand: `code` is
         * one of the vocabulary's and `data` follows it. Which endpoint may send
         * the code is checked where the refusal is rendered, as for the free
         * refuse(). Inside an API handler ctx.refuse is narrower, that
         * endpoint's codes alone.
         */
        refuse: LambderDeclaredRefuse<LambderHandlerRefusalsOf<LambderMergedRefusalVocabulary<TRefusals>, keyof LambderMergedRefusalVocabulary<TRefusals> & string>, TRequireCodes>;
        create<const TOptions extends LambderInitCreateOptions<TSessionData>>(options: TOptions & Record<Exclude<keyof TOptions, "session" | "guards" | "idempotency" | "apiVersion" | "cors" | "apiPath" | "apiSignatures" | "trustedClientIpHeaders" | "trustedHostHeaders" | "originProof" | "files" | "etag" | "rateLimits" | "minApiVersion" | "compression" | "maxResponseBytes" | "maxRequestPayloadBytes" | "callSummary" | "requireApiGuards" | "crashes">, never> & LambderNestedOptionChecks<TSessionData, TOptions, LambderMergedRefusalVocabulary<TRefusals>>): Lambder<{
            session: TSessionData;
            policies: TOptions["rateLimits"] extends {
                policies: infer TPolicies;
            } ? LambderMergedNamedMaps<TPolicies> extends infer TMerged extends Record<string, LambderApiRateLimitPolicyConfig> ? TMerged : {} : {};
            guards: TOptions["guards"] extends LambderNamedMapsOption<Record<string, LambderApiGuard<any, any, any>>> ? LambderGuardMetaMap<LambderMergedNamedMaps<TOptions["guards"]>> : {};
            idempotency: TOptions["idempotency"] extends LambderApiIdempotencyConfig ? true : false;
            guardsRequired: [LambderGivenOption<TOptions, "requireApiGuards">] extends [false | undefined] ? false : true;
            sessions: [LambderGivenOption<TOptions, "session">] extends [undefined] ? false : true;
            refusals: LambderMergedRefusalVocabulary<TRefusals>;
            refusalCodesRequired: TRequireCodes;
        }, {}>;
        guard: import("../api/LambderApiGuards.js").LambderGuardBuilder<LambderRenderContext<any, Record<string, string>, {}, TSessionData>, LambderSessionRenderContext<any, TSessionData>, LambderMergedRefusalVocabulary<TRefusals>, TRequireCodes>;
        rateLimitKey: import("../api/LambderApiRateLimits.js").LambderRateLimitKeyBuilder<LambderRenderContext<any, Record<string, string>, {}, TSessionData>>;
    };
    /**
     * refuse() typed to the app's whole vocabulary, for a shared helper or a
     * hook that raises a declared code with no endpoint in hand: `code` is
     * one of the vocabulary's and `data` follows it. Which endpoint may send
     * the code is checked where the refusal is rendered, as for the free
     * refuse(). Inside an API handler ctx.refuse is narrower, that
     * endpoint's codes alone.
     */
    refuse: (content: string, options?: ({
        cause?: unknown;
        type?: import("../shared/wire/LambderApiRefusal.js").LambderRefusalMessage["type"] | undefined;
        title?: string | undefined;
        notAuthorized?: boolean | undefined;
        sessionExpired?: boolean | undefined;
        statusCode?: import("../client.js").LambderHttpStatusCode | undefined;
        headers?: Record<string, string> | undefined;
    } & {
        code?: undefined;
        data?: undefined;
    }) | undefined) => never;
    create<const TOptions extends LambderInitCreateOptions<TSessionData>>(options: TOptions & Record<Exclude<keyof TOptions, "session" | "guards" | "idempotency" | "apiVersion" | "cors" | "apiPath" | "apiSignatures" | "trustedClientIpHeaders" | "trustedHostHeaders" | "originProof" | "files" | "etag" | "rateLimits" | "minApiVersion" | "compression" | "maxResponseBytes" | "maxRequestPayloadBytes" | "callSummary" | "requireApiGuards" | "crashes">, never> & LambderNestedOptionChecks<TSessionData, TOptions, {}>): Lambder<{
        session: TSessionData;
        policies: TOptions["rateLimits"] extends {
            policies: infer TPolicies;
        } ? LambderMergedNamedMaps<TPolicies> extends infer TMerged extends Record<string, LambderApiRateLimitPolicyConfig> ? TMerged : {} : {};
        guards: TOptions["guards"] extends LambderNamedMapsOption<Record<string, LambderApiGuard<any, any, any>>> ? LambderGuardMetaMap<LambderMergedNamedMaps<TOptions["guards"]>> : {};
        idempotency: TOptions["idempotency"] extends LambderApiIdempotencyConfig ? true : false;
        guardsRequired: [LambderGivenOption<TOptions, "requireApiGuards">] extends [false | undefined] ? false : true;
        sessions: [LambderGivenOption<TOptions, "session">] extends [undefined] ? false : true;
        refusals: {};
        refusalCodesRequired: false;
    }, {}>;
    guard: import("../api/LambderApiGuards.js").LambderGuardBuilder<LambderRenderContext<any, Record<string, string>, {}, TSessionData>, LambderSessionRenderContext<any, TSessionData>, {}, false>;
    rateLimitKey: import("../api/LambderApiRateLimits.js").LambderRateLimitKeyBuilder<LambderRenderContext<any, Record<string, string>, {}, TSessionData>>;
};
export {};

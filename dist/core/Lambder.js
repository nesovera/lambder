import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import { LambderResponse, finalizeResponse, answerFromResponse, responseFromAnswer, emitResponse, DEFAULT_FINALIZE_OPTIONS, DEFAULT_RESPONSE_COMPRESSION_SETTINGS, } from "./LambderResponse.js";
import { compileRouteMatcher } from "./LambderRouting.js";
import { applyCorsHeaders } from "./LambderCors.js";
import LambderSessionManager from "../session/LambderSessionManager.js";
import { resolveCompressionOption } from "../shared/wire/LambderCompressionOption.js";
import { LambderPublicFilesHandler } from "./LambderPublicFiles.js";
import { LambderIndexHtmlHandler } from "./LambderIndexHtml.js";
import { LambderFiles } from "./LambderFiles.js";
import { isLambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
import { LambderApiPipeline } from "../api/LambderApiPipeline.js";
import { LambderApiSignatureDigests } from "../api/LambderApiSignature.js";
import { apiNameKeyOf } from "../shared/wire/LambderApiSignature.js";
import { apiNotFoundAnswer, crashAnswer, refusalAnswer, } from "../api/LambderApiEnvelope.js";
import { createContext, isV2HttpEvent } from "./LambderContext.js";
import { COMPRESSED_PAYLOAD_GZ_FIELD, COMPRESSED_PAYLOAD_BR_FIELD, COMPRESSED_PAYLOAD_BYTES_FIELD } from "../shared/wire/LambderRequestPayload.js";
import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import { assertCreateOptions, } from "./LambderCreateOptions.js";
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
export default class Lambder {
    // =====================================================================
    // Construction
    // Everything an instance is, fixed before the first registration.
    // =====================================================================
    apiPath;
    /** Stamped on every API answer's envelope as apiVersion. Informational: a client's staleness is judged per endpoint by its signature, see apiSignatures(). */
    apiVersion;
    /** The instance's file reader (source + caches), or null without the files option. */
    files;
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
    ApiContract;
    actionList = [];
    /** The API core: the pipeline every API call runs through, shared in shape with the mock runtime. */
    pipeline;
    /** Every registered API by name: what resolves a request's name to its definition ahead of the pipeline, and what apiSignatures() digests. */
    apiDefinitions = new Map();
    /** The signature of each endpoint as this server serves it, digested once per endpoint on first use. */
    signatureDigests;
    hookList = { "beforeRender": [], "afterRender": [], "fallback": [] };
    createdHooks = [];
    initPromise = null;
    globalErrorHandler = null;
    routeFallbackHandler = null;
    apiFallbackHandler = null;
    apiInputValidationErrorHandler = null;
    sessionExpiredRouteHandler = null;
    publicFilesHandler = null;
    indexHtmlHandler = null;
    eventActionList = [];
    corsConfig = null;
    finalizeOptions;
    requireSessionApiGuards;
    trustedClientIpHeaders;
    requirePublicApiGuards;
    constructor(options = {}) {
        assertCreateOptions(options);
        this.files = options.files ? new LambderFiles(options.files) : null;
        this.apiPath = options.apiPath ?? "/api";
        this.apiVersion = options.apiVersion ?? null;
        this.finalizeOptions = {
            // Resolved (and validated) by the same function the at-rest
            // stores use; on unless explicitly disabled.
            compression: resolveCompressionOption(options.compression, DEFAULT_RESPONSE_COMPRESSION_SETTINGS),
            etag: options.etag ?? DEFAULT_FINALIZE_OPTIONS.etag,
            maxResponseBytes: options.maxResponseBytes ?? DEFAULT_FINALIZE_OPTIONS.maxResponseBytes,
        };
        if (options.cors !== undefined && options.cors !== false) {
            this.corsConfig = options.cors === true ? {} : options.cors;
        }
        const session = options.session;
        this.signatureDigests = new LambderApiSignatureDigests(options.guards);
        this.pipeline = new LambderApiPipeline({
            apiVersion: this.apiVersion,
            signatures: this.signatureDigests,
            maxRequestPayloadBytes: options.maxRequestPayloadBytes,
            // The app's own validation handler is read at call time, since
            // setApiInputValidationErrorHandler runs after creation.
            onInvalidInput: (zodError, ctx) => this.inputValidationRefusal(ctx, zodError),
            sessions: session
                ? {
                    manager: new LambderSessionManager({
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
        this.requireSessionApiGuards = options.requireSessionApiGuards ?? false;
        this.requirePublicApiGuards = options.requirePublicApiGuards ?? false;
    }
    // =====================================================================
    // Registration
    // What an app declares on the instance; all of it chains.
    // =====================================================================
    setRouteFallbackHandler(routeFallbackHandler) {
        this.routeFallbackHandler = routeFallbackHandler;
        return this;
    }
    setApiFallbackHandler(apiFallbackHandler) {
        this.apiFallbackHandler = apiFallbackHandler;
        return this;
    }
    setApiInputValidationErrorHandler(apiInputValidationErrorHandler) {
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;
        return this;
    }
    setGlobalErrorHandler(globalErrorHandler) {
        this.globalErrorHandler = globalErrorHandler;
        return this;
    }
    /** Response for session routes when the session is missing/expired (non-API). Default: 401. */
    setSessionExpiredRouteHandler(handler) {
        this.sessionExpiredRouteHandler = handler;
        return this;
    }
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
    servePublicFiles(options = {}) {
        if (!this.files)
            throw new Error("Lambder: servePublicFiles requires the files option at creation (e.g. files: new LambderLocalFileSource({ root }))");
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
    serveIndexHtml(handler, options = {}) {
        this.indexHtmlHandler = new LambderIndexHtmlHandler(handler ?? null, options);
        return this;
    }
    addRoute(condition, actionFn) {
        this.actionList.push({
            match: compileRouteMatcher(condition),
            actionFn: (ctx, resolver) => actionFn(ctx, resolver),
        });
        return this;
    }
    addSessionRoute(condition, actionFn) {
        this.actionList.push({
            match: compileRouteMatcher(condition),
            actionFn: async (ctx, resolver) => {
                await this.requireSession(ctx, resolver);
                // requireSession answered already if there was no session, so
                // the only narrowing left is null to non-null.
                return await actionFn(ctx, resolver);
            },
        });
        return this;
    }
    // Typed API with Zod
    addApi(name, schema, handler) {
        this.assertApiRegistration(name, "public", schema);
        const definition = { name, mode: "public", guards: schema.guards, rateLimit: schema.rateLimit, idempotency: schema.idempotency, input: schema.input, output: schema.output };
        this.apiDefinitions.set(name, definition);
        this.actionList.push({
            match: (ctx) => ctx.apiName === name ? {} : false,
            actionFn: (ctx, resolver) => this.runApi(ctx, resolver, definition, handler),
        });
        return this;
    }
    // Typed Session API with Zod
    addSessionApi(name, schema, handler) {
        this.assertApiRegistration(name, "session", schema);
        const definition = { name, mode: "session", guards: schema.guards, rateLimit: schema.rateLimit, idempotency: schema.idempotency, input: schema.input, output: schema.output };
        this.apiDefinitions.set(name, definition);
        this.actionList.push({
            match: (ctx) => ctx.apiName === name ? {} : false,
            actionFn: (ctx, resolver) => this.runApi(ctx, resolver, definition, handler),
        });
        return this;
    }
    addHook(hookEvent, hookFn, priority = 0) {
        if (hookEvent === "created") {
            // Runs once, lazily, at the first render() call.
            this.createdHooks.push(hookFn);
        }
        else {
            this.hookList[hookEvent].push({ priority, hookFn });
            this.hookList[hookEvent].sort((a, b) => a.priority - b.priority);
        }
        return this;
    }
    addAction(filter, actionFn) {
        // HTTP side: joins the route/API chain in registration order.
        this.actionList.push({
            match: (ctx) => filter(ctx.event, ctx) ? {} : false,
            actionFn: async (ctx, resolver) => {
                const result = await actionFn(ctx.event, { ctx, res: resolver, lambdaContext: ctx.lambdaContext });
                if (!(result instanceof LambderResponse)) {
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
    // assertions still verify every referenced policy/guard name at runtime.
    // Every policy generic must be listed here: one short of the class's
    // parameter list and the missing one silently falls back to its default,
    // which makes an instance carrying the non-default value unassignable to
    // its own plugins.
    use(plugin) {
        return plugin(this);
    }
    // =====================================================================
    // Accessors
    // What a handler or an app asks the instance for.
    // =====================================================================
    /**
     * Sessions for this request: what handlers create, rotate, refresh and
     * end sessions with. An API call presents its posted CSRF token; a route
     * presents cookies alone.
     */
    getSessionController(ctx) {
        const context = ctx;
        return this.pipeline.sessionController(context, context.api ? LambderApiPipeline.sessionInfoOf(context.api) : { host: context.host, cookies: context.cookieList, csrfToken: null });
    }
    /** The session manager, for code that works on sessions outside a request (maintenance, tests). */
    getSessionManager() {
        return this.pipeline.sessionManager;
    }
    /**
     * Every registered endpoint's signature, keyed by its hashed name: the
     * LambderApiSignatureMap a client build ships with. A generator imports
     * the finished instance, awaits this, and writes the result to a file the
     * frontend passes to LambderCaller as apiSignatures; at request time the
     * server compares each call's signature against these same digests. Keys
     * are sorted, so the generated file diffs by endpoint.
     */
    async apiSignatures() {
        const entries = await Promise.all([...this.apiDefinitions.values()].map(async (definition) => [await apiNameKeyOf(definition.name), await this.signatureDigests.signatureOf(definition)]));
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return Object.fromEntries(entries);
    }
    getResponseBuilder(ctx) {
        return new LambderResponseBuilder({
            files: this.files,
            apiVersion: this.apiVersion,
            ctx,
        });
    }
    ;
    getResolver(ctx) {
        return new LambderResolver({
            files: this.files,
            apiVersion: this.apiVersion,
            ctx,
        });
    }
    ;
    getHandler() {
        return ((event, context) => Lambder.isHttpEvent(event)
            ? this.render(event, context)
            : this.renderEvent(event, context));
    }
    /** True when the Lambda event is an API Gateway HTTP event (REST API v1 or HTTP API / Function URL v2). */
    static isHttpEvent(event) {
        if (!event || typeof event !== "object")
            return false;
        if ("httpMethod" in event && "path" in event)
            return true;
        return isV2HttpEvent(event);
    }
    // =====================================================================
    // The request path
    // One HTTP invocation, from the event to the finalized response.
    // =====================================================================
    ensureInitialized() {
        if (!this.initPromise) {
            const pending = (async () => {
                for (const hookFn of this.createdHooks) {
                    await hookFn(this);
                }
            })();
            this.initPromise = pending;
            // A `created` hook usually reaches something that can be briefly
            // unavailable (a first DynamoDB read, a secret fetch). Keeping the
            // rejected promise meant the warm container answered every later
            // invocation with the first failure and never recovered, so the
            // failure is forgotten and the next invocation runs the hooks
            // again. Whoever is awaiting this one still gets the rejection.
            pending.catch(() => { if (this.initPromise === pending)
                this.initPromise = null; });
        }
        return this.initPromise;
    }
    applyCors(ctx, response, isPreflight) {
        applyCorsHeaders(this.corsConfig, ctx, response, isPreflight);
    }
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
    async runBeforeRenderHooks(ctx, resolver) {
        let currentCtx = ctx;
        for (const hook of this.hookList["beforeRender"]) {
            const hookResult = await hook.hookFn(currentCtx, resolver);
            if (hookResult instanceof Error)
                throw hookResult;
            if (hookResult instanceof LambderResponse)
                return hookResult;
            currentCtx = hookResult;
        }
        return currentCtx;
    }
    async handleNoMatchedAction(ctx, resolver) {
        // Before the fallback hooks, and with the same power it has on a
        // matched route: the fallback hooks are typed void and cannot answer.
        const beforeRenderResult = await this.runBeforeRenderHooks(ctx, resolver);
        if (beforeRenderResult instanceof LambderResponse)
            return beforeRenderResult;
        const currentCtx = beforeRenderResult;
        for (const hook of this.hookList["fallback"]) {
            await hook.hookFn(currentCtx, resolver);
        }
        const isAPI = currentCtx.api !== null || currentCtx.path === this.apiPath;
        if (isAPI) {
            if (this.apiFallbackHandler)
                return await this.apiFallbackHandler(currentCtx, resolver);
            return responseFromAnswer(currentCtx.api ? this.pipeline.answerUnknownApi(currentCtx.api, currentCtx) : apiNotFoundAnswer(this.apiVersion, currentCtx.logList));
        }
        if (this.publicFilesHandler) {
            const fileResponse = await this.publicFilesHandler.handle(currentCtx);
            if (fileResponse)
                return fileResponse;
        }
        const indexResponse = this.indexHtmlHandler ? await this.indexHtmlHandler.handle(currentCtx, resolver) : null;
        if (indexResponse)
            return indexResponse;
        if (this.routeFallbackHandler)
            return await this.routeFallbackHandler(currentCtx, resolver);
        return resolver.text("Not found.", { statusCode: 404 });
    }
    /**
     * True for the OPTIONS request the CORS layer answers by itself. Asked
     * twice: once to build the 204, once at the end of render() to decide
     * which form of the headers goes on. Asking once and letting the tail
     * apply the ordinary headers on top of the 204's would put both forms on
     * a preflight, answering `Vary: Origin, Origin` and an
     * Access-Control-Expose-Headers that means nothing before a request.
     */
    isCorsPreflight(ctx) {
        return ctx.method === "OPTIONS" && !!this.corsConfig;
    }
    async resolveRequest(ctx, resolver) {
        if (this.isCorsPreflight(ctx))
            return new LambderResponse({ statusCode: 204, body: null });
        if (ctx.api) {
            // The protocol's own pre-pass, run here rather than left to the
            // pipeline so that hooks and route matching see a plain payload,
            // and so a stale client is answered before any of them, whether or
            // not the name it asked for exists: the gate is handed the
            // definition the name resolves to, or null.
            const prepared = await this.pipeline.prepare(ctx.api, this.apiDefinitions.get(ctx.api.apiName) ?? null);
            if (prepared)
                return responseFromAnswer(prepared);
            // ctx.post is the raw body view; it shows the restored payload and
            // none of the wire fields, so nothing reading it sees the format.
            ctx.apiPayload = ctx.api.payload;
            ctx.post.payload = ctx.api.payload;
            delete ctx.post[COMPRESSED_PAYLOAD_GZ_FIELD];
            delete ctx.post[COMPRESSED_PAYLOAD_BR_FIELD];
            delete ctx.post[COMPRESSED_PAYLOAD_BYTES_FIELD];
        }
        let matched = null;
        for (const action of this.actionList) {
            const params = action.match(ctx);
            if (params !== false) {
                matched = { action, params };
                break;
            }
        }
        if (!matched)
            return await this.handleNoMatchedAction(ctx, resolver);
        // Set before the hooks run, so a beforeRender hook on a matched route
        // sees the route's own path params.
        ctx.pathParams = matched.params;
        const beforeRenderResult = await this.runBeforeRenderHooks(ctx, resolver);
        if (beforeRenderResult instanceof LambderResponse)
            return beforeRenderResult;
        return await matched.action.actionFn(beforeRenderResult, resolver);
    }
    async render(event, lambdaContext) {
        let ctx = null;
        try {
            await this.ensureInitialized();
            ctx = createContext(event, lambdaContext, this.apiPath, this.trustedClientIpHeaders);
            const resolver = this.getResolver(ctx);
            let response;
            try {
                response = await this.resolveRequest(ctx, resolver);
            }
            catch (err) {
                // A thrown LambderResponse IS the response (res.die.*, throw res.html(...)).
                if (err instanceof LambderResponse) {
                    response = err;
                }
                // A thrown LambderApiRefusal on an API call IS a structured refusal
                // (brand-checked, not instanceof, to survive duplicate installs).
                else if (isLambderApiRefusal(err) && ctx.api) {
                    response = this.apiErrorResponse(err, ctx);
                }
                else {
                    throw err;
                }
            }
            // What the call wrote goes on BEFORE the hooks run, so an
            // afterRender hook can override or delete a header the handler
            // wrote: replaying the operations afterwards put the handler's
            // value straight back, and a hook could not win an argument it
            // was the last to speak in.
            const responseIntoHooks = response;
            const headersAppliedIntoHooks = ctx.responseHeaders.size;
            ctx.responseHeaders.applyTo(response);
            try {
                for (const hook of this.hookList["afterRender"]) {
                    const hookResponse = await hook.hookFn(ctx, resolver, response);
                    if (hookResponse instanceof Error)
                        throw hookResponse;
                    response = hookResponse;
                }
            }
            catch (err) {
                if (err instanceof LambderResponse) {
                    response = err;
                }
                else if (isLambderApiRefusal(err) && ctx.api) {
                    response = this.apiErrorResponse(err, ctx);
                }
                else {
                    throw err;
                }
            }
            // Only what the hooks themselves wrote (res.setHeader inside a
            // hook) is left to apply, which is what leaves their overrides
            // standing. A hook that answered with a DIFFERENT response takes
            // the whole set instead: headers belong to the call rather than to
            // the response that first carried them, so the session cookie the
            // call wrote has to travel across to it.
            ctx.responseHeaders.applyTo(response, response === responseIntoHooks ? headersAppliedIntoHooks : 0);
            this.applyCors(ctx, response, this.isCorsPreflight(ctx));
            return await finalizeResponse(ctx, response, this.finalizeOptions, ctx.eventFormat);
        }
        catch (err) {
            // Describing the thrown value can itself throw: an object with a
            // null prototype, a Proxy, or a throwing toString/Symbol.toPrimitive.
            // Coercing it unguarded in the FIRST statement of the last-resort
            // catch made the catch throw, so the error handler never ran, no
            // envelope was produced, and the invocation rejected with a 502 no
            // client could parse. coerceToError is the shared version of that
            // care, the one every site in the framework now uses.
            const wrappedError = coerceToError(err, "an unstringifiable thrown value");
            // ctx may be null (createContext failed): derive the format from the raw event.
            const eventFormat = ctx?.eventFormat ?? (isV2HttpEvent(event) ? "v2" : "v1");
            try {
                if (this.globalErrorHandler) {
                    const responseBuilder = this.getResponseBuilder(ctx ?? undefined);
                    const errorResponse = await this.globalErrorHandler(wrappedError, ctx, responseBuilder);
                    // The same rule the success path follows: headers belong
                    // to the call, not to the response that first carried
                    // them. A call that wrote a session cookie and then threw
                    // still owes the browser that cookie, and a cross-origin
                    // caller cannot read the error at all without the CORS
                    // headers.
                    ctx?.responseHeaders.applyTo(errorResponse);
                    if (ctx)
                        this.applyCors(ctx, errorResponse, false);
                    return await finalizeResponse(ctx, errorResponse, this.finalizeOptions, eventFormat);
                }
            }
            catch (handlerErr) {
                if (handlerErr instanceof LambderResponse) {
                    ctx?.responseHeaders.applyTo(handlerErr);
                    if (ctx)
                        this.applyCors(ctx, handlerErr, false);
                    try {
                        return await finalizeResponse(ctx, handlerErr, this.finalizeOptions, eventFormat);
                    }
                    catch { /* fall through */ }
                }
            }
            // Last-resort 500. API calls get the core's crash envelope so
            // clients can parse a structured failure; everything else keeps
            // plain text. Emitted directly rather than finalized, because
            // finalization may be what failed. The headers still go on: they
            // belong to the call and not to the response that first carried
            // them, so a call that wrote a session cookie and then threw still
            // owes the browser that cookie, and a cross-origin caller cannot
            // read this error at all without the CORS headers. Applying them
            // is plain object work, none of the compression, base64 or size
            // handling that finalization does.
            const crashResponse = ctx?.api
                ? responseFromAnswer(crashAnswer(this.apiVersion))
                : new LambderResponse({ statusCode: 500, body: "Internal Server Error." });
            ctx?.responseHeaders.applyTo(crashResponse);
            if (ctx)
                this.applyCors(ctx, crashResponse, false);
            return emitResponse(eventFormat, crashResponse.statusCode, crashResponse.headers, typeof crashResponse.body === "string" ? crashResponse.body : "", false);
        }
    }
    /**
     * Fetch the session for a session route or short-circuit it with the
     * sessionExpiredRouteHandler response (default 401). Session APIs never
     * come through here: the pipeline answers them with the protocol's
     * { sessionExpired: true } envelope itself.
     */
    async requireSession(ctx, resolver) {
        const session = await this.getSessionController(ctx).fetchSessionIfExists();
        if (!session) {
            if (this.sessionExpiredRouteHandler) {
                throw await this.sessionExpiredRouteHandler(ctx, resolver);
            }
            throw resolver.status(401, "Session required.");
        }
    }
    /** Dispatch a non-HTTP Lambda event to the registered actions. */
    async renderEvent(event, lambdaContext) {
        await this.ensureInitialized();
        for (const action of this.eventActionList) {
            if (action.match(event)) {
                return await action.actionFn(event, lambdaContext);
            }
        }
        const summary = event && typeof event === "object"
            ? ` (source: ${String(event.source ?? "?")}, detail-type: ${String(event["detail-type"] ?? "?")})`
            : "";
        throw new Error(`Lambder: no action matched non-HTTP event${summary}. Register one with addAction(); a trailing addAction(() => true, ...) acts as a fallback.`);
    }
    // =====================================================================
    // The API path
    // The steps only an API call takes, around the shared core.
    // =====================================================================
    /** Registration-time checks shared by addApi/addSessionApi. */
    assertApiRegistration(name, mode, options) {
        if (this.apiDefinitions.has(name)) {
            throw new Error(`Lambder: duplicate API name "${name}". Dispatch is first-match, so the second registration would be silently dead code.`);
        }
        // Everything that can refuse this registration runs before the name is
        // claimed. Claiming it first meant a caught registration error burned
        // the name, and the retry reported a duplicate instead of the problem
        // the app was fixing; the session check was still on the far side of
        // that line, one method down in addSessionApi.
        if (mode === "session" && !this.pipeline.hasSessions) {
            throw new Error(`Lambder: session API "${name}" needs the session option at creation.`);
        }
        const guardsRequired = mode === "session" ? this.requireSessionApiGuards : this.requirePublicApiGuards;
        if (guardsRequired && options.guards === undefined) {
            const optOut = mode === "session"
                ? "the named no-op guard that marks the session itself as the whole authorization"
                : "the named no-op guard that records why anyone may call it";
            throw new Error(`Lambder: ${mode} API "${name}" declares no guards, and require${mode === "session" ? "Session" : "Public"}ApiGuards is on. ` +
                `Declare the guard that authorizes it, or ${optOut}.`);
        }
        this.pipeline.assertRegistration({ name, mode, guards: options.guards, rateLimit: options.rateLimit, idempotency: options.idempotency });
    }
    /**
     * The answer for a rejected input: the app's
     * setApiInputValidationErrorHandler when set, otherwise the standard 422
     * body. The API's own schema and every preflight slice (guard inputs,
     * rate-limit keys) answer through here, so one failure has one shape.
     */
    async inputValidationRefusal(ctx, zodError) {
        if (this.apiInputValidationErrorHandler) {
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
     * handler runs.
     */
    async runApi(ctx, resolver, definition, handler) {
        const request = ctx.api;
        if (!request)
            throw new Error(`Lambder: API "${definition.name}" was matched by a request that is not an API call.`);
        // What the handler produced, in both forms: the answer went to the
        // pipeline, and the response is kept so it can carry on unchanged.
        const handled = { output: null };
        const { answer } = await this.pipeline.run(request, ctx, definition, async () => {
            ctx.apiPayload = request.payload;
            let response;
            try {
                response = await handler(ctx, resolver);
            }
            catch (err) {
                // A thrown LambderResponse IS the response (res.die.*): an
                // answer like a returned one, stored and replayed alike.
                if (err instanceof LambderResponse)
                    response = err;
                else
                    throw err;
            }
            handled.output = { response, answer: answerFromResponse(response) };
            return handled.output.answer;
        });
        // The handler's own response carries on when the pipeline answered
        // with it, rather than a rebuild of its answer. An answer holds a
        // Buffer body base64-encoded, because that is the plain shape the
        // idempotency store persists, and rebuilding a response from that
        // would hand finalization a base64 string it must pass through
        // uncompressed. Identity is what settles it: the pipeline may have
        // answered with a stored replay or a refusal instead.
        if (handled.output?.answer === answer)
            return handled.output.response;
        return responseFromAnswer(answer);
    }
    /** A thrown LambderApiRefusal (from a hook, say) as the structured API envelope: the core's one mapping. */
    apiErrorResponse(err, ctx) {
        return responseFromAnswer(refusalAnswer(err, this.apiVersion, ctx.logList));
    }
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
export const initLambder = () => ({
    create(options) {
        return new Lambder(options);
    },
});

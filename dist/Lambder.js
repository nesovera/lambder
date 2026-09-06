import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import { LambderResponse, finalizeResponse, DEFAULT_FINALIZE_OPTIONS, } from "./LambderResponse.js";
import { compileRouteMatcher } from "./LambderRouting.js";
import { applyCorsHeaders } from "./LambderCors.js";
import LambderSessionManager from "./LambderSessionManager.js";
import LambderSessionController from "./LambderSessionController.js";
import { LambderPublicFilesHandler } from "./LambderPublicFiles.js";
import { isLambderApiError } from "./LambderApiError.js";
import { LambderApiPolicyEngine, } from "./LambderApiPolicies.js";
import { createContext, isV2HttpEvent } from "./LambderContext.js";
/**
 * Main Lambder class for building type-safe serverless APIs
 *
 * @typeParam TSessionData - Type of session data stored in DynamoDB
 * @typeParam _TContract - @internal Accumulates API contract during chaining (do not pass manually)
 * @typeParam _TRateLimitPolicies - @internal Accumulated by enableApiRateLimits (do not pass manually)
 * @typeParam _TGuardName - @internal Accumulated by defineApiGuards (do not pass manually)
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
export default class Lambder {
    apiPath;
    apiVersion;
    publicPath;
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
    apiPolicyEngine = null;
    registeredApiNames = new Set();
    hookList = { "beforeRender": [], "afterRender": [], "fallback": [] };
    createdHooks = [];
    initPromise = null;
    globalErrorHandler = null;
    routeFallbackHandler = null;
    apiFallbackHandler = null;
    apiInputValidationErrorHandler = null;
    sessionExpiredRouteHandler = null;
    publicFilesHandler = null;
    indexHtmlConfig = null;
    eventActionList = [];
    corsConfig = null;
    finalizeOptions;
    lambderSessionManager;
    sessionCookieOptions = {};
    sessionTokenCookieKey = "LMDRSESSIONTKID";
    sessionCsrfCookieKey = "LMDRSESSIONCSTK";
    constructor(options = {}) {
        this.publicPath = options.publicPath || "/incorrect-path-not-found";
        this.apiPath = options.apiPath ?? "/api";
        this.apiVersion = options.apiVersion ?? null;
        this.finalizeOptions = {
            compression: options.compression === false
                ? false
                : { minBytes: options.compression?.minBytes ?? DEFAULT_FINALIZE_OPTIONS.compression.minBytes },
            etag: options.etag ?? DEFAULT_FINALIZE_OPTIONS.etag,
            maxResponseBytes: options.maxResponseBytes ?? DEFAULT_FINALIZE_OPTIONS.maxResponseBytes,
        };
    }
    enableCors(config) {
        this.corsConfig = config === true ? {} : (config === false ? null : config);
        return this;
    }
    enableDdbSession({ tableName, tableRegion, sessionSalt, enableSlidingExpiration, slidingWriteIntervalSeconds, cookie, partitionKey, sortKey, dataRefresh, }) {
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
    setSessionCookieKey(sessionTokenCookieKey, sessionCsrfCookieKey) {
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
        return this;
    }
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
     * never shadow routes registered after it. Serves real files under
     * publicPath (traversal-safe, mime-typed, memory-cached, immutable-cache
     * heuristic for content-hashed assets); when the file does not exist the
     * request falls through to setRouteFallbackHandler, where the app decides
     * what remains (e.g. render an app shell with res.templateFile).
     */
    servePublicFiles(options = {}) {
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
    serveIndexHtml(handler, options = {}) {
        this.indexHtmlConfig = { handler: handler ?? null, options };
        return this;
    }
    /** Apply the serveIndexHtml gates; null means fall through. */
    async tryServeIndexHtml(ctx, resolver) {
        if (!this.indexHtmlConfig)
            return null;
        const { handler, options } = this.indexHtmlConfig;
        const methods = (options.methods ?? ["GET", "HEAD"]).map((m) => m.toUpperCase());
        if (!methods.includes(ctx.method.toUpperCase()))
            return null;
        if ((options.skipFilePaths ?? false) && (ctx.path.split("/").pop() ?? "").includes("."))
            return null;
        if (options.redirectTrailingSlash && ctx.path.length > 1 && ctx.path.endsWith("/")) {
            const target = ctx.path.replace(/\/+$/, "") || "/";
            return resolver.redirect(target + buildQueryString(ctx), 301);
        }
        const response = handler
            ? await handler(ctx, resolver)
            : await resolver.templateFile(typeof options.indexFile === "function" ? options.indexFile(ctx) : (options.indexFile ?? "index.html"), {}, { cacheControl: "no-cache" });
        if (options.compress !== undefined) {
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
    enableApiRateLimits(config) {
        this.getOrCreatePolicyEngine().setRateLimits(config);
        return this;
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
    enableApiIdempotency(config) {
        this.getOrCreatePolicyEngine().setIdempotency(config);
        return this;
    }
    /**
     * Define named guards that APIs reference (typed) via the `guards`
     * option. Guards run before input validation, in the order the API
     * declares them; a guard refuses by throwing (typically LambderApiError).
     * Callable multiple times so domain modules can contribute their own;
     * names must not collide.
     */
    defineApiGuards(guards) {
        this.getOrCreatePolicyEngine().addGuards(guards);
        return this;
    }
    getOrCreatePolicyEngine() {
        if (!this.apiPolicyEngine)
            this.apiPolicyEngine = new LambderApiPolicyEngine();
        return this.apiPolicyEngine;
    }
    /** Registration-time checks shared by addApi/addSessionApi. */
    assertApiRegistration(name, mode, options) {
        if (this.registeredApiNames.has(name)) {
            throw new Error(`Lambder: duplicate API name "${name}". Dispatch is first-match, so the second registration would be silently dead code.`);
        }
        this.registeredApiNames.add(name);
        const usesPolicies = options.rateLimit !== undefined || options.guards !== undefined || options.idempotency !== undefined;
        if (!usesPolicies)
            return;
        if (!this.apiPolicyEngine) {
            throw new Error(`Lambder: API "${name}" declares rateLimit/guards/idempotency, but none of enableApiRateLimits()/defineApiGuards()/enableApiIdempotency() was called first.`);
        }
        this.apiPolicyEngine.assertRegistration(name, mode, options);
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
                return await actionFn(ctx, resolver);
            },
        });
        return this;
    }
    // Plugin system
    // The policy generics are `any` in the plugin signature on purpose: a
    // module may annotate its parameter as the bare Lambder<SessionData> or
    // as the app's narrowed alias, and both must chain. Registration-time
    // assertions still verify every referenced policy/guard name at runtime.
    use(plugin) {
        return plugin(this);
    }
    // Typed API with Zod
    addApi(name, schema, handler) {
        this.assertApiRegistration(name, "public", schema);
        this.actionList.push({
            match: (ctx) => ctx.apiName === name ? {} : false,
            actionFn: async (ctx, resolver) => {
                if (this.apiPolicyEngine)
                    await this.apiPolicyEngine.runPreflight(name, ctx, resolver, schema);
                const inputResult = schema.input.safeParse(ctx.apiPayload);
                if (!inputResult.success) {
                    if (this.apiInputValidationErrorHandler) {
                        return await this.apiInputValidationErrorHandler(ctx, resolver, inputResult.error);
                    }
                    return resolver.json({ error: "Input validation failed", zodError: inputResult.error }, { statusCode: 422 });
                }
                ctx.apiPayload = inputResult.data;
                const run = async () => await handler(ctx, resolver);
                if (this.apiPolicyEngine && schema.idempotency)
                    return await this.apiPolicyEngine.withIdempotency(name, ctx, schema.idempotency, run);
                return await run();
            },
        });
        return this;
    }
    // Typed Session API with Zod
    addSessionApi(name, schema, handler) {
        this.assertApiRegistration(name, "session", schema);
        this.actionList.push({
            match: (ctx) => ctx.apiName === name ? {} : false,
            actionFn: async (ctx, resolver) => {
                await this.requireSession(ctx, resolver);
                if (this.apiPolicyEngine)
                    await this.apiPolicyEngine.runPreflight(name, ctx, resolver, schema);
                const inputResult = schema.input.safeParse(ctx.apiPayload);
                if (!inputResult.success) {
                    if (this.apiInputValidationErrorHandler) {
                        return await this.apiInputValidationErrorHandler(ctx, resolver, inputResult.error);
                    }
                    return resolver.json({ error: "Input validation failed", zodError: inputResult.error }, { statusCode: 422 });
                }
                ctx.apiPayload = inputResult.data;
                const run = async () => await handler(ctx, resolver);
                if (this.apiPolicyEngine && schema.idempotency)
                    return await this.apiPolicyEngine.withIdempotency(name, ctx, schema.idempotency, run);
                return await run();
            }
        });
        return this;
    }
    /**
     * Fetch the session or short-circuit the request: API calls get the
     * protocol's { sessionExpired: true } response (handled by LambderCaller),
     * routes get the sessionExpiredRouteHandler response (default 401).
     */
    async requireSession(ctx, resolver) {
        const session = await this.getSessionController(ctx).fetchSessionIfExists();
        if (!session) {
            if (ctx._otherInternal.isApiCall) {
                throw resolver.api(null, { sessionExpired: true });
            }
            if (this.sessionExpiredRouteHandler) {
                throw await this.sessionExpiredRouteHandler(ctx, resolver);
            }
            throw resolver.status(401, "Session required.");
        }
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
    getSessionController(ctx) {
        if (!this.lambderSessionManager)
            throw new Error("Session is not enabled. Use lambder.enableDdbSession(...) to enable.");
        return new LambderSessionController({
            lambderSessionManager: this.lambderSessionManager,
            sessionTokenCookieKey: this.sessionTokenCookieKey,
            sessionCsrfCookieKey: this.sessionCsrfCookieKey,
            cookieOptions: this.sessionCookieOptions,
            ctx,
        });
    }
    getResponseBuilder(ctx) {
        return new LambderResponseBuilder({
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            ctx,
        });
    }
    ;
    getResolver(ctx) {
        return new LambderResolver({
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            ctx,
        });
    }
    ;
    /** Map a thrown LambderApiError onto the structured API envelope. */
    apiErrorResponse(err, resolver) {
        return resolver.api(null, {
            ...(err.errorMessage !== undefined ? { errorMessage: err.errorMessage } : {}),
            ...(err.notAuthorized ? { notAuthorized: true } : {}),
            ...(err.sessionExpired ? { sessionExpired: true } : {}),
        }, err.statusCode !== undefined ? { statusCode: err.statusCode } : undefined);
    }
    getHandler() {
        return ((event, context) => Lambder.isHttpEvent(event)
            ? this.render(event, context)
            : this.renderEvent(event, context));
    }
    // ---------------------------------------------------------------------
    // Actions (raw-event or context filtering; the only handler for non-HTTP)
    // ---------------------------------------------------------------------
    /** True when the Lambda event is an API Gateway HTTP event (REST API v1 or HTTP API / Function URL v2). */
    static isHttpEvent(event) {
        if (!event || typeof event !== "object")
            return false;
        if ("httpMethod" in event && "path" in event)
            return true;
        return isV2HttpEvent(event);
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
    // ---------------------------------------------------------------------
    // Render pipeline
    // ---------------------------------------------------------------------
    ensureInitialized() {
        if (!this.initPromise) {
            this.initPromise = (async () => {
                for (const hookFn of this.createdHooks) {
                    await hookFn(this);
                }
            })();
        }
        return this.initPromise;
    }
    applyCors(ctx, response, isPreflight) {
        applyCorsHeaders(this.corsConfig, ctx, response, isPreflight);
    }
    async handleNoMatchedAction(ctx, resolver) {
        for (const hook of this.hookList["fallback"]) {
            await hook.hookFn(ctx, resolver);
        }
        const isAPI = ctx._otherInternal.isApiCall || ctx.path === this.apiPath;
        if (isAPI) {
            if (this.apiFallbackHandler)
                return await this.apiFallbackHandler(ctx, resolver);
            return resolver.api(null, { errorMessage: "API not found." });
        }
        if (this.publicFilesHandler) {
            const fileResponse = await this.publicFilesHandler.handle(ctx);
            if (fileResponse)
                return fileResponse;
        }
        const indexResponse = await this.tryServeIndexHtml(ctx, resolver);
        if (indexResponse)
            return indexResponse;
        if (this.routeFallbackHandler)
            return await this.routeFallbackHandler(ctx, resolver);
        return resolver.text("Not found.", { statusCode: 404 });
    }
    async resolveRequest(ctx, resolver) {
        if (ctx.method === "OPTIONS" && this.corsConfig) {
            const preflight = new LambderResponse({ statusCode: 204, body: null });
            this.applyCors(ctx, preflight, true);
            return preflight;
        }
        // Version check if provided by both the client and the server
        if (this.apiVersion && ctx._otherInternal.requestVersion && ctx._otherInternal.requestVersion !== this.apiVersion) {
            return resolver.versionExpired();
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
        ctx.pathParams = matched.params;
        let currentCtx = ctx;
        for (const hook of this.hookList["beforeRender"]) {
            const hookResult = await hook.hookFn(currentCtx, resolver);
            if (hookResult instanceof Error)
                throw hookResult;
            if (hookResult instanceof LambderResponse)
                return hookResult;
            currentCtx = hookResult;
        }
        return await matched.action.actionFn(currentCtx, resolver);
    }
    async render(event, lambdaContext) {
        let ctx = null;
        try {
            await this.ensureInitialized();
            ctx = createContext(event, lambdaContext, this.apiPath);
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
                // A thrown LambderApiError on an API call IS a structured refusal
                // (brand-checked, not instanceof, to survive duplicate installs).
                else if (isLambderApiError(err) && ctx._otherInternal.isApiCall) {
                    response = this.apiErrorResponse(err, resolver);
                }
                else {
                    throw err;
                }
            }
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
                else if (isLambderApiError(err) && ctx._otherInternal.isApiCall) {
                    response = this.apiErrorResponse(err, resolver);
                }
                else {
                    throw err;
                }
            }
            // Apply setHeader, addHeader values.
            for (const header of ctx._otherInternal.setHeaderFnAccumulator) {
                response.setHeader(header.key, header.value);
            }
            for (const header of ctx._otherInternal.addHeaderFnAccumulator) {
                response.addHeader(header.key, header.value);
            }
            this.applyCors(ctx, response, false);
            return await finalizeResponse(ctx, response, this.finalizeOptions, ctx._otherInternal.eventFormat);
        }
        catch (err) {
            const wrappedError = err instanceof Error ? err : new Error("Error: " + String(err));
            // ctx may be null (createContext failed): derive the format from the raw event.
            const eventFormat = ctx?._otherInternal.eventFormat ?? (isV2HttpEvent(event) ? "v2" : "v1");
            try {
                if (this.globalErrorHandler) {
                    const responseBuilder = this.getResponseBuilder(ctx ?? undefined);
                    const errorResponse = await this.globalErrorHandler(wrappedError, ctx, responseBuilder, ctx?._otherInternal.logToApiResponseAccumulator);
                    return await finalizeResponse(ctx, errorResponse, this.finalizeOptions, eventFormat);
                }
            }
            catch (handlerErr) {
                if (handlerErr instanceof LambderResponse) {
                    try {
                        return await finalizeResponse(ctx, handlerErr, this.finalizeOptions, eventFormat);
                    }
                    catch { /* fall through */ }
                }
            }
            // Last-resort 500. API calls get the JSON envelope so clients can
            // parse a structured failure; everything else keeps plain text.
            if (ctx?._otherInternal.isApiCall) {
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
/** Rebuild the query string from the API Gateway event for redirects. */
const buildQueryString = (ctx) => {
    if (isV2HttpEvent(ctx.event)) {
        return ctx.event.rawQueryString ? `?${ctx.event.rawQueryString}` : "";
    }
    const multi = ctx.event.multiValueQueryStringParameters;
    const single = ctx.event.queryStringParameters;
    const params = new URLSearchParams();
    if (multi) {
        for (const [key, values] of Object.entries(multi)) {
            for (const value of values ?? [])
                params.append(key, value);
        }
    }
    else if (single) {
        for (const [key, value] of Object.entries(single)) {
            if (value !== undefined)
                params.append(key, value);
        }
    }
    const queryString = params.toString();
    return queryString ? `?${queryString}` : "";
};

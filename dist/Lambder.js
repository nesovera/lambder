import { match } from "path-to-regexp";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
import LambderSessionManager from "./LambderSessionManager.js";
import LambderSessionController from "./LambderSessionController.js";
import { createContext } from "./LambderContext.js";
/**
 * Main Lambder class for building type-safe serverless APIs
 *
 * @typeParam TSessionData - Type of session data stored in DynamoDB
 * @typeParam _TContract - @internal Accumulates API contract during chaining (do not pass manually)
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
    isCorsEnabled = false;
    publicPath;
    ejsPath;
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
    actionList;
    hookList;
    globalErrorHandler = null;
    routeFallbackHandler = null;
    apiFallbackHandler = null;
    apiInputValidationErrorHandler = null;
    utils;
    lambderSessionManager;
    sessionTokenCookieKey = "LMDRSESSIONTKID";
    sessionCsrfCookieKey = "LMDRSESSIONCSTK";
    constructor({ publicPath, apiPath, ejsPath, apiVersion }) {
        this.publicPath = publicPath || "/incorrect-path-not-found";
        this.ejsPath = ejsPath || "/incorrect-ejs-path-not-found";
        this.apiPath = apiPath ?? "/api";
        this.apiVersion = apiVersion ?? null;
        this.actionList = [];
        this.hookList = {
            "beforeRender": [],
            "afterRender": [],
            "fallback": [],
        };
        this.utils = new LambderUtils({ ejsPath });
    }
    enableCors(isCorsEnabled) {
        this.isCorsEnabled = isCorsEnabled;
        return this;
    }
    enableDdbSession({ tableName, tableRegion, sessionSalt, enableSlidingExpiration }, { partitionKey, sortKey } = { partitionKey: "pk", sortKey: "sk" }) {
        this.lambderSessionManager = new LambderSessionManager({
            tableName, tableRegion, partitionKey, sortKey, sessionSalt, enableSlidingExpiration
        });
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
    getPatternMatch(pattern, path) {
        const result = (match(pattern, { decode: decodeURIComponent }))(path);
        if (!result)
            return {};
        return result?.params || {};
    }
    testPatternMatch(pattern, path) {
        return (match(pattern, { decode: decodeURIComponent }))(path) !== false;
    }
    async handleNoMatchedAction(ctx, resolver) {
        for (const hook of this.hookList["fallback"]) {
            await hook.hookFn(ctx, resolver);
        }
        const isAPI = ctx.path === this.apiPath;
        if (isAPI && this.apiFallbackHandler) {
            resolver.resolve(await this.apiFallbackHandler(ctx, resolver));
        }
        else if (isAPI) {
            resolver.resolve({ statusCode: 204, body: "API handler not set.", });
        }
        else if (this.routeFallbackHandler) {
            resolver.resolve(await this.routeFallbackHandler(ctx, resolver));
        }
        else {
            resolver.resolve({ statusCode: 204, body: "Route handler not set.", });
        }
    }
    addRoute(condition, actionFn) {
        this.actionList.push({
            conditionFn: (ctx) => (((typeof condition === "string" && this.testPatternMatch(condition, ctx.path)) ||
                (typeof condition === "function" && condition(ctx)) ||
                (condition?.constructor == RegExp && condition.test(ctx.path)))),
            actionFn: async (ctx, resolver) => {
                if (typeof condition === "string") {
                    ctx.pathParams = this.getPatternMatch(condition, ctx.path);
                }
                else if (condition?.constructor == RegExp) {
                    const match = ctx.path.match(condition);
                    ctx.pathParams = match ? (match.groups || match) : {};
                }
                return await actionFn(ctx, resolver);
            }
        });
        return this;
    }
    addSessionRoute(condition, actionFn) {
        this.actionList.push({
            conditionFn: (ctx) => (((typeof condition === "string" && this.testPatternMatch(condition, ctx.path)) ||
                (typeof condition === "function" && condition(ctx)) ||
                (condition?.constructor == RegExp && condition.test(ctx.path)))),
            actionFn: async (ctx, resolver) => {
                if (typeof condition === "string") {
                    ctx.pathParams = this.getPatternMatch(condition, ctx.path);
                }
                else if (condition?.constructor == RegExp) {
                    const match = ctx.path.match(condition);
                    ctx.pathParams = match ? (match.groups || match) : {};
                }
                const sessionCtx = ctx;
                await this.getSessionController(ctx).fetchSession();
                if (!sessionCtx.session) {
                    throw new Error("Session not found.");
                }
                return await actionFn(sessionCtx, resolver);
            }
        });
        return this;
    }
    // Plugin system
    use(plugin) {
        return plugin(this);
    }
    // Typed API with Zod
    addApi(name, schema, handler) {
        this.actionList.push({
            conditionFn: (ctx) => ctx.apiName === name,
            actionFn: async (ctx, resolver) => {
                // Validate Input
                const inputResult = schema.input.safeParse(ctx.apiPayload);
                if (!inputResult.success) {
                    if (this.apiInputValidationErrorHandler) {
                        return await this.apiInputValidationErrorHandler(ctx, resolver, inputResult.error);
                    }
                    return resolver.raw({
                        statusCode: 422,
                        body: JSON.stringify({ error: "Input validation failed", zodError: inputResult.error }),
                        multiValueHeaders: { "Content-Type": ["application/json"] }
                    });
                }
                // Run Handler with validated data
                ctx.apiPayload = inputResult.data;
                return await handler(ctx, resolver);
            },
        });
        return this;
    }
    // Typed Session API with Zod
    addSessionApi(name, schema, handler) {
        this.actionList.push({
            conditionFn: (ctx) => ctx.apiName === name,
            actionFn: async (ctx, resolver) => {
                const sessionCtx = ctx;
                await this.getSessionController(ctx).fetchSession();
                if (!sessionCtx.session) {
                    throw new Error("Session not found.");
                }
                // Validate Input
                const inputResult = schema.input.safeParse(ctx.apiPayload);
                if (!inputResult.success) {
                    if (this.apiInputValidationErrorHandler) {
                        return await this.apiInputValidationErrorHandler(ctx, resolver, inputResult.error);
                    }
                    return resolver.raw({
                        statusCode: 400,
                        body: JSON.stringify({ error: "Input validation failed", zodError: inputResult.error }),
                        multiValueHeaders: { "Content-Type": ["application/json"] }
                    });
                }
                // Run Handler with validated data
                ctx.apiPayload = inputResult.data;
                return await handler(sessionCtx, resolver);
            }
        });
        return this;
    }
    addHook(hookEvent, hookFn, priority = 0) {
        if (hookEvent === "created") {
            return hookFn(this).then(() => this);
        }
        else {
            this.hookList[hookEvent].push({ priority, hookFn });
            this.hookList[hookEvent].sort((a, b) => a.priority - b.priority);
            return this;
        }
    }
    getSessionController(ctx) {
        if (!this.lambderSessionManager)
            throw new Error("Session is not enabled. Use lambder.enableDdbSession(...) to enable.");
        return new LambderSessionController({
            lambderSessionManager: this.lambderSessionManager,
            sessionTokenCookieKey: this.sessionTokenCookieKey,
            sessionCsrfCookieKey: this.sessionCsrfCookieKey,
            ctx,
        });
    }
    getResponseBuilder() {
        return new LambderResponseBuilder({
            isCorsEnabled: this.isCorsEnabled,
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            lambderUtils: this.utils,
        });
    }
    ;
    getResolver(ctx, resolve, reject) {
        return new LambderResolver({
            isCorsEnabled: this.isCorsEnabled,
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            lambderUtils: this.utils,
            ctx, resolve, reject
        });
    }
    ;
    getHandler() {
        return (event, context) => this.render(event, context);
    }
    async render(event, lambdaContext) {
        let eventRenderContext = null;
        try {
            let ctx = createContext(event, lambdaContext, this.apiPath);
            eventRenderContext = ctx;
            return await new Promise(async (resolve, reject) => {
                try {
                    const resolver = this.getResolver(ctx, resolve, reject);
                    if (ctx.method === "OPTIONS")
                        return resolver.cors();
                    const firstMatchedAction = this.actionList.find(action => action.conditionFn(ctx));
                    if (firstMatchedAction) {
                        // Check version if provided by the client and the server
                        if (this.apiVersion && ctx._otherInternal.requestVersion) {
                            if (ctx._otherInternal.requestVersion !== this.apiVersion) {
                                const responseBuilder = this.getResponseBuilder();
                                return resolve(responseBuilder.versionExpired());
                            }
                        }
                        ;
                        // Run beforeRender hooks
                        for (const hook of this.hookList["beforeRender"]) {
                            const hookCtx = await hook.hookFn(ctx, resolver);
                            if (hookCtx instanceof Error) {
                                throw hookCtx;
                            }
                            ctx = hookCtx;
                        }
                        // Run matched action
                        let response = await firstMatchedAction.actionFn(ctx, resolver);
                        // Run afterRender hooks
                        for (const hook of this.hookList["afterRender"]) {
                            const hookResponse = await hook.hookFn(ctx, resolver, response);
                            if (hookResponse instanceof Error) {
                                throw hookResponse;
                            }
                            response = hookResponse;
                        }
                        // Apply setHeader, addHeader values.
                        response.multiValueHeaders = response.multiValueHeaders || {};
                        for (const header of ctx._otherInternal.setHeaderFnAccumulator) {
                            response.multiValueHeaders[header.key] = Array.isArray(header.value) ? header.value : [header.value];
                        }
                        for (const header of ctx._otherInternal.addHeaderFnAccumulator) {
                            response.multiValueHeaders[header.key] = response.multiValueHeaders[header.key] || [];
                            response.multiValueHeaders[header.key].push(header.value);
                        }
                        resolve(response);
                    }
                    else {
                        return this.handleNoMatchedAction(ctx, resolver);
                    }
                }
                catch (err) {
                    const wrappedError = err instanceof Error ? err : new Error("Error: " + String(err));
                    reject(wrappedError);
                }
            });
        }
        catch (err) {
            if (this.globalErrorHandler) {
                const wrappedError = err instanceof Error ? err : new Error("Error: " + String(err));
                const responseBuilder = this.getResponseBuilder();
                return this.globalErrorHandler(wrappedError, eventRenderContext, responseBuilder, eventRenderContext?._otherInternal.logToApiResponseAccumulator);
            }
            return { statusCode: 500, body: "Internal Server Error.", };
        }
    }
}

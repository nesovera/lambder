import querystring from "querystring";
import cookieParser from "cookie";
import { match } from "path-to-regexp";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
import LambderSessionManager from "./LambderSessionManager.js";
import LambderSessionController from "./LambderSessionController.js";
export const createContext = (event, lambdaContext, apiPath) => {
    const host = event.headers.Host || event.headers.host || "";
    const path = event.path;
    const pathParams = null;
    const get = event.queryStringParameters || {};
    const method = event.httpMethod;
    const cookie = cookieParser.parse(event.headers.Cookie || event.headers.cookie || "");
    const headers = event.headers;
    const session = null;
    // Decode body for the post
    let post = {};
    try {
        const decodedBody = event.isBase64Encoded ? (event.body ? Buffer.from(event.body, "base64").toString() : "{}") : (event.body || "{}");
        try {
            post = JSON.parse(decodedBody) || {};
        }
        catch (e) {
            post = querystring.parse(decodedBody) || {};
        }
    }
    catch (e) { }
    // Parse api variables
    const isApiCall = method === "POST" && apiPath && path === apiPath && post.apiName;
    const apiName = isApiCall ? post.apiName : null;
    const apiPayload = isApiCall ? post.payload : null;
    return {
        host, path, pathParams, method,
        get, post, cookie,
        apiName, apiPayload,
        headers, session, lambdaContext,
        _otherInternal: { isApiCall, sessionCookieHeader: null }
    };
};
export default class Lambder {
    apiPath;
    apiVersion;
    isCorsEnabled = false;
    publicPath;
    ejsPath;
    actionList;
    hookList;
    globalErrorHandler = null;
    routeFallbackHandler = null;
    apiFallbackHandler = null;
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
    setIsCorsEnabled(isCorsEnabled) {
        this.isCorsEnabled = isCorsEnabled;
    }
    enableDdbSession({ tableName, tableRegion, sessionSalt }, { partitionKey, sortKey } = { partitionKey: "pk", sortKey: "sk" }) {
        this.lambderSessionManager = new LambderSessionManager({
            tableName, tableRegion, partitionKey, sortKey, sessionSalt
        });
    }
    setSessionCookieKey(sessionTokenCookieKey, sessionCsrfCookieKey) {
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
    }
    setRouteFallbackHandler(routeFallbackHandler) {
        this.routeFallbackHandler = routeFallbackHandler;
    }
    setApiFallbackHandler(apiFallbackHandler) {
        this.apiFallbackHandler = apiFallbackHandler;
    }
    setGlobalErrorHandler(globalErrorHandler) {
        this.globalErrorHandler = globalErrorHandler;
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
    async addModule(moduleFn) {
        await moduleFn(this);
    }
    async importModule(moduleImport) {
        await this.addModule((await moduleImport).default);
    }
    addRoute(condition, actionFn) {
        this.actionList.push({
            conditionFn: (ctx) => (ctx.method === "GET" &&
                ((typeof condition === "string" && this.testPatternMatch(condition, ctx.path)) ||
                    (typeof condition === "function" && condition(ctx)) ||
                    (condition?.constructor == RegExp && condition.test(ctx.path)))),
            actionFn: async (ctx, resolver) => {
                if (typeof condition === "string") {
                    ctx.pathParams = this.getPatternMatch(condition, ctx.path);
                }
                else if (condition?.constructor == RegExp) {
                    ctx.pathParams = ctx.path.match(condition);
                }
                return await actionFn(ctx, resolver);
            }
        });
    }
    ;
    addSessionRoute(condition, actionFn) {
        this.actionList.push({
            conditionFn: (ctx) => (ctx.method === "GET" &&
                ((typeof condition === "string" && this.testPatternMatch(condition, ctx.path)) ||
                    (typeof condition === "function" && condition(ctx)) ||
                    (condition?.constructor == RegExp && condition.test(ctx.path)))),
            actionFn: async (ctx, resolver) => {
                await this.getSessionController(ctx).fetchSession();
                if (typeof condition === "string") {
                    ctx.pathParams = this.getPatternMatch(condition, ctx.path);
                }
                else if (condition?.constructor == RegExp) {
                    ctx.pathParams = ctx.path.match(condition);
                }
                return await actionFn(ctx, resolver);
            }
        });
    }
    ;
    addApi(apiName, actionFn) {
        this.actionList.push({
            conditionFn: (ctx) => (!!ctx.apiName && ((typeof apiName === "string" && ctx.apiName === apiName) ||
                (typeof apiName === "function" && apiName(ctx)) ||
                (apiName?.constructor == RegExp && apiName.test(ctx.apiName)))),
            actionFn: async (ctx, resolver) => await actionFn(ctx, resolver),
        });
    }
    ;
    addSessionApi(apiName, actionFn) {
        this.actionList.push({
            conditionFn: (ctx) => (!!ctx.apiName && ((typeof apiName === "string" && ctx.apiName === apiName) ||
                (typeof apiName === "function" && apiName(ctx)) ||
                (apiName?.constructor == RegExp && apiName.test(ctx.apiName)))),
            actionFn: async (ctx, resolver) => {
                await this.getSessionController(ctx).fetchSession();
                return await actionFn(ctx, resolver);
            }
        });
    }
    ;
    async addHook(hookEvent, hookFn, priority = 0) {
        if (hookEvent === "created") {
            await hookFn(this);
        }
        else {
            this.hookList[hookEvent].push({ priority, hookFn });
            this.hookList[hookEvent].sort((a, b) => a.priority - b.priority);
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
    getResolver(resolve, reject) {
        return new LambderResolver({
            isCorsEnabled: this.isCorsEnabled,
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            lambderUtils: this.utils,
            resolve, reject
        });
    }
    ;
    async render(event, lambdaContext) {
        let eventRenderContext = null;
        try {
            let ctx = createContext(event, lambdaContext, this.apiPath);
            eventRenderContext = ctx;
            return await new Promise(async (resolve, reject) => {
                try {
                    const resolver = this.getResolver(resolve, reject);
                    if (ctx.method === "OPTIONS")
                        return resolver.cors();
                    const firstMatchedAction = this.actionList.find(action => action.conditionFn(ctx));
                    if (firstMatchedAction) {
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
                        // Apply session cookie if needed.
                        if ((ctx._otherInternal.sessionCookieHeader)) {
                            response.multiValueHeaders = {
                                ...(response.multiValueHeaders || {}),
                                ...(ctx._otherInternal.sessionCookieHeader || {}),
                            };
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
                return this.globalErrorHandler(wrappedError, eventRenderContext, responseBuilder);
            }
            return { statusCode: 500, body: "Internal Server Error.", };
        }
    }
}

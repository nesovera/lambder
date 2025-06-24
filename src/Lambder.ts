import querystring from "querystring";
import cookieParser from "cookie";
import { match } from "path-to-regexp";

import type { APIGatewayProxyEvent, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder, { LambderResolverResponse } from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
import LambderSessionManager, { type LambderSessionContext } from "./LambderSessionManager.js";
import LambderSessionController from "./LambderSessionController.js";

type Path = `/${string}`;

export type LambderRenderContext = {
    host: string;
    path: string;
    pathParams: Record<string, any> | null;
    method: string;
    get: Record<string, any>;
    post: Record<string, any>;
    cookie: Record<string, any>;
    apiName: string;
    apiPayload: any;
    headers: APIGatewayProxyEventHeaders;
    session: LambderSessionContext|null;
    event: APIGatewayProxyEvent;
    lambdaContext: Context;
    _otherInternal: { 
        isApiCall: boolean,
        setHeaderFnAccumulator: { key:string, value:string|string[] }[];
        addHeaderFnAccumulator: { key:string, value:string }[];
        logToApiResponseAccumulator: any[];
    };
};

type LambderModuleFunction = (lambderInstance: Lambder) => void | Promise<void>;

type ConditionFunction = (ctx: LambderRenderContext) => boolean;
type ActionFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => LambderResolverResponse|Promise<LambderResolverResponse>;
type ActionObject = { conditionFn: ConditionFunction, actionFn: ActionFunction };

type HookEventType = "created"|"beforeRender"|"afterRender"|"fallback";
type HookCreatedFunction = (lambderInstance: Lambder) => Promise<void>;
type HookBeforeRenderFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => LambderRenderContext|Error|Promise<LambderRenderContext|Error>;
type HookAfterRenderFunction = (ctx: LambderRenderContext, resolver: LambderResolver, response: LambderResolverResponse) => LambderResolverResponse|Error|Promise<LambderResolverResponse|Error>;
type HookFallbackFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => void|Promise<void>;

type GlobalErrorHandlerFunction = (err: Error, ctx: LambderRenderContext|null, response: LambderResponseBuilder, logListToApiResponse?: any[]) => LambderResolverResponse|Promise<LambderResolverResponse>;
type RouteFallbackHandlerFunction = (ctx:LambderRenderContext, resolver: LambderResolver) => LambderResolverResponse;
type ApiFallbackHandlerFunction = (ctx:LambderRenderContext, resolver: LambderResolver) => LambderResolverResponse;


export const createContext = (
    event: APIGatewayProxyEvent, 
    lambdaContext: Context,
    apiPath: string,
):LambderRenderContext => {
    const host = event.headers.Host || event.headers.host || "";
    const path = event.path;
    const pathParams = null;
    const get: Record<string, any> = event.queryStringParameters || {};
    const method = event.httpMethod;
    const cookie = cookieParser.parse(event.headers.Cookie || event.headers.cookie || "");
    const headers = event.headers;
    const session = null;
    
    // Decode body for the post
    let post: Record<string, any> = {};
    try {
        const decodedBody = event.isBase64Encoded ? ( event.body ? Buffer.from(event.body,"base64").toString() : "{}" ) : ( event.body || "{}" );
        try { post = JSON.parse(decodedBody) || {}; }
        catch(e){ post = querystring.parse(decodedBody) || {}; }
    }catch(e){}
    // Parse api variables

    const isApiCall = method === "POST" && apiPath && path === apiPath && post.apiName;
    const apiName:string = isApiCall ? post.apiName : null;
    const apiPayload:string = isApiCall ? post.payload : null;

    return { 
        host, path, pathParams, method, 
        get, post, cookie, event,
        apiName, apiPayload, 
        headers, session, lambdaContext, 
        _otherInternal: { 
            isApiCall, 
            setHeaderFnAccumulator: [], 
            addHeaderFnAccumulator: [], 
            logToApiResponseAccumulator: [], 
        } 
    };
}


export default class Lambder {
    public apiPath: string;
    public apiVersion: null|string;
    public isCorsEnabled: boolean = false;
    public publicPath: string;
    public ejsPath: string;
    
    private actionList: ActionObject[];
    private hookList: { 
        "beforeRender": { priority: number, hookFn: HookBeforeRenderFunction }[],
        "afterRender": { priority: number, hookFn: HookAfterRenderFunction }[],
        "fallback": { priority: number, hookFn: HookFallbackFunction }[],
    };
    private globalErrorHandler: GlobalErrorHandlerFunction|null = null;
    private routeFallbackHandler: RouteFallbackHandlerFunction|null = null;
    private apiFallbackHandler: ApiFallbackHandlerFunction|null = null;

    public utils: LambderUtils;

    private lambderSessionManager?: LambderSessionManager;
    private sessionTokenCookieKey = "LMDRSESSIONTKID";
    private sessionCsrfCookieKey = "LMDRSESSIONCSTK";
    
    constructor(
        { publicPath, apiPath, ejsPath, apiVersion }: 
        { publicPath: string, apiPath?: string, ejsPath?: string, apiVersion?: string }
    ){
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

    enableCors(isCorsEnabled: boolean){
        this.isCorsEnabled = isCorsEnabled;
    }

    enableDdbSession(
        { tableName, tableRegion, sessionSalt }: { tableName: string; tableRegion: string; sessionSalt: string; }, 
        { partitionKey, sortKey }: { partitionKey: string, sortKey: string } = { partitionKey: "pk", sortKey: "sk" }
    ){
        this.lambderSessionManager = new LambderSessionManager({
            tableName, tableRegion, partitionKey, sortKey, sessionSalt
        });
    }

    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string){
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
    }

    setRouteFallbackHandler(routeFallbackHandler: RouteFallbackHandlerFunction){
        this.routeFallbackHandler = routeFallbackHandler;
    }
    setApiFallbackHandler(apiFallbackHandler: ApiFallbackHandlerFunction){
        this.apiFallbackHandler = apiFallbackHandler;
    }
    setGlobalErrorHandler(globalErrorHandler: GlobalErrorHandlerFunction){
        this.globalErrorHandler = globalErrorHandler;
    }
    private getPatternMatch(pattern: string, path: string): Record<string, any> {
        const result = (match(pattern, { decode: decodeURIComponent }))(path);
        if(!result) return {};
        return result?.params || {};
    }
    private testPatternMatch(pattern: string, path: string): boolean{
        return (match(pattern, { decode: decodeURIComponent }))(path) !== false;
    }
    
    private async handleNoMatchedAction(ctx: LambderRenderContext, resolver: LambderResolver){
        for(const hook of this.hookList["fallback"]){  await hook.hookFn(ctx, resolver); }

        const isAPI = ctx.path === this.apiPath;
        if(isAPI && this.apiFallbackHandler){
            resolver.resolve(await this.apiFallbackHandler(ctx, resolver));
        }else if(isAPI){
            resolver.resolve({ statusCode: 204, body: "API handler not set.", })
        }else if(this.routeFallbackHandler){
            resolver.resolve(await this.routeFallbackHandler(ctx, resolver));
        }else{
            resolver.resolve({ statusCode: 204, body: "Route handler not set.", })
        }
    }

    async addModule(moduleFn: LambderModuleFunction): Promise<void>{
        await moduleFn(this);
    }

    async importModule(moduleImport: Promise<{ default: LambderModuleFunction }>): Promise<void>{
        await this.addModule((await moduleImport).default);
    }

    addRoute(condition: Path|ConditionFunction|RegExp, actionFn: ActionFunction):void{
        this.actionList.push({ 
            conditionFn: (ctx:LambderRenderContext) => (
                ctx.method === "GET" && 
                (
                    (typeof condition === "string" && this.testPatternMatch(condition, ctx.path)) ||
                    (typeof condition === "function" && condition(ctx)) ||
                    (condition?.constructor == RegExp && condition.test(ctx.path))
                )
            ), 
            actionFn: async (ctx:LambderRenderContext, resolver: LambderResolver) => {
                if(typeof condition === "string"){
                    ctx.pathParams = this.getPatternMatch(condition, ctx.path);
                }else if(condition?.constructor == RegExp){
                    ctx.pathParams = ctx.path.match(condition);
                }
                
                return await actionFn(ctx, resolver);
            }
        });
    };

    addSessionRoute(condition: Path|ConditionFunction|RegExp, actionFn: ActionFunction):void{
        this.actionList.push({ 
            conditionFn: (ctx:LambderRenderContext) => (
                ctx.method === "GET" &&
                (
                    (typeof condition === "string" && this.testPatternMatch(condition, ctx.path)) ||
                    (typeof condition === "function" && condition(ctx)) ||
                    (condition?.constructor == RegExp && condition.test(ctx.path))
                )
            ), 
            actionFn: async (ctx:LambderRenderContext, resolver: LambderResolver) => {
                await this.getSessionController(ctx).fetchSession();

                if(typeof condition === "string"){
                    ctx.pathParams = this.getPatternMatch(condition, ctx.path);
                }else if(condition?.constructor == RegExp){
                    ctx.pathParams = ctx.path.match(condition);
                }
                return await actionFn(ctx, resolver);
            }
        });
    };
    
    addApi(apiName: string|ConditionFunction|RegExp, actionFn: ActionFunction):void{
        this.actionList.push({ 
            conditionFn: (ctx:LambderRenderContext) =>  (
                !!ctx.apiName && (
                    (typeof apiName === "string" && ctx.apiName === apiName) ||
                    (typeof apiName === "function" && apiName(ctx)) ||
                    (apiName?.constructor == RegExp && apiName.test(ctx.apiName))
                )
            ), 
            actionFn: async (ctx:LambderRenderContext, resolver: LambderResolver) => await actionFn(ctx, resolver),
        });
    };

    addSessionApi(apiName: string|ConditionFunction|RegExp, actionFn: ActionFunction):void{
        this.actionList.push({ 
            conditionFn: (ctx:LambderRenderContext) =>  (
                !!ctx.apiName && (
                    (typeof apiName === "string" && ctx.apiName === apiName) ||
                    (typeof apiName === "function" && apiName(ctx)) ||
                    (apiName?.constructor == RegExp && apiName.test(ctx.apiName))
                )
            ), 
            actionFn: async (ctx:LambderRenderContext, resolver: LambderResolver) => {
                await this.getSessionController(ctx).fetchSession();
                return await actionFn(ctx, resolver);
            }
        });
    };

    async addHook(hookEvent: 'created', hookFn: HookCreatedFunction, priority?: number): Promise<void>;
    async addHook(hookEvent: 'beforeRender', hookFn: HookBeforeRenderFunction, priority?: number): Promise<void>;
    async addHook(hookEvent: 'afterRender', hookFn: HookAfterRenderFunction, priority?: number): Promise<void>;
    async addHook(hookEvent: 'fallback', hookFn: HookFallbackFunction, priority?: number): Promise<void>;
    async addHook(
        hookEvent:HookEventType, 
        hookFn: HookCreatedFunction & HookBeforeRenderFunction & HookAfterRenderFunction & HookFallbackFunction,
        priority = 0
    ): Promise<void> {
        if(hookEvent === "created"){
            await hookFn(this);
        }else{
            this.hookList[hookEvent].push({ priority, hookFn });
            this.hookList[hookEvent].sort((a, b) => a.priority - b.priority);
        }
    }

    getSessionController(ctx: LambderRenderContext): LambderSessionController{
        if(!this.lambderSessionManager) throw new Error("Session is not enabled. Use lambder.enableDdbSession(...) to enable.");

        return new LambderSessionController({
            lambderSessionManager: this.lambderSessionManager,
            sessionTokenCookieKey: this.sessionTokenCookieKey,
            sessionCsrfCookieKey: this.sessionCsrfCookieKey,
            ctx, 
        });
    }

    getResponseBuilder(){
        return new LambderResponseBuilder({
            isCorsEnabled: this.isCorsEnabled, 
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            lambderUtils: this.utils,
        });
    };

    private getResolver(
        ctx: LambderRenderContext, 
        resolve: (response: LambderResolverResponse) => void, 
        reject: (err: Error) => void
    ){
        return new LambderResolver({
            isCorsEnabled: this.isCorsEnabled, 
            publicPath: this.publicPath,
            apiVersion: this.apiVersion,
            lambderUtils: this.utils,
            ctx, resolve, reject
        });
    };

    async render(
        event: APIGatewayProxyEvent,
        lambdaContext: Context
    ): Promise<LambderResolverResponse>{
        let eventRenderContext:LambderRenderContext|null = null;
        
        try {
            let ctx = createContext(event, lambdaContext, this.apiPath);
            eventRenderContext = ctx;

            return await new Promise(async (
                resolve:(response: LambderResolverResponse)=>void,
                reject:(err: Error)=>void
            )=> {
                try{
                    const resolver = this.getResolver(ctx, resolve, reject);
                    if(ctx.method === "OPTIONS") return resolver.cors();
        
                    const firstMatchedAction = this.actionList.find(action => action.conditionFn(ctx));
                    if(firstMatchedAction){
                        // Run beforeRender hooks
                        for(const hook of this.hookList["beforeRender"]){ 
                            const hookCtx = await hook.hookFn(ctx, resolver);
                            if(hookCtx instanceof Error){ throw hookCtx; }
                            ctx = hookCtx;
                        }
                        // Run matched action
                        let response = await firstMatchedAction.actionFn(ctx, resolver);
                        // Run afterRender hooks
                        for(const hook of this.hookList["afterRender"]){ 
                            const hookResponse = await hook.hookFn(ctx, resolver, response);
                            if(hookResponse instanceof Error){ throw hookResponse; }
                            response = hookResponse;
                        }
                        // Apply setHeader, addHeader values.
                        response.multiValueHeaders = response.multiValueHeaders || {};
                        for(const header of ctx._otherInternal.setHeaderFnAccumulator){
                            response.multiValueHeaders[header.key] = Array.isArray(header.value) ? header.value: [header.value];
                        }
                        for(const header of ctx._otherInternal.addHeaderFnAccumulator){
                            response.multiValueHeaders[header.key] = response.multiValueHeaders[header.key] || [];
                            response.multiValueHeaders[header.key].push(header.value);
                        }
                        resolve(response);
                    }else{
                        return this.handleNoMatchedAction(ctx, resolver);
                    }

                } catch(err){ 
                    const wrappedError = err instanceof Error ? err : new Error("Error: " + String(err));
                    reject(wrappedError);
                }
            })
        }catch(err){
            if(this.globalErrorHandler){
                const wrappedError = err instanceof Error ? err : new Error("Error: " + String(err));
                const responseBuilder = this.getResponseBuilder();
                return this.globalErrorHandler(
                    wrappedError, 
                    eventRenderContext, 
                    responseBuilder, 
                    eventRenderContext?._otherInternal.logToApiResponseAccumulator
                );
            }
            return { statusCode: 500, body: "Internal Server Error.", }

        }
    }

}
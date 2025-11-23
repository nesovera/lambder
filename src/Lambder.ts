import { match } from "path-to-regexp";
import { z } from "zod";

import type { APIGatewayProxyEvent, Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder, { LambderResolverResponse } from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
import LambderSessionManager from "./LambderSessionManager.js";
import LambderSessionController from "./LambderSessionController.js";
import type { MergeContract } from "./LambderApiContract.js";
import { createContext, type LambderRenderContext, type LambderSessionRenderContext } from "./LambderContext.js";

type Path = `/${string}`;

type ConditionFunction = (ctx: LambderRenderContext<any>) => boolean;
type ActionFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse|Promise<LambderResolverResponse>;
type SessionActionFunction<SessionData = any> = (ctx: LambderSessionRenderContext<any, SessionData>, resolver: LambderResolver) => LambderResolverResponse|Promise<LambderResolverResponse>;

type ActionObject = { conditionFn: ConditionFunction, actionFn: ActionFunction | SessionActionFunction };

type HookEventType = "created"|"beforeRender"|"afterRender"|"fallback";
type HookCreatedFunction = (lambderInstance: Lambder) => Promise<void>;
type HookBeforeRenderFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderRenderContext<any>|Error|Promise<LambderRenderContext<any>|Error>;
type HookAfterRenderFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver, response: LambderResolverResponse) => LambderResolverResponse|Error|Promise<LambderResolverResponse|Error>;
type HookFallbackFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => void|Promise<void>;

type GlobalErrorHandlerFunction = (err: Error, ctx: LambderRenderContext<any>|null, response: LambderResponseBuilder, logListToApiResponse?: any[]) => LambderResolverResponse|Promise<LambderResolverResponse>;
type RouteFallbackHandlerFunction = (ctx:LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse;
type ApiFallbackHandlerFunction = (ctx:LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse;
type ApiInputValidationErrorHandlerFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver, zodError: z.ZodError) => LambderResolverResponse|Promise<LambderResolverResponse>;

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
export default class Lambder<TSessionData = any, _TContract extends Record<string, any> = {}> {
    public apiPath: string;
    public apiVersion: null|string;
    public isCorsEnabled: boolean = false;
    public publicPath: string;
    public ejsPath: string;
    
    /**
     * Type property for extracting the API contract
     * Use this to export your API types to the frontend
     * 
     * @example
     * ```typescript
     * const lambder = new Lambder().addApi(...).addApi(...);
     * export type AppContract = typeof lambder.ApiContract;
     * ```
     */
    public readonly ApiContract!: _TContract;
    
    private actionList: ActionObject[];
    private hookList: { 
        "beforeRender": { priority: number, hookFn: HookBeforeRenderFunction }[],
        "afterRender": { priority: number, hookFn: HookAfterRenderFunction }[],
        "fallback": { priority: number, hookFn: HookFallbackFunction }[],
    };
    private globalErrorHandler: GlobalErrorHandlerFunction|null = null;
    private routeFallbackHandler: RouteFallbackHandlerFunction|null = null;
    private apiFallbackHandler: ApiFallbackHandlerFunction|null = null;
    private apiInputValidationErrorHandler: ApiInputValidationErrorHandlerFunction|null = null;

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

    enableCors(isCorsEnabled: boolean): this {
        this.isCorsEnabled = isCorsEnabled;
        return this;
    }

    enableDdbSession(
        { tableName, tableRegion, sessionSalt, enableSlidingExpiration }: { tableName: string; tableRegion: string; sessionSalt: string; enableSlidingExpiration?: boolean; }, 
        { partitionKey, sortKey }: { partitionKey: string, sortKey: string } = { partitionKey: "pk", sortKey: "sk" }
    ): this {
        this.lambderSessionManager = new LambderSessionManager({
            tableName, tableRegion, partitionKey, sortKey, sessionSalt, enableSlidingExpiration
        });
        return this;
    }

    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): this {
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
        return this;
    }

    setRouteFallbackHandler(routeFallbackHandler: RouteFallbackHandlerFunction): this {
        this.routeFallbackHandler = routeFallbackHandler;
        return this;
    }
    setApiFallbackHandler(apiFallbackHandler: ApiFallbackHandlerFunction): this {
        this.apiFallbackHandler = apiFallbackHandler;
        return this;
    }
    setApiInputValidationErrorHandler(apiInputValidationErrorHandler: ApiInputValidationErrorHandlerFunction): this {
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;
        return this;
    }
    setGlobalErrorHandler(globalErrorHandler: GlobalErrorHandlerFunction): this {
        this.globalErrorHandler = globalErrorHandler;
        return this;
    }
    private getPatternMatch(pattern: string, path: string): Record<string, any> {
        const result = (match(pattern, { decode: decodeURIComponent }))(path);
        if(!result) return {};
        return result?.params || {};
    }
    private testPatternMatch(pattern: string, path: string): boolean{
        return (match(pattern, { decode: decodeURIComponent }))(path) !== false;
    }
    
    private async handleNoMatchedAction(ctx: LambderRenderContext<any>, resolver: LambderResolver){
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

    addRoute(condition: Path|ConditionFunction|RegExp, actionFn: ActionFunction): this {
        this.actionList.push({ 
            conditionFn: (ctx:LambderRenderContext<any>) => (
                ctx.method === "GET" && 
                (
                    (typeof condition === "string" && this.testPatternMatch(condition, ctx.path)) ||
                    (typeof condition === "function" && condition(ctx)) ||
                    (condition?.constructor == RegExp && condition.test(ctx.path))
                )
            ), 
            actionFn: async (ctx:LambderRenderContext<any>, resolver: LambderResolver) => {
                if(typeof condition === "string"){
                    ctx.pathParams = this.getPatternMatch(condition, ctx.path);
                }else if(condition?.constructor == RegExp){
                    const match = ctx.path.match(condition);
                    ctx.pathParams = match ? (match.groups || (match as unknown as Record<string, any>)) : {};
                }
                
                return await actionFn(ctx, resolver);
            }
        });
        return this;
    }

    addSessionRoute(condition: Path|ConditionFunction|RegExp, actionFn: SessionActionFunction<TSessionData>): this {
        this.actionList.push({ 
            conditionFn: (ctx:LambderRenderContext<any>) => (
                ctx.method === "GET" &&
                (
                    (typeof condition === "string" && this.testPatternMatch(condition, ctx.path)) ||
                    (typeof condition === "function" && condition(ctx)) ||
                    (condition?.constructor == RegExp && condition.test(ctx.path))
                )
            ), 
            actionFn: async (ctx:LambderRenderContext<any>, resolver: LambderResolver) => {
                if(typeof condition === "string"){
                    ctx.pathParams = this.getPatternMatch(condition, ctx.path);
                }else if(condition?.constructor == RegExp){
                    const match = ctx.path.match(condition);
                    ctx.pathParams = match ? (match.groups || (match as unknown as Record<string, any>)) : {};
                }

                const sessionCtx = ctx as unknown as LambderSessionRenderContext<any, TSessionData>;
                await this.getSessionController(ctx).fetchSession();
                if(!sessionCtx.session){ throw new Error("Session not found."); }

                return await actionFn(sessionCtx, resolver);
            }
        });
        return this;
    }
    
    // Plugin system
    public use<_TNewContract extends Record<string, any>>(
        plugin: (lambder: Lambder<TSessionData, _TContract>) => Lambder<TSessionData, _TNewContract>
    ): Lambder<TSessionData, _TNewContract extends _TContract ? _TNewContract : (_TContract & _TNewContract)> {
        return plugin(this) as any;
    }

    // Typed API with Zod
    public addApi<
        TName extends string,
        TInput extends z.ZodTypeAny,
        TOutput extends z.ZodTypeAny
    >(
        name: TName,
        schema: { input: TInput, output: TOutput },
        handler: (
            ctx: LambderRenderContext<z.infer<TInput>>, 
            resolver: LambderResolver<z.infer<TOutput>>
        ) => LambderResolverResponse | Promise<LambderResolverResponse>
    ): Lambder<TSessionData, MergeContract<_TContract, TName, z.infer<TInput>, z.infer<TOutput>>> {
        this.actionList.push({ 
            conditionFn: (ctx:LambderRenderContext<any>) => ctx.apiName === name,
            actionFn: async (ctx:LambderRenderContext<any>, resolver: LambderResolver) => {
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
                return await handler(ctx, resolver);
            },
        });
        return this as any;
    }

    // Typed Session API with Zod
    public addSessionApi<
        TName extends string,
        TInput extends z.ZodTypeAny,
        TOutput extends z.ZodTypeAny
    >(
        name: TName,
        schema: { input: TInput, output: TOutput },
        handler: (
            ctx: LambderSessionRenderContext<z.infer<TInput>, TSessionData>, 
            resolver: LambderResolver<z.infer<TOutput>>
        ) => LambderResolverResponse | Promise<LambderResolverResponse>
    ): Lambder<TSessionData, MergeContract<_TContract, TName, z.infer<TInput>, z.infer<TOutput>>> {
        this.actionList.push({ 
            conditionFn: (ctx:LambderRenderContext<any>) => ctx.apiName === name,
            actionFn: async (ctx:LambderRenderContext<any>, resolver: LambderResolver) => {
                const sessionCtx = ctx as unknown as LambderSessionRenderContext<any, TSessionData>;
                await this.getSessionController(ctx).fetchSession();
                if(!sessionCtx.session){ throw new Error("Session not found."); }

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
        return this as any;
    }

    addHook(hookEvent: 'created', hookFn: HookCreatedFunction, priority?: number): Promise<this>;
    addHook(hookEvent: 'beforeRender', hookFn: HookBeforeRenderFunction, priority?: number): this;
    addHook(hookEvent: 'afterRender', hookFn: HookAfterRenderFunction, priority?: number): this;
    addHook(hookEvent: 'fallback', hookFn: HookFallbackFunction, priority?: number): this;
    addHook(
        hookEvent:HookEventType, 
        hookFn: HookCreatedFunction & HookBeforeRenderFunction & HookAfterRenderFunction & HookFallbackFunction,
        priority = 0
    ): this | Promise<this> {
        if(hookEvent === "created"){
            return hookFn(this).then(() => this);
        }else{
            this.hookList[hookEvent].push({ priority, hookFn });
            this.hookList[hookEvent].sort((a, b) => a.priority - b.priority);
            return this;
        }
    }

    getSessionController(ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>): LambderSessionController<TSessionData>{
        if(!this.lambderSessionManager) throw new Error("Session is not enabled. Use lambder.enableDdbSession(...) to enable.");

        return new LambderSessionController<TSessionData>({
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
        ctx: LambderRenderContext<any>, 
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

    getHandler() {
        return (event: APIGatewayProxyEvent, context: Context) => this.render(event, context);
    }

    async render(
        event: APIGatewayProxyEvent,
        lambdaContext: Context
    ): Promise<LambderResolverResponse>{
        let eventRenderContext:LambderRenderContext<any>|null = null;
        
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
                        // Check version if provided by the client and the server
                        if(this.apiVersion && ctx._otherInternal.requestVersion){
                            if(ctx._otherInternal.requestVersion !== this.apiVersion){
                                const responseBuilder = this.getResponseBuilder();
                                return resolve(responseBuilder.versionExpired());
                            }
                        };
                        // Run beforeRender hooks
                        for(const hook of this.hookList["beforeRender"]){ 
                            const hookCtx = await hook.hookFn(ctx, resolver);
                            if(hookCtx instanceof Error){ throw hookCtx; }
                            ctx = hookCtx;
                        }
                        // Run matched action
                        let response = await firstMatchedAction.actionFn(ctx as any, resolver);
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
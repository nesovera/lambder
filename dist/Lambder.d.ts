import { z } from "zod";
import type { APIGatewayProxyEvent, Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder, { LambderResolverResponse } from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
import LambderSessionController from "./LambderSessionController.js";
import type { MergeContract } from "./LambderApiContract.js";
import { type LambderRenderContext, type LambderSessionRenderContext } from "./LambderContext.js";
type Path = `/${string}`;
type ConditionFunction = (ctx: LambderRenderContext<any>) => boolean;
type ActionFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse | Promise<LambderResolverResponse>;
type SessionActionFunction<SessionData = any> = (ctx: LambderSessionRenderContext<any, SessionData>, resolver: LambderResolver) => LambderResolverResponse | Promise<LambderResolverResponse>;
type HookCreatedFunction = (lambderInstance: Lambder) => Promise<void>;
type HookBeforeRenderFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderRenderContext<any> | Error | Promise<LambderRenderContext<any> | Error>;
type HookAfterRenderFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver, response: LambderResolverResponse) => LambderResolverResponse | Error | Promise<LambderResolverResponse | Error>;
type HookFallbackFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => void | Promise<void>;
type GlobalErrorHandlerFunction = (err: Error, ctx: LambderRenderContext<any> | null, response: LambderResponseBuilder, logListToApiResponse?: any[]) => LambderResolverResponse | Promise<LambderResolverResponse>;
type RouteFallbackHandlerFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse;
type ApiFallbackHandlerFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse;
type ApiInputValidationErrorHandlerFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver, zodError: z.ZodError) => LambderResolverResponse | Promise<LambderResolverResponse>;
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
    apiPath: string;
    apiVersion: null | string;
    isCorsEnabled: boolean;
    publicPath: string;
    ejsPath: string;
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
    readonly ApiContract: _TContract;
    private actionList;
    private hookList;
    private globalErrorHandler;
    private routeFallbackHandler;
    private apiFallbackHandler;
    private apiInputValidationErrorHandler;
    utils: LambderUtils;
    private lambderSessionManager?;
    private sessionTokenCookieKey;
    private sessionCsrfCookieKey;
    constructor({ publicPath, apiPath, ejsPath, apiVersion }: {
        publicPath: string;
        apiPath?: string;
        ejsPath?: string;
        apiVersion?: string;
    });
    enableCors(isCorsEnabled: boolean): this;
    enableDdbSession({ tableName, tableRegion, sessionSalt, enableSlidingExpiration }: {
        tableName: string;
        tableRegion: string;
        sessionSalt: string;
        enableSlidingExpiration?: boolean;
    }, { partitionKey, sortKey }?: {
        partitionKey: string;
        sortKey: string;
    }): this;
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): this;
    setRouteFallbackHandler(routeFallbackHandler: RouteFallbackHandlerFunction): this;
    setApiFallbackHandler(apiFallbackHandler: ApiFallbackHandlerFunction): this;
    setApiInputValidationErrorHandler(apiInputValidationErrorHandler: ApiInputValidationErrorHandlerFunction): this;
    setGlobalErrorHandler(globalErrorHandler: GlobalErrorHandlerFunction): this;
    private getPatternMatch;
    private testPatternMatch;
    private handleNoMatchedAction;
    addRoute(condition: Path | ConditionFunction | RegExp, actionFn: ActionFunction): this;
    addSessionRoute(condition: Path | ConditionFunction | RegExp, actionFn: SessionActionFunction<TSessionData>): this;
    use<_TNewContract extends Record<string, any>>(plugin: (lambder: Lambder<TSessionData, _TContract>) => Lambder<TSessionData, _TNewContract>): Lambder<TSessionData, _TNewContract extends _TContract ? _TNewContract : (_TContract & _TNewContract)>;
    addApi<TName extends string, TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(name: TName, schema: {
        input: TInput;
        output: TOutput;
    }, handler: (ctx: LambderRenderContext<z.infer<TInput>>, resolver: LambderResolver<z.infer<TOutput>>) => LambderResolverResponse | Promise<LambderResolverResponse>): Lambder<TSessionData, MergeContract<_TContract, TName, z.infer<TInput>, z.infer<TOutput>>>;
    addSessionApi<TName extends string, TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(name: TName, schema: {
        input: TInput;
        output: TOutput;
    }, handler: (ctx: LambderSessionRenderContext<z.infer<TInput>, TSessionData>, resolver: LambderResolver<z.infer<TOutput>>) => LambderResolverResponse | Promise<LambderResolverResponse>): Lambder<TSessionData, MergeContract<_TContract, TName, z.infer<TInput>, z.infer<TOutput>>>;
    addHook(hookEvent: 'created', hookFn: HookCreatedFunction, priority?: number): Promise<this>;
    addHook(hookEvent: 'beforeRender', hookFn: HookBeforeRenderFunction, priority?: number): this;
    addHook(hookEvent: 'afterRender', hookFn: HookAfterRenderFunction, priority?: number): this;
    addHook(hookEvent: 'fallback', hookFn: HookFallbackFunction, priority?: number): this;
    getSessionController(ctx: LambderRenderContext<any> | LambderSessionRenderContext<any, TSessionData>): LambderSessionController<TSessionData>;
    getResponseBuilder(): LambderResponseBuilder<any>;
    private getResolver;
    getHandler(): (event: APIGatewayProxyEvent, context: Context) => Promise<LambderResolverResponse>;
    render(event: APIGatewayProxyEvent, lambdaContext: Context): Promise<LambderResolverResponse>;
}
export {};

import type { APIGatewayProxyEvent, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder, { LambderResolverResponse } from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
import { type LambderSessionContext } from "./LambderSessionManager.js";
import LambderSessionController from "./LambderSessionController.js";
import type { ApiContractShape } from "./LambderApiContract.js";
type Path = `/${string}`;
export type LambderRenderContext<TApiPayload = any> = {
    host: string;
    path: string;
    pathParams: Record<string, any> | null;
    method: string;
    get: Record<string, any>;
    post: Record<string, any>;
    cookie: Record<string, any>;
    apiName: string;
    apiPayload: TApiPayload;
    headers: APIGatewayProxyEventHeaders;
    session: LambderSessionContext | null;
    event: APIGatewayProxyEvent;
    lambdaContext: Context;
    _otherInternal: {
        isApiCall: boolean;
        setHeaderFnAccumulator: {
            key: string;
            value: string | string[];
        }[];
        addHeaderFnAccumulator: {
            key: string;
            value: string;
        }[];
        logToApiResponseAccumulator: any[];
    };
};
type LambderModuleFunction = (lambderInstance: Lambder) => void | Promise<void>;
type ConditionFunction = (ctx: LambderRenderContext<any>) => boolean;
type ActionFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse | Promise<LambderResolverResponse>;
type HookCreatedFunction = (lambderInstance: Lambder) => Promise<void>;
type HookBeforeRenderFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderRenderContext<any> | Error | Promise<LambderRenderContext<any> | Error>;
type HookAfterRenderFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver, response: LambderResolverResponse) => LambderResolverResponse | Error | Promise<LambderResolverResponse | Error>;
type HookFallbackFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => void | Promise<void>;
type GlobalErrorHandlerFunction = (err: Error, ctx: LambderRenderContext<any> | null, response: LambderResponseBuilder, logListToApiResponse?: any[]) => LambderResolverResponse | Promise<LambderResolverResponse>;
type RouteFallbackHandlerFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse;
type ApiFallbackHandlerFunction = (ctx: LambderRenderContext<any>, resolver: LambderResolver) => LambderResolverResponse;
export declare const createContext: (event: APIGatewayProxyEvent, lambdaContext: Context, apiPath: string) => LambderRenderContext<any>;
export default class Lambder<TContract extends ApiContractShape = any> {
    apiPath: string;
    apiVersion: null | string;
    isCorsEnabled: boolean;
    publicPath: string;
    ejsPath: string;
    private actionList;
    private hookList;
    private globalErrorHandler;
    private routeFallbackHandler;
    private apiFallbackHandler;
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
    enableCors(isCorsEnabled: boolean): void;
    enableDdbSession({ tableName, tableRegion, sessionSalt, enableSlidingExpiration }: {
        tableName: string;
        tableRegion: string;
        sessionSalt: string;
        enableSlidingExpiration?: boolean;
    }, { partitionKey, sortKey }?: {
        partitionKey: string;
        sortKey: string;
    }): void;
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): void;
    setRouteFallbackHandler(routeFallbackHandler: RouteFallbackHandlerFunction): void;
    setApiFallbackHandler(apiFallbackHandler: ApiFallbackHandlerFunction): void;
    setGlobalErrorHandler(globalErrorHandler: GlobalErrorHandlerFunction): void;
    private getPatternMatch;
    private testPatternMatch;
    private handleNoMatchedAction;
    addModule(moduleFn: LambderModuleFunction): Promise<void>;
    importModule(moduleImport: Promise<{
        default: LambderModuleFunction;
    }>): Promise<void>;
    addRoute(condition: Path | ConditionFunction | RegExp, actionFn: ActionFunction): void;
    addSessionRoute(condition: Path | ConditionFunction | RegExp, actionFn: ActionFunction): void;
    addApi(apiName: ConditionFunction | RegExp, actionFn: ActionFunction): void;
    addApi<TApiName extends keyof TContract & string>(apiName: TApiName, actionFn: (ctx: LambderRenderContext<TContract[TApiName]['input']>, resolver: LambderResolver<TContract, TApiName>) => LambderResolverResponse | Promise<LambderResolverResponse>): void;
    addApi(apiName: string, actionFn: ActionFunction): void;
    addSessionApi(apiName: ConditionFunction | RegExp, actionFn: ActionFunction): void;
    addSessionApi<TApiName extends keyof TContract & string>(apiName: TApiName, actionFn: (ctx: LambderRenderContext<TContract[TApiName]['input']>, resolver: LambderResolver<TContract, TApiName>) => LambderResolverResponse | Promise<LambderResolverResponse>): void;
    addSessionApi(apiName: string, actionFn: ActionFunction): void;
    addHook(hookEvent: 'created', hookFn: HookCreatedFunction, priority?: number): Promise<void>;
    addHook(hookEvent: 'beforeRender', hookFn: HookBeforeRenderFunction, priority?: number): Promise<void>;
    addHook(hookEvent: 'afterRender', hookFn: HookAfterRenderFunction, priority?: number): Promise<void>;
    addHook(hookEvent: 'fallback', hookFn: HookFallbackFunction, priority?: number): Promise<void>;
    getSessionController(ctx: LambderRenderContext<any>): LambderSessionController;
    getResponseBuilder(): LambderResponseBuilder<any>;
    private getResolver;
    render(event: APIGatewayProxyEvent, lambdaContext: Context): Promise<LambderResolverResponse>;
}
export {};

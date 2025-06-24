import type { APIGatewayProxyEvent, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import LambderResolver from "./LambderResolver.js";
import LambderResponseBuilder, { LambderResolverResponse } from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
import { type LambderSessionContext } from "./LambderSessionManager.js";
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
type ConditionFunction = (ctx: LambderRenderContext) => boolean;
type ActionFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => LambderResolverResponse | Promise<LambderResolverResponse>;
type HookCreatedFunction = (lambderInstance: Lambder) => Promise<void>;
type HookBeforeRenderFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => LambderRenderContext | Error | Promise<LambderRenderContext | Error>;
type HookAfterRenderFunction = (ctx: LambderRenderContext, resolver: LambderResolver, response: LambderResolverResponse) => LambderResolverResponse | Error | Promise<LambderResolverResponse | Error>;
type HookFallbackFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => void | Promise<void>;
type GlobalErrorHandlerFunction = (err: Error, ctx: LambderRenderContext | null, response: LambderResponseBuilder, logListToApiResponse?: any[]) => LambderResolverResponse | Promise<LambderResolverResponse>;
type RouteFallbackHandlerFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => LambderResolverResponse;
type ApiFallbackHandlerFunction = (ctx: LambderRenderContext, resolver: LambderResolver) => LambderResolverResponse;
export declare const createContext: (event: APIGatewayProxyEvent, lambdaContext: Context, apiPath: string) => LambderRenderContext;
export default class Lambder {
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
    enableDdbSession({ tableName, tableRegion, sessionSalt }: {
        tableName: string;
        tableRegion: string;
        sessionSalt: string;
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
    addApi(apiName: string | ConditionFunction | RegExp, actionFn: ActionFunction): void;
    addSessionApi(apiName: string | ConditionFunction | RegExp, actionFn: ActionFunction): void;
    addHook(hookEvent: 'created', hookFn: HookCreatedFunction, priority?: number): Promise<void>;
    addHook(hookEvent: 'beforeRender', hookFn: HookBeforeRenderFunction, priority?: number): Promise<void>;
    addHook(hookEvent: 'afterRender', hookFn: HookAfterRenderFunction, priority?: number): Promise<void>;
    addHook(hookEvent: 'fallback', hookFn: HookFallbackFunction, priority?: number): Promise<void>;
    getSessionController(ctx: LambderRenderContext): LambderSessionController;
    getResponseBuilder(): LambderResponseBuilder;
    private getResolver;
    render(event: APIGatewayProxyEvent, lambdaContext: Context): Promise<LambderResolverResponse>;
}
export {};

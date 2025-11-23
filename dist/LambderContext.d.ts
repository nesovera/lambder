import type { APIGatewayProxyEvent, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import type { LambderSessionContext } from "./LambderSessionManager.js";
export type LambderRenderContext<TApiPayload = any> = {
    host: string;
    path: string;
    pathParams: Record<string, any> | null;
    method: string;
    get: Record<string, any>;
    post: Record<string, any>;
    cookie: Record<string, any>;
    session: null;
    apiName: string;
    apiPayload: TApiPayload;
    headers: APIGatewayProxyEventHeaders;
    event: APIGatewayProxyEvent;
    lambdaContext: Context;
    _otherInternal: {
        isApiCall: boolean;
        requestVersion: string | null;
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
export type LambderSessionRenderContext<TApiPayload = any, SessionData = any> = Omit<LambderRenderContext<TApiPayload>, 'session'> & {
    session: LambderSessionContext<SessionData>;
};
export declare const createContext: (event: APIGatewayProxyEvent, lambdaContext: Context, apiPath: string) => LambderRenderContext<any>;

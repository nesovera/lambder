import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import type { LambderSessionContext } from "./LambderSessionManager.js";
import type { LambderHttpEventFormat } from "./LambderResponse.js";
export type LambderHttpEvent = APIGatewayProxyEvent | APIGatewayProxyEventV2;
/** True for API Gateway HTTP API / Lambda Function URL (payload v2) events. */
export declare const isV2HttpEvent: (event: unknown) => event is APIGatewayProxyEventV2;
export type LambderRenderContext<TApiPayload = any, TPathParams extends Record<string, string> = Record<string, string>> = {
    host: string;
    path: string;
    pathParams: TPathParams;
    method: string;
    get: Record<string, string | undefined>;
    post: Record<string, any>;
    cookie: Record<string, string>;
    session: null;
    apiName: string | null;
    apiPayload: TApiPayload;
    headers: APIGatewayProxyEventHeaders;
    /** Decoded request body, exactly as received (e.g. for webhook signature verification). */
    rawBody: string;
    /** Client IP: CF-Connecting-IP, then X-Forwarded-For, then the API Gateway source IP. */
    ip: string;
    /** Case-insensitive request header lookup. */
    header: (name: string) => string | undefined;
    event: LambderHttpEvent;
    lambdaContext: Context;
    _otherInternal: {
        isApiCall: boolean;
        requestVersion: string | null;
        eventFormat: LambderHttpEventFormat;
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
export type LambderSessionRenderContext<TApiPayload = any, SessionData = any, TPathParams extends Record<string, string> = Record<string, string>> = Omit<LambderRenderContext<TApiPayload, TPathParams>, 'session'> & {
    session: LambderSessionContext<SessionData>;
};
export declare const createContext: (event: LambderHttpEvent, lambdaContext: Context, apiPath: string) => LambderRenderContext;

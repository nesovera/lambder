import cookieParser from "cookie";
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import type { LambderSessionContext } from "./LambderSessionManager.js";
import type { LambderHttpEventFormat } from "./LambderResponse.js";

export type LambderHttpEvent = APIGatewayProxyEvent | APIGatewayProxyEventV2;

/** True for API Gateway HTTP API / Lambda Function URL (payload v2) events. */
export const isV2HttpEvent = (event: unknown): event is APIGatewayProxyEventV2 =>
    !!event && typeof event === "object"
    && (event as APIGatewayProxyEventV2).version === "2.0"
    && !!(event as APIGatewayProxyEventV2).requestContext?.http;

export type LambderRenderContext<
    TApiPayload = any,
    TPathParams extends Record<string, string> = Record<string, string>,
> = {
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
        isApiCall: boolean,
        requestVersion: string | null;
        eventFormat: LambderHttpEventFormat;
        setHeaderFnAccumulator: { key: string, value: string | string[] }[];
        addHeaderFnAccumulator: { key: string, value: string }[];
        logToApiResponseAccumulator: any[];
    };
};

export type LambderSessionRenderContext<
    TApiPayload = any,
    SessionData = any,
    TPathParams extends Record<string, string> = Record<string, string>,
> = Omit<LambderRenderContext<TApiPayload, TPathParams>, 'session'> & { session: LambderSessionContext<SessionData> };

export const createContext = (
    event: LambderHttpEvent,
    lambdaContext: Context,
    apiPath: string,
): LambderRenderContext => {
    // Normalize the two API Gateway payload formats into one shape.
    const eventFormat: LambderHttpEventFormat = isV2HttpEvent(event) ? "v2" : "v1";
    let host: string;
    let path: string;
    let method: string;
    let get: Record<string, string | undefined>;
    let cookieHeader: string;
    let sourceIp: string;
    const headers: APIGatewayProxyEventHeaders = event.headers ?? {};

    if(isV2HttpEvent(event)){
        host = headers.host || event.requestContext.domainName || "";
        path = event.rawPath;
        method = event.requestContext.http.method;
        get = {};
        for(const [key, value] of new URLSearchParams(event.rawQueryString ?? "").entries()){
            get[key] = value;
        }
        cookieHeader = (event.cookies ?? []).join("; ");
        sourceIp = event.requestContext.http.sourceIp || "";
    }else{
        host = headers.Host || headers.host || "";
        path = event.path;
        method = event.httpMethod;
        get = event.queryStringParameters || {};
        cookieHeader = headers.Cookie || headers.cookie || "";
        sourceIp = event.requestContext?.identity?.sourceIp || "";
    }

    const cookie = cookieParser.parse(cookieHeader) as Record<string, string>;

    const lowercasedHeaders: Record<string, string> = {};
    for(const [key, value] of Object.entries(headers)){
        if(value !== undefined) lowercasedHeaders[key.toLowerCase()] = value;
    }
    const header = (name: string): string | undefined => lowercasedHeaders[name.toLowerCase()];

    const forwardedFor = lowercasedHeaders["x-forwarded-for"];
    const ip = lowercasedHeaders["cf-connecting-ip"]
        || (forwardedFor ? (forwardedFor.split(",")[0] ?? "").trim() : "")
        || sourceIp
        || "";

    // Decode body: keep the raw string, then parse as JSON with urlencoded fallback.
    let rawBody = "";
    let post: Record<string, any> = {};
    try {
        rawBody = event.isBase64Encoded
            ? (event.body ? Buffer.from(event.body, "base64").toString() : "")
            : (event.body || "");
        try { post = JSON.parse(rawBody || "{}") || {}; }
        catch(e){
            const params = new URLSearchParams(rawBody);
            post = {};
            for(const [key, value] of params.entries()){
                post[key] = value;
            }
        }
    }catch(e){}

    const isApiCall = !!(method === "POST" && apiPath && path === apiPath && post.apiName);
    const apiName: string | null = isApiCall ? post.apiName : null;
    const apiPayload: any = isApiCall ? post.payload : null;
    const requestVersion: string | null = isApiCall ? (post.version ?? null) : null;

    return {
        host, path, pathParams: {}, method,
        get, post, cookie, event,
        session: null,
        apiName, apiPayload,
        headers, rawBody, ip, header,
        lambdaContext,
        _otherInternal: {
            isApiCall, requestVersion, eventFormat,
            setHeaderFnAccumulator: [],
            addHeaderFnAccumulator: [],
            logToApiResponseAccumulator: [],
        }
    };
}

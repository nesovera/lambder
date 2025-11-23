import cookieParser from "cookie";
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
        isApiCall: boolean,
        requestVersion: string|null;
        setHeaderFnAccumulator: { key:string, value:string|string[] }[];
        addHeaderFnAccumulator: { key:string, value:string }[];
        logToApiResponseAccumulator: any[];
    };
};

export type LambderSessionRenderContext<
    TApiPayload = any, SessionData = any
> = Omit<LambderRenderContext<TApiPayload>, 'session'> & { session: LambderSessionContext<SessionData> };

export const createContext = (
    event: APIGatewayProxyEvent, 
    lambdaContext: Context,
    apiPath: string,
):LambderRenderContext<any> => {
    const host = event.headers.Host || event.headers.host || "";
    const path = event.path;
    const pathParams = null;
    const get: Record<string, any> = event.queryStringParameters || {};
    const method = event.httpMethod;
    const cookie = cookieParser.parse(event.headers.Cookie || event.headers.cookie || "");
    const headers = event.headers;
    
    // Decode body for the post
    let post: Record<string, any> = {};
    try {
        const decodedBody = event.isBase64Encoded ? ( event.body ? Buffer.from(event.body,"base64").toString() : "{}" ) : ( event.body || "{}" );
        try { post = JSON.parse(decodedBody) || {}; }
        catch(e){ 
            const params = new URLSearchParams(decodedBody);
            post = {};
            for(const [key, value] of params.entries()){
                post[key] = value;
            }
        }
    }catch(e){}
    // Parse api variables

    const isApiCall = method === "POST" && apiPath && path === apiPath && post.apiName;
    const apiName:string = isApiCall ? post.apiName : null;
    const apiPayload:string = isApiCall ? post.payload : null;
    const requestVersion:string = isApiCall ? post.version : null;

    return { 
        host, path, pathParams, method, 
        get, post, cookie, event,
        session: null,
        apiName, apiPayload, 
        headers, lambdaContext, 
        _otherInternal: { 
            isApiCall, requestVersion,
            setHeaderFnAccumulator: [], 
            addHeaderFnAccumulator: [], 
            logToApiResponseAccumulator: [], 
        } 
    };
}

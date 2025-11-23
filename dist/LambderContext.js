import cookieParser from "cookie";
export const createContext = (event, lambdaContext, apiPath) => {
    const host = event.headers.Host || event.headers.host || "";
    const path = event.path;
    const pathParams = null;
    const get = event.queryStringParameters || {};
    const method = event.httpMethod;
    const cookie = cookieParser.parse(event.headers.Cookie || event.headers.cookie || "");
    const headers = event.headers;
    // Decode body for the post
    let post = {};
    try {
        const decodedBody = event.isBase64Encoded ? (event.body ? Buffer.from(event.body, "base64").toString() : "{}") : (event.body || "{}");
        try {
            post = JSON.parse(decodedBody) || {};
        }
        catch (e) {
            const params = new URLSearchParams(decodedBody);
            post = {};
            for (const [key, value] of params.entries()) {
                post[key] = value;
            }
        }
    }
    catch (e) { }
    // Parse api variables
    const isApiCall = method === "POST" && apiPath && path === apiPath && post.apiName;
    const apiName = isApiCall ? post.apiName : null;
    const apiPayload = isApiCall ? post.payload : null;
    const requestVersion = isApiCall ? post.version : null;
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
};

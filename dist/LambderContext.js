import cookieParser from "cookie";
/** True for API Gateway HTTP API / Lambda Function URL (payload v2) events. */
export const isV2HttpEvent = (event) => !!event && typeof event === "object"
    && event.version === "2.0"
    && !!event.requestContext?.http;
export const createContext = (event, lambdaContext, apiPath) => {
    // Normalize the two API Gateway payload formats into one shape.
    const eventFormat = isV2HttpEvent(event) ? "v2" : "v1";
    let host;
    let path;
    let method;
    let get;
    let cookieHeader;
    let sourceIp;
    const headers = event.headers ?? {};
    if (isV2HttpEvent(event)) {
        host = headers.host || event.requestContext.domainName || "";
        path = event.rawPath;
        // Named stages (non-$default) are included in rawPath; v1 strips them.
        const stage = event.requestContext.stage;
        if (stage && stage !== "$default" && (path === `/${stage}` || path.startsWith(`/${stage}/`))) {
            path = path.slice(stage.length + 1) || "/";
        }
        method = event.requestContext.http.method;
        get = {};
        for (const [key, value] of new URLSearchParams(event.rawQueryString ?? "").entries()) {
            get[key] = value;
        }
        cookieHeader = (event.cookies ?? []).join("; ");
        sourceIp = event.requestContext.http.sourceIp || "";
    }
    else {
        host = headers.Host || headers.host || "";
        path = event.path;
        method = event.httpMethod;
        get = event.queryStringParameters || {};
        cookieHeader = headers.Cookie || headers.cookie || "";
        sourceIp = event.requestContext?.identity?.sourceIp || "";
    }
    const cookie = cookieParser.parse(cookieHeader);
    const lowercasedHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined)
            lowercasedHeaders[key.toLowerCase()] = value;
    }
    const header = (name) => lowercasedHeaders[name.toLowerCase()];
    const forwardedFor = lowercasedHeaders["x-forwarded-for"];
    const ip = lowercasedHeaders["cf-connecting-ip"]
        || (forwardedFor ? (forwardedFor.split(",")[0] ?? "").trim() : "")
        || sourceIp
        || "";
    // Decode body: keep the raw string, then parse as JSON with urlencoded fallback.
    let rawBody = "";
    let post = {};
    try {
        rawBody = event.isBase64Encoded
            ? (event.body ? Buffer.from(event.body, "base64").toString() : "")
            : (event.body || "");
        try {
            post = JSON.parse(rawBody || "{}") || {};
        }
        catch (e) {
            const params = new URLSearchParams(rawBody);
            post = {};
            for (const [key, value] of params.entries()) {
                post[key] = value;
            }
        }
    }
    catch (e) { }
    const isApiCall = !!(method === "POST" && apiPath && path === apiPath && post.apiName);
    const apiName = isApiCall ? post.apiName : null;
    const apiPayload = isApiCall ? post.payload : null;
    const requestVersion = isApiCall ? (post.version ?? null) : null;
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
};

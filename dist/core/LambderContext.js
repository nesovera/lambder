import { readApiEnvelope, cookieValuesByName, lowercaseHeaderNames } from "../api/LambderApiRequest.js";
import { resolveClientIp } from "../shared/util/LambderClientIp.js";
import { base64ToText } from "../shared/util/LambderBase64.js";
import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
/** True for API Gateway HTTP API / Lambda Function URL (payload v2) events. */
export const isV2HttpEvent = (event) => !!event && typeof event === "object"
    && event.version === "2.0"
    && !!event.requestContext?.http;
/** The render context for one request: everything a route handler, an API handler, a hook or a guard reads about it, built once from the Lambda event. */
export const createContext = (event, lambdaContext, apiPath, trustedClientIpHeaders = []) => {
    // Normalize the two API Gateway payload formats into one shape.
    const eventFormat = isV2HttpEvent(event) ? "v2" : "v1";
    let host;
    let path;
    let method;
    let get;
    let cookiePairs;
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
        // v2 delivers the Cookie header pre-split into name=value pairs.
        cookiePairs = event.cookies ?? [];
        sourceIp = event.requestContext.http.sourceIp || "";
    }
    else {
        host = headers.Host || headers.host || "";
        path = event.path;
        method = event.httpMethod;
        get = event.queryStringParameters || {};
        // A REST API keeps only the LAST value of a repeated header in
        // `headers` and every value in `multiValueHeaders`, and HTTP/2 lets a
        // client split its cookies across several Cookie headers. The session
        // layer weighs every copy of a cookie name, so dropping one is
        // dropping a candidate session; v2's `event.cookies` already carries
        // them all.
        const cookieHeaders = event.multiValueHeaders?.Cookie ?? event.multiValueHeaders?.cookie;
        cookiePairs = (cookieHeaders?.length ? cookieHeaders.join("; ") : (headers.Cookie || headers.cookie || "")).split(";");
        sourceIp = event.requestContext?.identity?.sourceIp || "";
    }
    const cookieList = cookieValuesByName(cookiePairs);
    const cookie = Object.create(null);
    for (const [name, values] of Object.entries(cookieList))
        cookie[name] = values[0];
    const lowercasedHeaders = lowercaseHeaderNames(headers);
    const header = (name) => lowercasedHeaders[name.toLowerCase()];
    const ip = resolveClientIp(lowercasedHeaders, sourceIp, trustedClientIpHeaders);
    // Decode body: keep the raw string, then parse as JSON with urlencoded fallback.
    const rawBody = event.isBase64Encoded
        ? (event.body ? base64ToText(event.body) : "")
        : (event.body || "");
    let post = {};
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
    // A POST to the API path whose body names an API is an API call; the
    // core reads the envelope, and everything downstream reads ctx.api.
    const api = method === "POST" && !!apiPath && path === apiPath
        ? readApiEnvelope(post, { headers: lowercasedHeaders, cookies: cookieList, ip, host })
        : null;
    return {
        host, path, pathParams: {}, method,
        get, post, cookie, cookieList, event,
        session: null,
        api,
        apiName: api?.apiName ?? null,
        apiPayload: api ? api.payload : null,
        guardData: {},
        headers, rawBody, ip, header,
        lambdaContext,
        eventFormat,
        responseHeaders: new LambderAnswerHeaders(),
        logList: [],
    };
};

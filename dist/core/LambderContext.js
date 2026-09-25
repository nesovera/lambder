import { readApiEnvelope, cookieValuesByName, isApiCallContentType, lowercaseHeaderNames } from "../api/LambderApiRequest.js";
import { resolveClientIp } from "../shared/util/LambderClientIp.js";
import { base64ToText } from "../shared/util/LambderBase64.js";
import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
import { DEFAULT_API_PATH } from "../shared/wire/LambderDefaultApiPath.js";
import { LAMBDER_INVOKE_API_ID, LAMBDER_LOCAL_API_ID } from "../shared/wire/LambderInvokeApiId.js";
import { bindCallTools } from "../api/LambderApiCallContext.js";
import { decodeRequestPath } from "./LambderRequestPath.js";
/** True for API Gateway HTTP API / Lambda Function URL (payload v2) events. */
export const isV2HttpEvent = (event) => !!event && typeof event === "object"
    && event.version === "2.0"
    && !!event.requestContext?.http;
/**
 * Puts one instance's tools onto a context, bound to that very object, so
 * what they read (the session, the ip, which API the call is) is the
 * context's own. Bound through bindCallTools, as the mock's are, and bound
 * again by the instance on whatever context a beforeRender hook hands back.
 */
export const bindContextTools = (ctx, tools) => {
    const bound = ctx;
    bindCallTools(bound, {
        getters: { sessionController: () => tools.sessionControllerFor(bound) },
        methods: {
            rateLimit: async (policy, key) => { await tools.chargeRateLimit(bound, policy, key, true); },
            isRateLimited: (policy, key) => tools.chargeRateLimit(bound, policy, key, false),
        },
    });
    return bound;
};
/**
 * The tools of a context no instance renders: one createContext() built from
 * an event on its own. Touching one says what is missing instead of failing
 * on an undefined member.
 */
const unboundTool = (member) => () => {
    throw new Error(`Lambder: ctx.${member} is bound by the Lambder instance rendering the request, and this context was built by createContext() alone. Use lambder.getSessionController(ctx) for its session controller.`);
};
const UNBOUND_CONTEXT_TOOLS = {
    sessionControllerFor: unboundTool("sessionController"),
    chargeRateLimit: unboundTool("rateLimit"),
};
/**
 * A Function URL's own domain, `<url-id>.lambda-url.<region>.on.aws`, which
 * its events always carry: the URL answers no other Host, so CloudFront in
 * front of one sends it this one too. Every other gateway's v2 event is an
 * HTTP API's, custom domains included.
 *
 * Asked of a gateway's event only. An event Lambder synthesized (an invoke,
 * lambder/testing, the handler transport) carries one of Lambder's own
 * apiIds and its path decoded, and names whatever host its caller chose,
 * this domain included.
 */
const FUNCTION_URL_DOMAIN = /\.lambda-url\.[a-z0-9-]+\.on\.aws$/i;
/** A value a Host header may carry: a name or an address, and a port. Anything else from a forwarded header is not taken as the host. */
const HOST_VALUE_PATTERN = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
/**
 * The path without a named stage's prefix. An HTTP API keeps the stage in
 * the path it delivers, in either payload format (`/prod/orders` on stage
 * `prod`), where a REST API strips it first; `$default` is never in it.
 */
const withoutStagePrefix = (path, stage) => stage && stage !== "$default" && (path === `/${stage}` || path.startsWith(`/${stage}/`))
    ? path.slice(stage.length + 1) || "/"
    : path;
/** The render context for one request: everything a route handler, an API handler, a hook or a guard reads about it, built once from the Lambda event. */
export const createContext = (event, lambdaContext, { apiPath = DEFAULT_API_PATH, trustedClientIpHeaders = [], trustedHostHeaders = [] } = {}) => {
    // Normalize the two API Gateway payload formats into one shape.
    const eventFormat = isV2HttpEvent(event) ? "v2" : "v1";
    let host;
    let rawPath;
    // An HTTP API delivers the path decoded, in either payload format, and so
    // does Lambder's own 2.0 event builder; a REST API and a Function URL
    // deliver it as the viewer sent it.
    let pathAlreadyDecoded = false;
    let method;
    let get;
    let cookiePairs;
    let sourceIp;
    const headers = event.headers ?? {};
    if (isV2HttpEvent(event)) {
        host = headers.host || event.requestContext.domainName || "";
        const apiId = event.requestContext.apiId;
        pathAlreadyDecoded = apiId === LAMBDER_INVOKE_API_ID || apiId === LAMBDER_LOCAL_API_ID
            || !FUNCTION_URL_DOMAIN.test(event.requestContext.domainName ?? "");
        rawPath = withoutStagePrefix(event.rawPath, event.requestContext.stage);
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
        rawPath = event.path;
        // An HTTP API sending payload format 1.0 marks it `version: "1.0"`;
        // a REST API's event carries no version. Read as a REST API's, the
        // decoded path would be decoded a second time: `/%2561dmin`, handed
        // over as `/%61dmin`, would reach `/admin` past whatever authorizer
        // guarded that route at the gateway.
        if (event.version === "1.0") {
            pathAlreadyDecoded = true;
            rawPath = withoutStagePrefix(event.path, event.requestContext?.stage);
        }
        method = event.httpMethod;
        get = event.queryStringParameters || {};
        // A REST API keeps only the LAST value of a repeated header in
        // `headers` and every value in `multiValueHeaders`, and HTTP/2 lets a
        // client split its cookies across several Cookie headers. The session
        // layer weighs every copy of a cookie name, so dropping one drops a
        // candidate session (v2's `event.cookies` carries them all).
        const cookieHeaders = event.multiValueHeaders?.Cookie ?? event.multiValueHeaders?.cookie;
        cookiePairs = (cookieHeaders?.length ? cookieHeaders.join("; ") : (headers.Cookie || headers.cookie || "")).split(";");
        sourceIp = event.requestContext?.identity?.sourceIp || "";
    }
    const path = decodeRequestPath(rawPath, pathAlreadyDecoded);
    const cookieList = cookieValuesByName(cookiePairs);
    const cookie = Object.create(null);
    for (const [name, values] of Object.entries(cookieList))
        cookie[name] = values[0];
    const lowercasedHeaders = lowercaseHeaderNames(headers);
    const header = (name) => lowercasedHeaders[name.toLowerCase()];
    // A trusted forwarding header is trusted because a proxy in front of this
    // function writes it. A direct invoke has no such proxy: its headers are
    // whatever the invoking code passed on, and a gateway lambda forwarding a
    // browser's request passes on the browser's own. So on an invoke the
    // address and the host are the ones the invoker named (clientIp and host,
    // delivered as sourceIp and Host), and no header is read for either.
    const invokedDirectly = event.requestContext?.apiId === LAMBDER_INVOKE_API_ID;
    // The first trusted header carrying a well-formed host, leftmost entry,
    // else the host the gateway saw. Behind CloudFront a Function URL sees
    // its own lambda-url domain, since CloudFront sends an origin its own
    // Host, so cookie domains and host routing need the viewer's host from a
    // header the distribution writes.
    for (const name of invokedDirectly ? [] : trustedHostHeaders) {
        const forwarded = (lowercasedHeaders[name.toLowerCase()] ?? "").split(",")[0].trim();
        if (HOST_VALUE_PATTERN.test(forwarded)) {
            host = forwarded;
            break;
        }
    }
    const ip = resolveClientIp(lowercasedHeaders, sourceIp, invokedDirectly ? [] : trustedClientIpHeaders);
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
    // A JSON POST to the API path whose body names an API is an API call;
    // the core reads the envelope, and everything downstream reads ctx.api.
    // JSON only (isApiCallContentType): any site can submit a plain HTML form
    // to this path, and enctype="text/plain" lays out a JSON body exactly.
    const api = method === "POST" && !!apiPath && path === apiPath && isApiCallContentType(lowercasedHeaders)
        ? readApiEnvelope(post, { headers: lowercasedHeaders, cookies: cookieList, ip, host })
        : null;
    return bindContextTools({
        host, path, rawPath, pathParams: {}, method,
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
    }, UNBOUND_CONTEXT_TOOLS);
};

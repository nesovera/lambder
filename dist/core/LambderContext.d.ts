import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import { type LambderApiRequest } from "../api/LambderApiRequest.js";
import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
import { type LambderResponseTools } from "../api/LambderApiCallContext.js";
import type LambderSessionController from "../session/LambderSessionController.js";
import type { LambderApiRateLimitPolicyConfig, LambderContextRateLimit, LambderContextRateLimitCheck, LambderRateLimitCheckResult } from "../api/LambderApiRateLimits.js";
import type { LambderAppTypes } from "../api/LambderApiDeclarations.js";
export type LambderHttpEvent = APIGatewayProxyEvent | APIGatewayProxyEventV2;
/**
 * Which API Gateway payload format an event arrived in, and the format its
 * response leaves in. Declared here, beside the detection it comes from,
 * rather than beside LambderResponse's emitters that read it: there, the two
 * core modules would import each other.
 */
export type LambderHttpEventFormat = "v1" | "v2";
/** True for API Gateway HTTP API / Lambda Function URL (payload v2) events. */
export declare const isV2HttpEvent: (event: unknown) => event is APIGatewayProxyEventV2;
/**
 * How a request reached the function, as `ctx.arrivedVia` says it:
 * - "proxy": over HTTP, carrying a valid `originProof`, so it came through
 *   the proxy in front of the app;
 * - "direct": over HTTP without a valid proof, sent to the gateway's own
 *   address (an `execute-api` or `lambda-url` domain) rather than through the
 *   proxy, so the proxy's headers on it are whatever its sender wrote and
 *   have been taken off;
 * - "invoke": a Lambda invoke, told by the event's `requestContext.apiId`,
 *   which a gateway writes itself and no HTTP client can set, so only a
 *   caller IAM let invoke the function sends one;
 * - "unverified": over HTTP on an instance with no `originProof`, where
 *   nothing tells a proxied request from a direct one.
 */
export type LambderRequestArrival = "proxy" | "direct" | "invoke" | "unverified";
/**
 * Everything a route or API handler knows about the request. Extends the
 * API core's call context (session, guardData, responseHeaders, logList),
 * which is the part the pipeline and the session controller work on; the
 * rest is the HTTP request as the Lambda event delivered it, plus the tools
 * the instance rendering it binds on (sessionController, rateLimit, isRateLimited)
 * and the response tools (setResponseHeader, addResponseHeader, setCookie,
 * clearCookie) that write onto whatever answer the request ends with.
 *
 * TRateLimitPolicies is the app's policies map on an API handler (defineApi)
 * and on a route registered by a path string (addRoute, addSessionRoute), so
 * a policy name is checked where it is charged; anywhere else (a route
 * matched by a RegExp, a predicate or a matcher object, a hook, a guard) the
 * names are any string. LambderRenderContextOf names the typed form for a
 * helper that takes one instance's context.
 */
export type LambderRenderContext<TApiPayload = any, TPathParams extends Record<string, string> = Record<string, string>, TGuardData = {}, TSessionData = any, TRateLimitPolicies = Record<string, LambderApiRateLimitPolicyConfig>> = {
    /**
     * The Host the gateway received, or the first header named in
     * `trustedHostHeaders` that carries a well-formed host. On a Lambda
     * invoke, the invoking caller's `host`, whatever headers it forwarded.
     */
    host: string;
    /**
     * The request path, decoded exactly once whichever gateway delivered it
     * (a REST API and a Function URL deliver it encoded, an HTTP API
     * decoded, in either payload format), with two escapes kept: a slash inside a segment stays `%2F`,
     * so it cannot become a separator, and a percent sign stays `%25`, so no
     * decoded text passes for an escape. What routes match and files are
     * looked up by (see LambderRequestPath).
     */
    path: string;
    /** The path as the gateway delivered it, stage stripped: encoded or not, depending on the gateway. */
    rawPath: string;
    pathParams: TPathParams;
    method: string;
    get: Record<string, string | undefined>;
    post: Record<string, unknown>;
    /** Cookies by name (the first value when a name arrived more than once; see cookieList). */
    cookie: Record<string, string>;
    /**
     * Every value the request carried per cookie name, in header order. A
     * name normally maps to one value; several arrive when the browser holds
     * that name at more than one scope (host-only beside Domain=, or two
     * paths), typically after a cookie's Domain or Path was changed. The
     * browser's order says nothing about which copy is current.
     */
    cookieList: Record<string, string[]>;
    /**
     * The session, once something read or created one: the pipeline sets it
     * on a session API, and ctx.sessionController.createSession writes it here too.
     * Null everywhere else, which is why a route or public API reads it as
     * `ctx.session?.data`. Not typed as the literal `null`, since
     * createSession fills it and addSessionRoute hands the handler this same
     * object.
     */
    session: LambderSessionRecord<TSessionData> | null;
    /**
     * The API call this request is, as the core sees it, or null for a
     * route. Carries the envelope's fields (name, version, CSRF token,
     * payload, guard inputs, idempotency key) and the request's headers,
     * cookies, ip and host.
     */
    api: LambderApiRequest | null;
    /** The API name, or null for a route (api.apiName). */
    apiName: string | null;
    /** The API payload: as posted until validation, the parsed value inside the handler. */
    apiPayload: TApiPayload;
    /**
     * Outputs of this API's guards, keyed by guard name. Only guards the API
     * declares AND that return a value appear (typed via the declarative
     * guards option); void guards never do.
     */
    guardData: TGuardData;
    headers: APIGatewayProxyEventHeaders;
    /** Decoded request body, exactly as received (e.g. for webhook signature verification). */
    rawBody: string;
    /**
     * The address the gateway observed, or the leftmost entry of the first
     * header named in `trustedClientIpHeaders` that carries one; nothing is
     * trusted by default, and no header on a Lambda invoke, whose address is
     * the invoking caller's `clientIp`. One spelling per address (port and brackets
     * stripped, lowercased, length-bounded), so a `per: "ip"` limit keys one
     * counter per client.
     */
    ip: string;
    /** Case-insensitive request header lookup. */
    header: (name: string) => string | undefined;
    event: LambderHttpEvent;
    lambdaContext: Context;
    /** Which API Gateway payload format the event arrived in, and the response leaves in. */
    eventFormat: LambderHttpEventFormat;
    /**
     * How the request reached the function (see LambderRequestArrival):
     * through the proxy with a valid `originProof`, without it, by a
     * Lambda invoke, or, with no `originProof` configured, unverified.
     */
    readonly arrivedVia: LambderRequestArrival;
    /** Response headers written during the request (the response tools below, session cookies), applied onto the response at the end. */
    responseHeaders: LambderAnswerHeaders;
    /** Entries for the API envelope's logList channel: a handler pushes what it wants the caller's debug log to show. */
    logList: unknown[];
    /**
     * Sessions for this request: read the one it carries
     * (fetchSessionIfExists), create, rotate, refresh and end them. An API
     * call presents its posted CSRF token and a route its cookies alone, the
     * same controller `lambder.getSessionController(ctx)` hands out. Throws
     * when the instance was created without the session option.
     */
    sessionController: LambderSessionController<TSessionData>;
    /**
     * Counts one attempt against a named rate-limit policy and refuses the
     * request when it is over: a 429 envelope on an API call, a plain 429 on
     * a route, with Retry-After and the policy's refusal either way. A
     * policy without `per` takes the key as the second argument; a `per:
     * "ip"` or `per: "session"` one reads it off the request. The instance's
     * limiter, failOpen and key bounding apply, as for a declared limit.
     */
    rateLimit: LambderContextRateLimit<TRateLimitPolicies>;
    /** The same count as rateLimit, answered instead of thrown: false, or the window that refused and its retryAfterSeconds. */
    isRateLimited: LambderContextRateLimitCheck<TRateLimitPolicies>;
} & LambderResponseTools;
export type LambderSessionRenderContext<TApiPayload = any, SessionData = any, TPathParams extends Record<string, string> = Record<string, string>, TGuardData = {}, TRateLimitPolicies = Record<string, LambderApiRateLimitPolicyConfig>> = Omit<LambderRenderContext<TApiPayload, TPathParams, TGuardData, SessionData, TRateLimitPolicies>, 'session'> & {
    session: LambderSessionRecord<SessionData>;
};
/** What the context helpers below read off an instance: the AppTypes property every instance carries. */
type LambderInstanceTypes = {
    readonly AppTypes: LambderAppTypes;
};
/**
 * One instance's render context, read off `typeof lambderApp`: its session
 * data and its rate-limit policy names, any payload, path parameters and
 * guard data. What a helper in another file takes to be handed a context of
 * that instance, without writing LambderRenderContext's parameters out: an
 * API handler's, a route's, a hook's and a guard's context are each
 * assignable to it.
 */
export type LambderRenderContextOf<TInstance extends LambderInstanceTypes> = LambderRenderContext<any, Record<string, string>, {}, TInstance["AppTypes"]["session"], TInstance["AppTypes"]["policies"]>;
/**
 * LambderRenderContextOf with the session present: what a helper takes to be
 * handed the context of a session route, a session endpoint's handler or a
 * guard that needs a session, each assignable to it.
 */
export type LambderSessionRenderContextOf<TInstance extends LambderInstanceTypes> = LambderSessionRenderContext<any, TInstance["AppTypes"]["session"], Record<string, string>, {}, TInstance["AppTypes"]["policies"]>;
/** The members of a render context that are bound onto it rather than read from its event. */
type LambderContextToolName = "sessionController" | "rateLimit" | "isRateLimited" | keyof LambderResponseTools;
/** What an instance binds onto each context it renders: see bindContextTools. */
export type LambderContextTools = {
    sessionControllerFor: (ctx: LambderRenderContext) => LambderSessionController<any>;
    /** Charges a policy for ctx; `refuse` throws the refusal when it is over instead of answering the check result. */
    chargeRateLimit: (ctx: LambderRenderContext, policy: string, key: string | undefined, refuse: boolean) => Promise<LambderRateLimitCheckResult>;
};
/**
 * Puts one instance's tools onto a context, bound to that very object, so
 * what they read (the session, the ip, which API the call is) is the
 * context's own. Bound through bindCallTools, as the mock's are, and bound
 * again by the instance on whatever context a beforeRender hook hands back.
 */
export declare const bindContextTools: (ctx: Omit<LambderRenderContext, LambderContextToolName> | LambderRenderContext, tools: LambderContextTools) => LambderRenderContext;
/**
 * Proof that a request came through the proxy in front of the app: a header
 * the proxy sets to a secret on every request it forwards, which a request
 * sent to the origin directly cannot carry. See `originProof` at create().
 */
export type LambderOriginProof = {
    /** The header the proxy sets, such as "x-origin-proof". */
    header: string;
    /** The values it may carry: the current secret, and during a rotation the one before it. */
    secrets: readonly string[];
    /**
     * Headers the proxy writes that the app reads, beside the trusted client
     * address and host headers, such as "cf-ipcountry" or
     * "cloudfront-viewer-country". A request without the proof carries
     * whatever its sender wrote under these names, so they are taken off
     * `ctx.headers` and `ctx.header()` there, as the trusted headers are.
     * Default: none.
     */
    proxyHeaders?: readonly string[];
};
/** What createContext reads a request with: the instance's own settings for where an API call goes and which forwarded headers it trusts. */
export type LambderContextOptions = {
    /** See `apiPath` at create(). Default: "/api", as there. */
    apiPath?: string;
    /** See `trustedClientIpHeaders` at create(). Default: none. */
    trustedClientIpHeaders?: readonly string[];
    /** See `trustedHostHeaders` at create(). Default: none. */
    trustedHostHeaders?: readonly string[];
    /** See `originProof` at create(). Default: none, so the trusted headers are read on every request and `arrivedVia` is "unverified" on all but an invoke. */
    originProof?: LambderOriginProof | null;
};
/** The render context for one request: everything a route handler, an API handler, a hook or a guard reads about it, built once from the Lambda event. */
export declare const createContext: (event: LambderHttpEvent, lambdaContext: Context, { apiPath, trustedClientIpHeaders, trustedHostHeaders, originProof }?: LambderContextOptions) => LambderRenderContext;
export {};

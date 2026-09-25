import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import { type LambderApiRequest } from "../api/LambderApiRequest.js";
import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
import type LambderSessionController from "../session/LambderSessionController.js";
import type { LambderApiRateLimitPolicyConfig, LambderContextRateLimit, LambderContextRateLimitCheck, LambderRateLimitCheckResult } from "../api/LambderApiRateLimits.js";
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
 * Everything a route or API handler knows about the request. Extends the
 * API core's call context (session, guardData, responseHeaders, logList),
 * which is the part the pipeline and the session controller work on; the
 * rest is the HTTP request as the Lambda event delivered it, plus the tools
 * the instance rendering it binds on (sessionController, rateLimit, isRateLimited).
 *
 * TRateLimitPolicies is the app's policies map on a handler registered with
 * addApi, addSessionApi, addRoute or addSessionRoute, so a policy name is
 * checked where it is charged; anywhere else (a hook, a guard) the names are
 * any string.
 */
export type LambderRenderContext<TApiPayload = any, TPathParams extends Record<string, string> = Record<string, string>, TGuardData = {}, TSessionData = any, TRateLimitPolicies = Record<string, LambderApiRateLimitPolicyConfig>> = {
    /**
     * The Host the gateway received, or the first header named in
     * `trustedHostHeaders` that carries a well-formed host. On a direct
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
     * trusted by default, and no header on a direct invoke, whose address is
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
    /** Response headers written during the request (res.setHeader, res.addHeader, session cookies), applied onto the response at the end. */
    responseHeaders: LambderAnswerHeaders;
    /** Entries for the API envelope's logList channel (res.logToApiResponse). */
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
     * a route, with Retry-After and the policy's errorMessage either way. A
     * policy without `per` takes the key as the second argument; a `per:
     * "ip"` or `per: "session"` one reads it off the request. The instance's
     * limiter, failOpen and key bounding apply, as for a declared limit.
     */
    rateLimit: LambderContextRateLimit<TRateLimitPolicies>;
    /** The same count as rateLimit, answered instead of thrown: false, or the window that refused and its retryAfterSeconds. */
    isRateLimited: LambderContextRateLimitCheck<TRateLimitPolicies>;
};
export type LambderSessionRenderContext<TApiPayload = any, SessionData = any, TPathParams extends Record<string, string> = Record<string, string>, TGuardData = {}, TRateLimitPolicies = Record<string, LambderApiRateLimitPolicyConfig>> = Omit<LambderRenderContext<TApiPayload, TPathParams, TGuardData, SessionData, TRateLimitPolicies>, 'session'> & {
    session: LambderSessionRecord<SessionData>;
};
/** The members of a render context that belong to the instance rendering the request rather than to its event. */
type LambderContextToolName = "sessionController" | "rateLimit" | "isRateLimited";
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
/** What createContext reads a request with: the instance's own settings for where an API call goes and which forwarded headers it trusts. */
export type LambderContextOptions = {
    /** See `apiPath` at create(). Default: "/api", as there. */
    apiPath?: string;
    /** See `trustedClientIpHeaders` at create(). Default: none. */
    trustedClientIpHeaders?: readonly string[];
    /** See `trustedHostHeaders` at create(). Default: none. */
    trustedHostHeaders?: readonly string[];
};
/** The render context for one request: everything a route handler, an API handler, a hook or a guard reads about it, built once from the Lambda event. */
export declare const createContext: (event: LambderHttpEvent, lambdaContext: Context, { apiPath, trustedClientIpHeaders, trustedHostHeaders }?: LambderContextOptions) => LambderRenderContext;
export {};

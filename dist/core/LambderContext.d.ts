import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, APIGatewayProxyEventHeaders, Context } from "aws-lambda";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import { type LambderApiRequest } from "../api/LambderApiRequest.js";
import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
export type LambderHttpEvent = APIGatewayProxyEvent | APIGatewayProxyEventV2;
/**
 * Which API Gateway payload format an event arrived in, and the format its
 * response leaves in. Declared here, beside the detection it comes from:
 * LambderResponse holds the emitters that read it, and having the type there
 * as well made the two core modules import each other.
 */
export type LambderHttpEventFormat = "v1" | "v2";
/** True for API Gateway HTTP API / Lambda Function URL (payload v2) events. */
export declare const isV2HttpEvent: (event: unknown) => event is APIGatewayProxyEventV2;
/**
 * Everything a route or API handler knows about the request. Extends the
 * API core's call context (session, guardData, responseHeaders, logList),
 * which is the part the pipeline and the session controller work on; the
 * rest is the HTTP request as the Lambda event delivered it.
 */
export type LambderRenderContext<TApiPayload = any, TPathParams extends Record<string, string> = Record<string, string>, TGuardData = {}, TSessionData = any> = {
    host: string;
    path: string;
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
     * The session, once something read or created one: the pipeline sets it on
     * a session API, and getSessionController(ctx).createSession writes it
     * here too. Null everywhere else, which is why a route or public API reads
     * it as `ctx.session?.data`. Typing it as the literal `null` said the
     * opposite of what the code does: after createSession the field was still
     * `never`, and addSessionRoute needed a double cast to hand the handler
     * the same object it already held.
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
     * trusted by default. One spelling per address (port and brackets
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
};
export type LambderSessionRenderContext<TApiPayload = any, SessionData = any, TPathParams extends Record<string, string> = Record<string, string>, TGuardData = {}> = Omit<LambderRenderContext<TApiPayload, TPathParams, TGuardData, SessionData>, 'session'> & {
    session: LambderSessionRecord<SessionData>;
};
/** The render context for one request: everything a route handler, an API handler, a hook or a guard reads about it, built once from the Lambda event. */
export declare const createContext: (event: LambderHttpEvent, lambdaContext: Context, apiPath: string, trustedClientIpHeaders?: readonly string[]) => LambderRenderContext;

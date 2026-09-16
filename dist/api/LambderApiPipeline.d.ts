import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
import type { LambderApiCallContext } from "./LambderApiCallContext.js";
import type { LambderApiCallTrace } from "./LambderApiCallContext.js";
import type { LambderApiDefinition } from "./LambderApiDefinition.js";
import { type LambderApiSignatureMap } from "../shared/wire/LambderApiSignature.js";
import type { LambderApiGuard } from "./LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig, LambderApiRateLimitsConfig } from "./LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "./LambderApiIdempotency.js";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import type LambderSessionManager from "../session/LambderSessionManager.js";
import LambderSessionController, { type LambderSessionCookieOptions, type LambderSessionRequestInfo } from "../session/LambderSessionController.js";
import type { MaybePromise } from "../shared/util/LambderTypeUtilities.js";
/**
 * The app's own answer for a rejected input (setApiInputValidationErrorHandler
 * on the server). Returning null asks for the standard 422 body, which is
 * what an adapter whose app set no handler answers: the rule lives in the
 * pipeline alone, so "no handler, standard 422" is written once. The API's
 * schema and every preflight slice (guard inputs, rate-limit keys) answer
 * through here, so one failure has one shape.
 */
export type LambderApiInputRefusal<TCtx> = (zodError: z.ZodError, ctx: TCtx, request: LambderApiRequest) => MaybePromise<LambderApiAnswer | null>;
/** The session subsystem as the pipeline runs it: the manager plus the cookie names and scope the controller writes. */
export type LambderApiSessionsConfig<TSessionData> = {
    manager: LambderSessionManager<TSessionData>;
    tokenCookieKey?: string;
    csrfCookieKey?: string;
    cookieOptions?: LambderSessionCookieOptions;
};
export type LambderApiPipelineOptions<TCtx extends LambderApiCallContext<TSessionData>, TSessionData = any> = {
    /** Stamped on every answer's envelope as apiVersion, so a client can tell which build answered; null when the app set none. */
    apiVersion?: string | null;
    /**
     * The floor under the signature gate: a request naming a `version` below
     * it answers versionExpired whatever its signature says. Dotted numbers
     * ("1.2.10"), compared segment by segment. A floor above apiVersion is
     * taken as apiVersion, so a mistaken floor cannot refuse the build's own
     * clients.
     */
    minApiVersion?: string | null;
    /**
     * Enables the signature gate: the generated map (Lambder.apiSignatures(),
     * the same file the client ships with). A request carrying a signature
     * that is not the map's entry for its endpoint answers versionExpired,
     * and so does one for an endpoint the map does not hold: that client was
     * built against another contract. Without a map every signature passes.
     */
    apiSignatures?: LambderApiSignatureMap;
    /** Ceiling on what a compressed request payload may restore to. Default: 20,000,000. */
    maxRequestPayloadBytes?: number;
    onInvalidInput?: LambderApiInputRefusal<TCtx>;
    sessions?: LambderApiSessionsConfig<TSessionData>;
    rateLimits?: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig<TCtx>>>;
    guards?: Record<string, LambderApiGuard<any, any, any, TCtx, TCtx & {
        session: LambderSessionRecord<TSessionData>;
    }>>;
    idempotency?: LambderApiIdempotencyConfig;
};
/** What one run produced, beside the answer: what an adapter may want to report. */
export type LambderApiRunResult = LambderApiCallTrace & {
    answer: LambderApiAnswer;
};
/** The adapter's step: run the endpoint's handler on the context and hand back its answer. */
export type LambderApiExec<TCtx> = (ctx: TCtx) => Promise<LambderApiAnswer>;
/**
 * The API pipeline: one API call from a parsed request to a plain answer,
 * in the order the protocol defines. The Lambda server and the mock runtime
 * are adapters over this class; neither reimplements a step of it.
 *
 * ```
 * version floor → signature gate → restore payload → rate limits that need no session
 * → session (session mode) → idempotency replay → the remaining rate limits
 * → guards → input validation → exec, inside the idempotency claim
 * → drain response headers → answer
 * ```
 *
 * Steps whose subsystem is not configured are skipped. A LambderApiRefusal
 * thrown by any step, guard or handler is rendered here, in one place: a
 * validation error through onInvalidInput, any other refusal as the refusal
 * envelope. Anything else propagates, because only the adapter knows what a
 * crash means (a global error handler, a mock event).
 *
 * `run` never sees a name it has no definition for; resolving a name to a
 * definition is the one thing the adapters legitimately do differently (an
 * action list versus a registry), and answerUnknownApi is what they answer
 * with.
 */
export declare class LambderApiPipeline<TCtx extends LambderApiCallContext<TSessionData>, TSessionData = any> {
    readonly apiVersion: string | null;
    readonly minApiVersion: string | null;
    private readonly policies;
    private readonly maxRequestPayloadBytes;
    private readonly onInvalidInput;
    private readonly sessions;
    private readonly apiSignatures;
    constructor(options?: LambderApiPipelineOptions<TCtx, TSessionData>);
    /** True when a session manager was configured. */
    get hasSessions(): boolean;
    /** The session manager, for adapters that hand it out; throws when sessions are not configured. */
    get sessionManager(): LambderSessionManager<TSessionData>;
    /**
     * A session controller for one request: what handlers use to create,
     * rotate, refresh and end sessions. The request info is the API request's
     * (its cookies and posted CSRF token) or a route's (cookies and no CSRF).
     */
    sessionController(ctx: TCtx, request: LambderSessionRequestInfo): LambderSessionController<TSessionData>;
    /** The session request info of an API request: its cookies, and the CSRF token it posted. */
    static sessionInfoOf(request: LambderApiRequest): LambderSessionRequestInfo;
    /** Registration-time checks of one definition's declarative options; the same messages on the server and in the mock. */
    assertRegistration(definition: LambderApiDefinition): void;
    /**
     * The answer for a request naming no registered API: the apiNotFound
     * refusal, carrying whatever the call already wrote (a CORS header, a
     * cookie eviction). No signature gate here: both adapters run prepare()
     * on the way in, so a signed request for a name the map does not hold (a
     * client built against a contract that had it) has already been answered
     * versionExpired by the time anything asks for an unknown name.
     */
    answerUnknownApi(request: LambderApiRequest, ctx?: TCtx): LambderApiAnswer;
    /**
     * The steps that come before anything may read the request: the version
     * floor, the signature gate, then the compressed-payload restore that
     * every later reader (a rate-limit key slice, a guard, the input schema)
     * depends on having happened.
     *
     * The floor answers versionExpired to a request naming a version below
     * minApiVersion whatever its signature says: the lever for a change the
     * digest cannot see (a security fix, a field whose meaning changed under
     * the same shape). A request naming no version is not judged by it, as
     * one carrying no signature is not gated.
     *
     * The gate compares the signature the request carries with the map's
     * entry for the endpoint it names. A match runs; anything else, another
     * entry or none, is a client built against another shape of this
     * endpoint or against an endpoint that no longer exists, and is answered
     * versionExpired. A request carrying no signature is never gated.
     *
     * Public and named because the server runs them earlier than run() does,
     * on the way in, so that its hooks see a plain payload and a stale client
     * is answered before any of them, whether or not the name it asked for
     * exists. run() calls it too, so an adapter that has no such step still
     * gets the whole protocol. Calling it twice is safe by construction: the
     * gates are comparisons and the restore has already removed the wire
     * fields it reads.
     *
     * Returns the answer that ends the call, or null when the request is
     * ready to dispatch.
     */
    prepare(request: LambderApiRequest): Promise<LambderApiAnswer | null>;
    /**
     * One call, one answer. Refusals are rendered; crashes propagate.
     *
     * An adapter that wants to report what the call did even when it crashed
     * passes its own trace object: the pipeline writes into that one, so a
     * handler that threw still leaves the guards it ran behind for the
     * adapter's catch. Without it the trace was created here and lost with
     * the throw, and the mock's call log showed no guards on exactly the
     * calls a developer opens the log for.
     */
    run(request: LambderApiRequest, ctx: TCtx, definition: LambderApiDefinition, exec: LambderApiExec<TCtx>, trace?: LambderApiCallTrace): Promise<LambderApiRunResult>;
    private execute;
    private refuseInput;
}

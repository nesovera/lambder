import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import { restoreCompressedPayload } from "./LambderApiRequest.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
import type { LambderApiCallContext } from "./LambderApiCallContext.js";
import type { LambderApiCallTrace } from "./LambderApiCallContext.js";
import type { LambderApiDefinition } from "./LambderApiDefinition.js";
import type { LambderApiSignatureSource } from "./LambderApiSignature.js";
import {
    apiNotFoundAnswer,
    invalidPayloadAnswer,
    refusalAnswer,
    sessionExpiredAnswer,
    validationAnswer,
    versionExpiredAnswer,
} from "./LambderApiEnvelope.js";
import { LambderApiValidationRefusal, isLambderApiValidationRefusal } from "./LambderApiValidationRefusal.js";
import { isLambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
import { DEFAULT_MAX_RESTORED_PAYLOAD_BYTES } from "../shared/wire/LambderRequestPayload.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { LambderApiPolicyEngine } from "./LambderApiPolicyEngine.js";
import type { LambderApiGuard } from "./LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig, LambderApiRateLimitsConfig } from "./LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "./LambderApiIdempotency.js";
import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import type LambderSessionManager from "../session/LambderSessionManager.js";
import LambderSessionController, {
    assertSessionCookiePrefixes,
    type LambderSessionCookieOptions,
    type LambderSessionRequestInfo,
} from "../session/LambderSessionController.js";
import { DEFAULT_SESSION_CSRF_COOKIE_KEY, DEFAULT_SESSION_TOKEN_COOKIE_KEY } from "../shared/wire/LambderSessionCookieNames.js";
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
     * Enables the signature gate: a request carrying a signature that is not
     * the one this source expects for its endpoint answers versionExpired.
     * Without a source every signature passes, which is what the mock runtime
     * does unless it is given the generated map.
     */
    signatures?: LambderApiSignatureSource;
    /** Ceiling on what a compressed request payload may restore to. Default: 20,000,000. */
    maxRequestPayloadBytes?: number;
    onInvalidInput?: LambderApiInputRefusal<TCtx>;
    sessions?: LambderApiSessionsConfig<TSessionData>;
    // Bound to this pipeline's own context: a custom key handler is handed
    // the context the adapter runs on, so leaving it open let a handler
    // written for another adapter compile here and then read fields that are
    // not there, which is the regression the policy layer's own builders fix.
    rateLimits?: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig<TCtx>>>;
    // The same binding for guards, on both contexts a guard may run on. The
    // session one is built structurally out of the two parameters the pipeline
    // already has, rather than taken as a third: an adapter's session context
    // IS its context with the session narrowed to a record, which both shipped
    // ones spell out that way, so nothing is left at `any` and no adapter has
    // to name its session context type here.
    guards?: Record<string, LambderApiGuard<any, any, any, TCtx, TCtx & { session: LambderSessionRecord<TSessionData> }>>;
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
 * signature gate → restore payload → rate limits that need no session
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
export class LambderApiPipeline<TCtx extends LambderApiCallContext<TSessionData>, TSessionData = any> {
    readonly apiVersion: string | null;
    private readonly policies = new LambderApiPolicyEngine();
    private readonly maxRequestPayloadBytes: number;
    private readonly onInvalidInput: LambderApiInputRefusal<TCtx> | null;
    private readonly sessions: Required<LambderApiSessionsConfig<TSessionData>> | null;
    private readonly signatures: LambderApiSignatureSource | null;

    constructor(options: LambderApiPipelineOptions<TCtx, TSessionData> = {}){
        this.apiVersion = options.apiVersion ?? null;
        this.signatures = options.signatures ?? null;
        this.maxRequestPayloadBytes = assertPositiveInteger(options.maxRequestPayloadBytes ?? DEFAULT_MAX_RESTORED_PAYLOAD_BYTES, "maxRequestPayloadBytes");
        this.onInvalidInput = options.onInvalidInput ?? null;
        this.sessions = options.sessions
            ? {
                manager: options.sessions.manager,
                tokenCookieKey: options.sessions.tokenCookieKey ?? DEFAULT_SESSION_TOKEN_COOKIE_KEY,
                csrfCookieKey: options.sessions.csrfCookieKey ?? DEFAULT_SESSION_CSRF_COOKIE_KEY,
                cookieOptions: options.sessions.cookieOptions ?? {},
            }
            : null;
        if(this.sessions) assertSessionCookiePrefixes(this.sessions);
        if(options.rateLimits) this.policies.configureRateLimits(options.rateLimits);
        if(options.guards) this.policies.configureGuards(options.guards);
        if(options.idempotency) this.policies.configureIdempotency(options.idempotency);
    }

    /** True when a session manager was configured. */
    get hasSessions(): boolean { return this.sessions !== null; }

    /** The session manager, for adapters that hand it out; throws when sessions are not configured. */
    get sessionManager(): LambderSessionManager<TSessionData> {
        if(!this.sessions) throw new Error("Session is not enabled. Configure the session option at creation.");
        return this.sessions.manager;
    }

    /**
     * A session controller for one request: what handlers use to create,
     * rotate, refresh and end sessions. The request info is the API request's
     * (its cookies and posted CSRF token) or a route's (cookies and no CSRF).
     */
    sessionController(ctx: TCtx, request: LambderSessionRequestInfo): LambderSessionController<TSessionData> {
        if(!this.sessions) throw new Error("Session is not enabled. Configure the session option at creation.");
        return new LambderSessionController<TSessionData>({
            manager: this.sessions.manager,
            tokenCookieKey: this.sessions.tokenCookieKey,
            csrfCookieKey: this.sessions.csrfCookieKey,
            cookieOptions: this.sessions.cookieOptions,
            ctx,
            request,
        });
    }

    /** The session request info of an API request: its cookies, and the CSRF token it posted. */
    static sessionInfoOf(request: LambderApiRequest): LambderSessionRequestInfo {
        return { host: request.host, cookies: request.cookies, csrfToken: request.token };
    }

    /** Registration-time checks of one definition's declarative options; the same messages on the server and in the mock. */
    assertRegistration(definition: LambderApiDefinition): void {
        this.policies.assertRegistration(definition);
    }

    /**
     * The answer for a request naming no registered API: the apiNotFound
     * refusal, carrying whatever the call already wrote (a CORS header, a
     * cookie eviction). No signature gate here: both adapters run prepare()
     * on the way in, with the definition the name resolved to or null, so a
     * signed request for an unknown name (a client built against a contract
     * that had it) has already been answered versionExpired by the time
     * anything asks for an unknown name.
     */
    answerUnknownApi(request: LambderApiRequest, ctx?: TCtx): LambderApiAnswer {
        const answer = apiNotFoundAnswer(this.apiVersion, ctx?.logList);
        ctx?.responseHeaders.applyInto(answer.headers);
        return answer;
    }

    /**
     * The steps that come before anything may read the request: the
     * signature gate, then the compressed-payload restore that every later
     * reader (a rate-limit key slice, a guard, the input schema) depends on
     * having happened.
     *
     * The gate compares the signature the request carries with the one the
     * source expects for the endpoint the name resolved to (`definition`,
     * null for a name the adapter does not know). A match runs; anything
     * else is a client built against another shape of this endpoint, or
     * against an endpoint that no longer exists, and is answered
     * versionExpired. A request carrying no signature is never gated.
     *
     * Public and named because the server runs them earlier than run() does,
     * on the way in, so that its hooks see a plain payload and a stale client
     * is answered before any of them, whether or not the name it asked for
     * exists. run() calls it too, so an adapter that has no such step still
     * gets the whole protocol. Calling it twice is safe by construction: the
     * gate compares against a memoized digest and the restore has already
     * removed the wire fields it reads.
     *
     * Returns the answer that ends the call, or null when the request is
     * ready to dispatch.
     */
    async prepare(request: LambderApiRequest, definition: LambderApiDefinition | null): Promise<LambderApiAnswer | null> {
        if(request.signature !== null && this.signatures){
            const expected = await this.signatures.expectedSignatureOf(request.apiName, definition);
            if(expected !== request.signature) return versionExpiredAnswer(this.apiVersion);
        }
        const restored = await restoreCompressedPayload(request, this.maxRequestPayloadBytes);
        if(!restored.ok) return invalidPayloadAnswer(this.apiVersion, restored.message);
        return null;
    }

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
    async run(request: LambderApiRequest, ctx: TCtx, definition: LambderApiDefinition, exec: LambderApiExec<TCtx>, trace: LambderApiCallTrace = { guardsRun: [], replayed: false }): Promise<LambderApiRunResult> {
        let answer: LambderApiAnswer;
        try {
            answer = await this.execute(request, ctx, definition, exec, trace);
        } catch(err){
            if(isLambderApiValidationRefusal(err)){
                answer = await this.refuseInput(err, ctx, request);
            } else if(isLambderApiRefusal(err)){
                answer = refusalAnswer(err, this.apiVersion, ctx.logList);
            } else {
                throw err;
            }
        }
        // Every header written during the call belongs on the answer, whichever
        // way it was produced: a cookie eviction from the session read, a
        // handler's setHeader before it refused, the handler's own headers
        // (already on it, so re-applying them here changes nothing).
        ctx.responseHeaders.applyInto(answer.headers);
        return { answer, ...trace };
    }

    private async execute(
        request: LambderApiRequest,
        ctx: TCtx,
        definition: LambderApiDefinition,
        exec: LambderApiExec<TCtx>,
        trace: LambderApiCallTrace,
    ): Promise<LambderApiAnswer> {
        const unprepared = await this.prepare(request, definition);
        if(unprepared) return unprepared;

        // The limits whose key is known from the request alone, before the
        // session store is asked anything: a request carrying bogus session
        // cookies costs up to four store reads, and answering it
        // sessionExpired without the limiter having run let one address spend
        // the session store's read budget freely. A replay costs the same
        // reads, so an ip-limited replay counts against that budget too: the
        // limit protects the stores, not the handler.
        await this.policies.runSessionlessRateLimits(request, ctx, definition);

        if(definition.mode === "session"){
            if(!this.sessions) throw new Error(`Lambder: API "${definition.name}" is a session API, but no session store was configured at creation.`);
            const session = await this.sessionController(ctx, LambderApiPipeline.sessionInfoOf(request)).fetchSessionIfExists();
            if(!session) return sessionExpiredAnswer(this.apiVersion, ctx.logList);
        }

        // Replay fast path: a completed idempotent request answers its stored
        // answer without burning the remaining rate-limit quota or re-running
        // guards. After the session read, because the replay scope is keyed
        // per session.
        const replay = await this.policies.findReplay(request, ctx, definition, trace);
        if(replay) return replay;

        await this.policies.runPreflight(request, ctx, definition, trace);

        if(definition.input){
            const parsed = definition.input.safeParse(request.payload);
            if(!parsed.success) throw new LambderApiValidationRefusal(parsed.error);
            request.payload = parsed.data;
        }

        // The handler's own answer, and only that: what it wrote into
        // responseHeaders during the call is on it before the idempotency
        // engine judges and stores it, while a header written EARLIER in the
        // call is not. That line matters, because the engine refuses to store
        // an answer carrying a Set-Cookie: charge it with the stale-session
        // cookie the session read evicted and an otherwise idempotent
        // operation would silently stop being idempotent and re-execute on
        // every retry. The call's earlier headers still reach the client;
        // run() applies them to the answer on the way out.
        const runHandler = async (): Promise<LambderApiAnswer> => {
            const handlerFirstHeader = ctx.responseHeaders.size;
            const produced = await exec(ctx);
            ctx.responseHeaders.applyInto(produced.headers, handlerFirstHeader);
            return produced;
        };
        return await this.policies.withIdempotency(request, ctx, definition, trace, runHandler);
    }

    private async refuseInput(err: LambderApiValidationRefusal, ctx: TCtx, request: LambderApiRequest): Promise<LambderApiAnswer> {
        const custom = this.onInvalidInput ? await this.onInvalidInput(err.zodError, ctx, request) : null;
        return custom ?? validationAnswer(err.zodError, ctx.logList);
    }
}

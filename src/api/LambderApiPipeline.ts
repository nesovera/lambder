import type { z } from "zod";
import type { LambderApiRequest } from "./LambderApiRequest.js";
import { restoreCompressedPayload } from "./LambderApiRequest.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
import type { LambderApiCallContext } from "./LambderApiCallContext.js";
import type { LambderApiCallTrace } from "./LambderApiCallContext.js";
import type { LambderApiDefinition } from "./LambderApiDefinition.js";
import { lookupApiSignature, type LambderApiSignatureMap } from "../shared/wire/LambderApiSignature.js";
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
import { compareDottedVersions, isDottedVersion } from "../shared/wire/LambderVersionOrder.js";
import { LambderApiGuardsEngine, type LambderApiGuard } from "./LambderApiGuards.js";
import {
    LambderApiRateLimitsEngine,
    type LambderApiRateLimitPolicyConfig,
    type LambderApiRateLimitsConfig,
    type LambderRateLimitChargeResult,
    type LambderRateLimitChargeSubject,
} from "./LambderApiRateLimits.js";
import { LambderApiIdempotencyEngine, type LambderApiIdempotencyConfig } from "./LambderApiIdempotency.js";
import type { LambderApiIdempotencyOption } from "../shared/wire/LambderApiOptionValues.js";
import type { LambderSessionRecord, LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import type { LambderRateLimiter } from "../shared/contracts/LambderRateLimiter.js";
import type { LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
import type LambderSessionManager from "../session/LambderSessionManager.js";
import LambderSessionController, {
    assertSessionCookiePrefixes,
    LambderSessionNotFoundError,
    type LambderSessionCookieOptions,
    type LambderSessionRequestInfo,
} from "../session/LambderSessionController.js";
import { DEFAULT_SESSION_CSRF_COOKIE_KEY, DEFAULT_SESSION_TOKEN_COOKIE_KEY } from "../shared/wire/LambderSessionCookieNames.js";
import type { MaybePromise } from "../shared/util/LambderTypeUtilities.js";

/**
 * The app's own answer for a rejected input (setApiInputValidationErrorHandler
 * on the server). Returning null asks for the standard 422 body, which only
 * the pipeline writes, so every adapter without a handler answers alike. The
 * API's schema and every preflight slice (guard inputs, rate-limit keys)
 * answer through here, so one failure has one shape.
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
    // Bound to this pipeline's own context: a custom key handler is handed
    // the context the adapter runs on, and an open type would let a handler
    // written for another adapter compile here and then read fields that are
    // not there.
    rateLimits?: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig<TCtx>>>;
    // The same binding for guards, on both contexts a guard may run on. The
    // session context is built from the two parameters the pipeline already
    // has rather than taken as a third: an adapter's session context is its
    // context with the session narrowed to a record (both shipped adapters
    // define it so), so nothing is left at `any` and no adapter has to name
    // its session context type here.
    guards?: Record<string, LambderApiGuard<any, any, any, TCtx, TCtx & { session: LambderSessionRecord<TSessionData> }>>;
    idempotency?: LambderApiIdempotencyConfig;
};

/** The stores `lambder/testing` puts under a built pipeline. One the pipeline has no subsystem for is left aside. */
export type LambderPipelineBackends = {
    sessionStore?: LambderSessionStore<any>;
    rateLimiter?: LambderRateLimiter;
    idempotencyStore?: LambderIdempotencyStore;
};

/**
 * What a backend swap found: whether the rate-limit and idempotency
 * subsystems exist to take a store, and, when sessions are configured, the
 * cookie names a caller over this pipeline has to be told (they are the
 * app's own choice and nothing else hands them out).
 */
export type LambderPipelineBackendSwap = {
    sessions: { tokenCookieKey: string; csrfCookieKey: string } | null;
    rateLimits: boolean;
    idempotency: boolean;
};

/** What one run produced, beside the answer: what an adapter may want to report. */
export type LambderApiRunResult = LambderApiCallTrace & {
    answer: LambderApiAnswer;
};

/** The adapter's step: run the endpoint's handler on the context and hand back its answer. */
export type LambderApiExec<TCtx> = (ctx: TCtx) => Promise<LambderApiAnswer>;

/** An API that asks for idempotency: declared, and not the explicit `false` opt-out. */
const usesIdempotency = (definition: LambderApiDefinition): definition is LambderApiDefinition & { idempotency: LambderApiIdempotencyOption } =>
    definition.idempotency !== undefined && definition.idempotency !== false;

/**
 * The API pipeline: one API call from a parsed request to a plain answer,
 * in the order the protocol defines. The Lambda server and the mock runtime
 * are adapters over this class; neither reimplements a step of it.
 *
 * ```
 * version floor → signature gate → restore payload → rate limits keyed per ip
 * → session (session mode) → idempotency replay → rate limits keyed per session
 * (and custom keys charged beforeGuards) → guards → input validation → guards
 * placed after it → rate limits keyed by a custom key → exec, inside the
 * idempotency claim → drain response headers → answer
 * ```
 *
 * Each policy subsystem (rate limits, guards, idempotency) is its own
 * engine, held here and called at its step, so the order above can be read
 * directly off execute().
 *
 * Steps whose subsystem is not configured are skipped. A LambderApiRefusal
 * thrown by any step, guard or handler is rendered here, in one place: a
 * validation error through onInvalidInput, any other refusal as the refusal
 * envelope, and a session ended while the handler held it
 * (LambderSessionNotFoundError) as sessionExpired. Anything else propagates, because only the adapter knows what a
 * crash means (a global error handler, a mock event).
 *
 * `run` never sees a name it has no definition for; resolving a name to a
 * definition is the one thing the adapters legitimately do differently (an
 * action list versus a registry), and answerUnknownApi is what they answer
 * with.
 */
export class LambderApiPipeline<TCtx extends LambderApiCallContext<TSessionData>, TSessionData = any> {
    readonly apiVersion: string | null;
    readonly minApiVersion: string | null;
    private readonly rateLimits = new LambderApiRateLimitsEngine();
    private readonly guards = new LambderApiGuardsEngine();
    private readonly idempotency: LambderApiIdempotencyEngine;
    private readonly maxRequestPayloadBytes: number;
    private readonly onInvalidInput: LambderApiInputRefusal<TCtx> | null;
    private readonly sessions: Required<LambderApiSessionsConfig<TSessionData>> | null;
    private readonly apiSignatures: LambderApiSignatureMap | null;

    constructor(options: LambderApiPipelineOptions<TCtx, TSessionData> = {}){
        this.apiVersion = options.apiVersion ?? null;
        // Dotted, always, whether or not a floor is set today: the floor reads
        // this string as numbers, and a stamp the comparison cannot read
        // ("dev", a commit sha) counts as 0, so setting minApiVersion later
        // would answer versionExpired to every client of this very build.
        if(this.apiVersion !== null && !isDottedVersion(this.apiVersion)){
            throw new Error(`Lambder: apiVersion must be a dotted version such as "1.2.10", got ${JSON.stringify(this.apiVersion)}.`);
        }
        this.minApiVersion = options.minApiVersion ?? null;
        if(this.minApiVersion !== null){
            if(!isDottedVersion(this.minApiVersion)){
                throw new Error(`Lambder: minApiVersion must be a dotted version such as "1.2.10", got ${JSON.stringify(this.minApiVersion)}.`);
            }
            // A floor above the version this server stamps would refuse this
            // build's own clients, and the first symptom would be every tab
            // reloading. The floor is clamped to apiVersion and the mistake
            // reported once, at creation.
            if(this.apiVersion !== null && compareDottedVersions(this.minApiVersion, this.apiVersion) > 0){
                console.warn(`Lambder: minApiVersion ${this.minApiVersion} is above apiVersion ${this.apiVersion}; the floor is taken as ${this.apiVersion}.`);
                this.minApiVersion = this.apiVersion;
            }
        }
        this.idempotency = new LambderApiIdempotencyEngine(this.apiVersion);
        this.apiSignatures = options.apiSignatures ?? null;
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
        if(options.rateLimits) this.rateLimits.configure(options.rateLimits);
        if(options.guards) this.guards.configure(options.guards);
        if(options.idempotency) this.idempotency.configure(options.idempotency);
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

    /**
     * The backend swap: each store given goes under the subsystem that holds
     * one, and everything the app configured around it (the session model,
     * the named policies, the replay TTLs) stays in force.
     */
    [LAMBDER_BACKEND_SWAP](backends: LambderPipelineBackends): LambderPipelineBackendSwap {
        if(this.sessions && backends.sessionStore) this.sessions.manager[LAMBDER_BACKEND_SWAP](backends.sessionStore);
        return {
            sessions: this.sessions ? { tokenCookieKey: this.sessions.tokenCookieKey, csrfCookieKey: this.sessions.csrfCookieKey } : null,
            rateLimits: backends.rateLimiter ? this.rateLimits[LAMBDER_BACKEND_SWAP](backends.rateLimiter) : false,
            idempotency: backends.idempotencyStore ? this.idempotency[LAMBDER_BACKEND_SWAP](backends.idempotencyStore) : false,
        };
    }

    /** The session request info of an API request: its cookies, and the CSRF token it posted. */
    static sessionInfoOf(request: LambderApiRequest): LambderSessionRequestInfo {
        return { host: request.host, cookies: request.cookies, csrfToken: request.token };
    }

    /**
     * One named rate-limit policy charged by code: what an adapter's
     * `ctx.rateLimit` and `ctx.isRateLimited` run. The adapter supplies who is
     * being counted, since only it knows whether the request is an API call.
     */
    async chargeRateLimit(name: string, subject: LambderRateLimitChargeSubject): Promise<LambderRateLimitChargeResult> {
        return await this.rateLimits.chargePolicy(name, subject);
    }

    /** Registration-time checks of one definition's declarative options; the same messages on the server and in the mock. */
    assertRegistration(definition: LambderApiDefinition): void {
        const { name, mode } = definition;
        // Each subsystem reports its own absence: one combined message would
        // name all three when only one of them is missing.
        if(definition.rateLimit !== undefined && !this.rateLimits.isConfigured){
            throw new Error(`Lambder: API "${name}" declares rateLimit but no rateLimits option was configured at creation.`);
        }
        if(definition.guards !== undefined && !this.guards.isConfigured){
            throw new Error(`Lambder: API "${name}" declares guards but no guards option was configured at creation.`);
        }
        this.rateLimits.assertRegistration(name, mode, definition.rateLimit);
        this.guards.assertRegistration(name, mode, definition.guards);
        // `idempotency: false` is an explicit opt-out, not a use: it asks for
        // nothing and so needs no store behind it.
        if(usesIdempotency(definition)){
            if(!this.idempotency.isConfigured){
                throw new Error(`Lambder: API "${name}" declares idempotency but no idempotency store was configured at creation.`);
            }
            this.idempotency.assertRegistration(name, definition.idempotency);
        }
    }

    /**
     * The answer for a request naming no registered API: the apiNotFound
     * refusal, carrying whatever the call already wrote (a CORS header, a
     * cookie eviction). No signature gate here: both adapters run prepare()
     * on the way in, so a signed request for a name the map does not hold (a
     * client built against a contract that had it) has already been answered
     * versionExpired by the time anything asks for an unknown name.
     */
    answerUnknownApi(ctx?: TCtx): LambderApiAnswer {
        const answer = apiNotFoundAnswer(this.apiVersion, ctx?.logList);
        ctx?.responseHeaders.applyInto(answer.headers);
        return answer;
    }

    /**
     * The steps that come before anything may read the request: the version
     * floor, the signature gate, then the compressed-payload restore that
     * every later reader (a rate-limit key slice, a guard, the input schema)
     * relies on.
     *
     * The floor refuses a request naming a version below minApiVersion,
     * whatever its signature says: the lever for a change the digest cannot
     * see (a security fix, a field whose meaning changed under the same
     * shape). The gate refuses a signature that is not the map's entry for
     * the endpoint named (another entry, or none): a client built against
     * another shape of this endpoint, or against one that no longer exists.
     * Both answer versionExpired. A request naming no version skips the
     * floor, and one carrying no signature skips the gate.
     *
     * Public because the server runs it earlier, on the way in, so its hooks
     * see a plain payload and a stale client is answered before any of them,
     * whether or not the name it asked for exists. run() calls it too, so an
     * adapter without that step still gets the whole protocol. Calling it
     * twice is safe: the gates are comparisons, and the restore has already
     * removed the wire fields it reads.
     *
     * Returns the answer that ends the call, or null when the request is
     * ready to dispatch.
     */
    async prepare(request: LambderApiRequest): Promise<LambderApiAnswer | null> {
        if(this.minApiVersion !== null && request.version !== null && compareDottedVersions(request.version, this.minApiVersion) < 0){
            return versionExpiredAnswer(this.apiVersion);
        }
        if(request.signature !== null && this.apiSignatures){
            const expected = await lookupApiSignature(this.apiSignatures, request.apiName);
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
     * handler that threw still leaves the guards it ran for the adapter's
     * catch. A trace created here would be lost with the throw, and the
     * mock's call log would show no guards on exactly the calls a developer
     * opens it for.
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
            } else if(err instanceof LambderSessionNotFoundError){
                // No usable session: it ended while the handler held it (a
                // logout or a password change landed mid-request), or a read
                // the handler made found none or several
                // (LambderSessionAmbiguousError is one of these). The same
                // answer a session read that found none gives.
                answer = sessionExpiredAnswer(this.apiVersion, ctx.logList);
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
        const unprepared = await this.prepare(request);
        if(unprepared) return unprepared;

        // The limits whose key is known from the request alone, before the
        // session store is asked anything: a request carrying bogus session
        // cookies costs up to four store reads, and answering it
        // sessionExpired before the limiter runs would let one address spend
        // the session store's read budget freely. A replay costs the same
        // reads, so an ip-limited replay counts too: the limit protects the
        // stores, not the handler.
        await this.rateLimits.run(definition.name, request, ctx, definition.rateLimit, "beforeSession");

        if(definition.mode === "session"){
            if(!this.sessions) throw new Error(`Lambder: API "${definition.name}" is a session API, but no session store was configured at creation.`);
            const session = await this.sessionController(ctx, LambderApiPipeline.sessionInfoOf(request)).fetchSessionIfExists();
            if(!session) return sessionExpiredAnswer(this.apiVersion, ctx.logList);
        }

        // Replay fast path: a completed idempotent request answers its stored
        // answer without burning the remaining rate-limit quota or re-running
        // guards. After the session read, because the replay scope is keyed
        // per user, by the session's sessionKey.
        const keyedCall = usesIdempotency(definition) ? await this.idempotency.resolveKeyedCall(definition.name, request, ctx) : null;
        const replay = keyedCall ? await this.idempotency.findReplay(definition.name, keyedCall, trace) : null;
        if(replay) return replay;

        // What refuses a request without spending anything on it comes first:
        // the limits keyed per session, the guards, the input. What spends
        // something comes last: a guard placed after validation (a
        // single-use captcha a mistyped field would otherwise waste), and the
        // limits keyed by a caller-chosen value (an email in the payload),
        // which charged earlier would let a caller who never passes the
        // captcha spend a victim's budget. Refusals throw; the trace records
        // each guard as it runs.
        await this.rateLimits.run(definition.name, request, ctx, definition.rateLimit, "beforeGuards");
        await this.guards.run(request, ctx, definition.guards, trace, "beforeInputValidation");

        // Asynchronously, so an input schema with an async refinement
        // validates instead of making zod throw on every call. The parse is
        // handed to the handler only after the late guards and the custom
        // keys, which read their slices from the payload as it was sent.
        const parsed = definition.input ? await definition.input.safeParseAsync(request.payload) : null;
        if(parsed && !parsed.success) throw new LambderApiValidationRefusal(parsed.error);

        await this.guards.run(request, ctx, definition.guards, trace, "afterInputValidation");
        await this.rateLimits.run(definition.name, request, ctx, definition.rateLimit, "afterGuards");
        if(parsed) request.payload = parsed.data;

        // The handler's own answer, and only that: what it wrote into
        // responseHeaders during the call goes on before the idempotency
        // engine judges and stores it, while a header written earlier in the
        // call does not. The engine refuses to store an answer carrying a
        // Set-Cookie, so the stale-session cookie the session read evicted
        // would silently make an idempotent operation re-execute on every
        // retry. The earlier headers still reach the client: run() applies
        // them on the way out.
        const runHandler = async (): Promise<LambderApiAnswer> => {
            const handlerFirstHeader = ctx.responseHeaders.size;
            const produced = await exec(ctx);
            ctx.responseHeaders.applyInto(produced.headers, handlerFirstHeader);
            return produced;
        };
        return keyedCall && usesIdempotency(definition)
            ? await this.idempotency.withIdempotency(definition.name, keyedCall, definition.idempotency, trace, runHandler)
            : await runHandler();
    }

    private async refuseInput(err: LambderApiValidationRefusal, ctx: TCtx, request: LambderApiRequest): Promise<LambderApiAnswer> {
        const custom = this.onInvalidInput ? await this.onInvalidInput(err.zodError, ctx, request) : null;
        return custom ?? validationAnswer(err.zodError, ctx.logList);
    }
}

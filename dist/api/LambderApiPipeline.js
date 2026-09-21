import { restoreCompressedPayload } from "./LambderApiRequest.js";
import { lookupApiSignature } from "../shared/wire/LambderApiSignature.js";
import { apiNotFoundAnswer, invalidPayloadAnswer, refusalAnswer, sessionExpiredAnswer, validationAnswer, versionExpiredAnswer, } from "./LambderApiEnvelope.js";
import { LambderApiValidationRefusal, isLambderApiValidationRefusal } from "./LambderApiValidationRefusal.js";
import { isLambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
import { DEFAULT_MAX_RESTORED_PAYLOAD_BYTES } from "../shared/wire/LambderRequestPayload.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { compareDottedVersions, isDottedVersion } from "../shared/wire/LambderVersionOrder.js";
import { LambderApiPolicyEngine } from "./LambderApiPolicyEngine.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
import LambderSessionController, { assertSessionCookiePrefixes, } from "../session/LambderSessionController.js";
import { DEFAULT_SESSION_CSRF_COOKIE_KEY, DEFAULT_SESSION_TOKEN_COOKIE_KEY } from "../shared/wire/LambderSessionCookieNames.js";
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
export class LambderApiPipeline {
    apiVersion;
    minApiVersion;
    policies = new LambderApiPolicyEngine();
    maxRequestPayloadBytes;
    onInvalidInput;
    sessions;
    apiSignatures;
    constructor(options = {}) {
        this.apiVersion = options.apiVersion ?? null;
        // Dotted, always, whether or not a floor is set today: the floor reads
        // this string as numbers, and a stamp the comparison cannot read
        // ("dev", a commit sha) counts as 0, so setting minApiVersion later
        // would answer versionExpired to every client of this very build.
        if (this.apiVersion !== null && !isDottedVersion(this.apiVersion)) {
            throw new Error(`Lambder: apiVersion must be a dotted version such as "1.2.10", got ${JSON.stringify(this.apiVersion)}.`);
        }
        this.minApiVersion = options.minApiVersion ?? null;
        if (this.minApiVersion !== null) {
            if (!isDottedVersion(this.minApiVersion)) {
                throw new Error(`Lambder: minApiVersion must be a dotted version such as "1.2.10", got ${JSON.stringify(this.minApiVersion)}.`);
            }
            // A floor above the version this server stamps on its answers
            // would refuse the very clients this build serves, and the first
            // symptom would be every tab reloading. The lower of the two is
            // the most a floor can mean here, so that is what it becomes, and
            // the mistake is said once at creation.
            if (this.apiVersion !== null && compareDottedVersions(this.minApiVersion, this.apiVersion) > 0) {
                console.warn(`Lambder: minApiVersion ${this.minApiVersion} is above apiVersion ${this.apiVersion}; the floor is taken as ${this.apiVersion}.`);
                this.minApiVersion = this.apiVersion;
            }
        }
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
        if (this.sessions)
            assertSessionCookiePrefixes(this.sessions);
        if (options.rateLimits)
            this.policies.configureRateLimits(options.rateLimits);
        if (options.guards)
            this.policies.configureGuards(options.guards);
        if (options.idempotency)
            this.policies.configureIdempotency(options.idempotency);
    }
    /** True when a session manager was configured. */
    get hasSessions() { return this.sessions !== null; }
    /** The session manager, for adapters that hand it out; throws when sessions are not configured. */
    get sessionManager() {
        if (!this.sessions)
            throw new Error("Session is not enabled. Configure the session option at creation.");
        return this.sessions.manager;
    }
    /**
     * A session controller for one request: what handlers use to create,
     * rotate, refresh and end sessions. The request info is the API request's
     * (its cookies and posted CSRF token) or a route's (cookies and no CSRF).
     */
    sessionController(ctx, request) {
        if (!this.sessions)
            throw new Error("Session is not enabled. Configure the session option at creation.");
        return new LambderSessionController({
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
    [LAMBDER_BACKEND_SWAP](backends) {
        if (this.sessions && backends.sessionStore)
            this.sessions.manager[LAMBDER_BACKEND_SWAP](backends.sessionStore);
        return {
            sessions: this.sessions ? { tokenCookieKey: this.sessions.tokenCookieKey, csrfCookieKey: this.sessions.csrfCookieKey } : null,
            ...this.policies[LAMBDER_BACKEND_SWAP](backends),
        };
    }
    /** The session request info of an API request: its cookies, and the CSRF token it posted. */
    static sessionInfoOf(request) {
        return { host: request.host, cookies: request.cookies, csrfToken: request.token };
    }
    /** Registration-time checks of one definition's declarative options; the same messages on the server and in the mock. */
    assertRegistration(definition) {
        this.policies.assertRegistration(definition);
    }
    /**
     * The answer for a request naming no registered API: the apiNotFound
     * refusal, carrying whatever the call already wrote (a CORS header, a
     * cookie eviction). No signature gate here: both adapters run prepare()
     * on the way in, so a signed request for a name the map does not hold (a
     * client built against a contract that had it) has already been answered
     * versionExpired by the time anything asks for an unknown name.
     */
    answerUnknownApi(request, ctx) {
        const answer = apiNotFoundAnswer(this.apiVersion, ctx?.logList);
        ctx?.responseHeaders.applyInto(answer.headers);
        return answer;
    }
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
    async prepare(request) {
        if (this.minApiVersion !== null && request.version !== null && compareDottedVersions(request.version, this.minApiVersion) < 0) {
            return versionExpiredAnswer(this.apiVersion);
        }
        if (request.signature !== null && this.apiSignatures) {
            const expected = await lookupApiSignature(this.apiSignatures, request.apiName);
            if (expected !== request.signature)
                return versionExpiredAnswer(this.apiVersion);
        }
        const restored = await restoreCompressedPayload(request, this.maxRequestPayloadBytes);
        if (!restored.ok)
            return invalidPayloadAnswer(this.apiVersion, restored.message);
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
    async run(request, ctx, definition, exec, trace = { guardsRun: [], replayed: false }) {
        let answer;
        try {
            answer = await this.execute(request, ctx, definition, exec, trace);
        }
        catch (err) {
            if (isLambderApiValidationRefusal(err)) {
                answer = await this.refuseInput(err, ctx, request);
            }
            else if (isLambderApiRefusal(err)) {
                answer = refusalAnswer(err, this.apiVersion, ctx.logList);
            }
            else {
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
    async execute(request, ctx, definition, exec, trace) {
        const unprepared = await this.prepare(request);
        if (unprepared)
            return unprepared;
        // The limits whose key is known from the request alone, before the
        // session store is asked anything: a request carrying bogus session
        // cookies costs up to four store reads, and answering it
        // sessionExpired without the limiter having run let one address spend
        // the session store's read budget freely. A replay costs the same
        // reads, so an ip-limited replay counts against that budget too: the
        // limit protects the stores, not the handler.
        await this.policies.runSessionlessRateLimits(request, ctx, definition);
        if (definition.mode === "session") {
            if (!this.sessions)
                throw new Error(`Lambder: API "${definition.name}" is a session API, but no session store was configured at creation.`);
            const session = await this.sessionController(ctx, LambderApiPipeline.sessionInfoOf(request)).fetchSessionIfExists();
            if (!session)
                return sessionExpiredAnswer(this.apiVersion, ctx.logList);
        }
        // Replay fast path: a completed idempotent request answers its stored
        // answer without burning the remaining rate-limit quota or re-running
        // guards. After the session read, because the replay scope is keyed
        // per session.
        const replay = await this.policies.findReplay(request, ctx, definition, trace);
        if (replay)
            return replay;
        await this.policies.runPreflight(request, ctx, definition, trace);
        if (definition.input) {
            const parsed = definition.input.safeParse(request.payload);
            if (!parsed.success)
                throw new LambderApiValidationRefusal(parsed.error);
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
        const runHandler = async () => {
            const handlerFirstHeader = ctx.responseHeaders.size;
            const produced = await exec(ctx);
            ctx.responseHeaders.applyInto(produced.headers, handlerFirstHeader);
            return produced;
        };
        return await this.policies.withIdempotency(request, ctx, definition, trace, runHandler);
    }
    async refuseInput(err, ctx, request) {
        const custom = this.onInvalidInput ? await this.onInvalidInput(err.zodError, ctx, request) : null;
        return custom ?? validationAnswer(err.zodError, ctx.logList);
    }
}

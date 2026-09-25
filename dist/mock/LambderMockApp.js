import { LambderApiPipeline } from "../api/LambderApiPipeline.js";
import { readApiEnvelope, cookieValuesByName, lowercaseHeaderNames } from "../api/LambderApiRequest.js";
import { bindCallTools, createApiCallContext } from "../api/LambderApiCallContext.js";
import { toHttpAnswer } from "../api/LambderApiAnswer.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import { buildApiEnvelope, envelopeAnswer, crashAnswer, } from "../api/LambderApiEnvelope.js";
import { LambderApiRefusal, LAMBDER_REFUSAL_CODES } from "../shared/wire/LambderApiRefusal.js";
import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import { buildTransportEnvelope } from "../shared/transport/LambderApiTransport.js";
import { lambderCookieJarTransport } from "../shared/transport/lambderCookieJarTransport.js";
import { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
import { serializeClearCookie } from "../shared/wire/LambderCookie.js";
import { LOOPBACK_CLIENT_IP, normalizeClientIp } from "../shared/util/LambderClientIp.js";
import { lambderGuardBuilder } from "../api/LambderApiGuards.js";
import { lambderRateLimitKeyBuilder } from "../api/LambderApiRateLimits.js";
import { LambderMockFailureInjector, LambderMockTransportError } from "./LambderMockFailureInjector.js";
import { LambderMockCallRecorder } from "./LambderMockCallRecorder.js";
import { LambderMockEntryRegistry } from "./LambderMockEntryRegistry.js";
import { LambderMockBrowserCookies } from "./LambderMockBrowserCookies.js";
import { LambderMemoryRateLimiter } from "../stores/LambderMemoryRateLimiter.js";
import { LambderMemoryIdempotencyStore } from "../stores/LambderMemoryIdempotencyStore.js";
import { LambderMemorySessionStore } from "../stores/LambderMemorySessionStore.js";
import LambderSessionManager from "../session/LambderSessionManager.js";
import { isWebCryptoAvailable, LambderPlainSessionCrypto } from "../session/LambderSessionCrypto.js";
import { DEFAULT_SESSION_CSRF_COOKIE_KEY, DEFAULT_SESSION_TOKEN_COOKIE_KEY } from "../shared/wire/LambderSessionCookieNames.js";
// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
/** The transport with its jar attached, which is what makes the jar reachable without a second creation call. */
const transportCarrying = (transport, jar) => Object.assign(transport, { cookieJar: jar });
const DEFAULT_CALL_LOG_SIZE = 200;
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * The host the runtime's cookies belong to when the app names none: the page
 * the mock is running in, or "localhost" where there is no page (a Node test).
 */
const defaultCookieHost = () => globalThis.location?.host || "localhost";
/**
 * The mock runtime: the API core (LambderApiPipeline, the same class the
 * Lambda server runs) over memory stores, with typed mock handlers and mock
 * guards where the server has app handlers and guards. Every protocol step
 * (envelope, refusals, sessions and their cookies, guards, rate limits,
 * idempotency, the signature gate) happens in the core; this class resolves
 * a name to an entry, wraps the handler's return into the envelope, and adds
 * what a mock needs: failure injection, latency, a subscription, a call log,
 * reset.
 *
 * Create one with initLambderMock<Contract, SessionData>().create(...),
 * which fixes the contract and session types first so everything else is
 * inferred from the options.
 */
export class LambderMockApp {
    apiVersion;
    /** The memory stores, for assertions and reset; null for a subsystem that is off or backed by a store of yours. */
    sessionStore;
    rateLimiter;
    idempotencyStore;
    tokenCookieKey;
    csrfCookieKey;
    /**
     * The client IP a transport request carrying none is read as. Public so
     * every adapter reads the same default the direct transport uses: with a
     * default of its own, an app that set defaultClientIp would show one
     * address through the transport and another through the service worker,
     * and a per-IP rate limit would count two clients where there is one.
     */
    defaultClientIp;
    /** The host this runtime's cookies belong to (see the cookieHost option). */
    cookieHost;
    /**
     * The API core, every protocol step of it. Private: the mock's surface is
     * the app, and a consumer reaching past it would be configuring the
     * server's pipeline through a development tool. The adapters use the
     * app's own methods (handleRequest, requestFromTransport) instead.
     */
    pipeline;
    /** The cookie scope signIn plants under, so signOut can name the same one when it clears them. */
    sessionCookieOptions;
    sessionTtlSeconds;
    onReset;
    revealHandlerErrors;
    /** Injected failures, the offline switch and the configured latency (see LambderMockFailureInjector). */
    failures;
    /** Subscriptions and the bounded call log (see LambderMockCallRecorder). */
    recorder;
    /** Registered entries and the overrides over them (see LambderMockEntryRegistry). */
    registry = new LambderMockEntryRegistry();
    /** The jars the runtime owns and what it planted in document.cookie (see LambderMockBrowserCookies). */
    browserCookies = new LambderMockBrowserCookies();
    constructor(options) {
        this.apiVersion = options.apiVersion ?? null;
        this.failures = new LambderMockFailureInjector({ apiVersion: this.apiVersion, latency: options.latency ?? 0 });
        this.recorder = new LambderMockCallRecorder({ callLogSize: options.callLogSize ?? DEFAULT_CALL_LOG_SIZE });
        // The loopback address when nothing names a client, as for a request
        // from the page itself (the in-process handler transport's default
        // too). Normalized once here because the direct transport, the MSW
        // adapter and every request naming no client all read it, and one
        // textual form per address keeps a per-IP limit to one counter.
        this.defaultClientIp = normalizeClientIp(options.defaultClientIp ?? LOOPBACK_CLIENT_IP);
        this.cookieHost = options.cookieHost ?? defaultCookieHost();
        this.onReset = options.onReset ?? null;
        this.revealHandlerErrors = options.revealHandlerErrors ?? true;
        const sessionOptions = options.sessions === true ? {} : options.sessions || null;
        this.sessionTtlSeconds = sessionOptions?.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
        this.tokenCookieKey = sessionOptions?.tokenCookieKey ?? DEFAULT_SESSION_TOKEN_COOKIE_KEY;
        this.csrfCookieKey = sessionOptions?.csrfCookieKey ?? DEFAULT_SESSION_CSRF_COOKIE_KEY;
        this.sessionCookieOptions = sessionOptions?.cookieOptions ?? {};
        const memorySessionStore = sessionOptions && !sessionOptions.store ? new LambderMemorySessionStore() : null;
        this.sessionStore = memorySessionStore;
        const rateLimits = options.rateLimits;
        const memoryLimiter = rateLimits && !rateLimits.limiter ? new LambderMemoryRateLimiter() : null;
        this.rateLimiter = memoryLimiter;
        const idempotencyOptions = options.idempotency === true ? {} : options.idempotency || null;
        const memoryIdempotency = idempotencyOptions && !idempotencyOptions.store ? new LambderMemoryIdempotencyStore() : null;
        this.idempotencyStore = memoryIdempotency;
        this.pipeline = new LambderApiPipeline({
            apiVersion: this.apiVersion,
            minApiVersion: options.minApiVersion,
            apiSignatures: options.apiSignatures,
            maxRequestPayloadBytes: options.maxRequestPayloadBytes,
            // The server app's own answer to a bad input, where it has one:
            // without it the mock would answer 422 where the server answers,
            // say, 200 with an errorMessage, and a form's error handling would
            // be tested against an answer production never gives.
            onInvalidInput: options.onInvalidInput
                ? async (zodError, ctx) => {
                    const answer = await options.onInvalidInput(zodError, ctx);
                    if (!answer)
                        return null;
                    const config = answer.config ?? {};
                    return envelopeAnswer(buildApiEnvelope(this.apiVersion, answer.payload ?? null, { ...config, logList: config.logList ?? ctx.logList }), { statusCode: answer.statusCode ?? 200 });
                }
                : undefined,
            sessions: sessionOptions
                ? {
                    manager: new LambderSessionManager({
                        store: sessionOptions.store ?? memorySessionStore,
                        sessionSalt: sessionOptions.sessionSalt ?? "lambder-mock",
                        enableSlidingExpiration: sessionOptions.enableSlidingExpiration,
                        slidingWriteIntervalSeconds: sessionOptions.slidingWriteIntervalSeconds,
                        dataRefresh: sessionOptions.dataRefresh,
                        // A plain-http page (device testing on a LAN) has no
                        // crypto.subtle, and a memory-only store is nothing
                        // anyone can leak, so hashing there protects nothing.
                        // Keyed on the store's own isMemoryOnly rather than on
                        // whether this runtime created it: an app passing its
                        // own LambderMemorySessionStore degrades the same way
                        // instead of throwing on the first session call, and a
                        // store that outlives the process still gets real
                        // hashing.
                        crypto: sessionOptions.crypto
                            ?? (!isWebCryptoAvailable() && (sessionOptions.store?.isMemoryOnly ?? true) ? new LambderPlainSessionCrypto() : undefined),
                    }),
                    tokenCookieKey: this.tokenCookieKey,
                    csrfCookieKey: this.csrfCookieKey,
                    cookieOptions: sessionOptions.cookieOptions,
                }
                : undefined,
            rateLimits: rateLimits
                ? { limiter: rateLimits.limiter ?? memoryLimiter, policies: rateLimits.policies, failOpen: rateLimits.failOpen }
                : undefined,
            guards: options.guards,
            idempotency: idempotencyOptions
                ? {
                    store: idempotencyOptions.store ?? memoryIdempotency,
                    defaultTtlSeconds: idempotencyOptions.defaultTtlSeconds,
                    defaultPendingTtlSeconds: idempotencyOptions.defaultPendingTtlSeconds,
                    failOpen: idempotencyOptions.failOpen,
                    // The engine types this option for the base call context,
                    // the one thing every adapter shares, but hands the
                    // function the running adapter's context, here the mock's.
                    // So it is declared for the mock context (ctx.request is
                    // readable) and widened here, the one place that knows
                    // both sides.
                    callerIdentity: idempotencyOptions.callerIdentity,
                }
                : undefined,
        });
    }
    // -----------------------------------------------------------------------
    // Registry
    // -----------------------------------------------------------------------
    /**
     * The registration-time checks every entry goes through, mocked or not:
     * the ones the server runs on a definition, and the mock's own "a session
     * endpoint needs the sessions option".
     *
     * One place, so no registration path can skip either check. Without the
     * second, a session endpoint on a mock without sessions would register
     * silently and answer its first call with a 500 naming the SERVER's
     * option, for a mistake fixed by one option at create().
     */
    assertEntryRegistration(definition) {
        this.pipeline.assertRegistration(definition);
        if (definition.mode === "session" && !this.pipeline.hasSessions) {
            throw new Error(`LambderMockApp: session endpoint "${definition.name}" needs the sessions option at creation.`);
        }
    }
    buildEntry(name, mode, input) {
        const options = (typeof input === "function" ? { handler: input } : input);
        const definition = {
            name, mode,
            guards: options.guards,
            rateLimit: options.rateLimit,
            idempotency: options.idempotency,
            // No cast: the entry's schema is a z.ZodType, the same type the
            // definition holds. A structural { safeParse } here would let a
            // validator that is not a zod schema reach the 422 body as
            // `zodError: { name: undefined, message: undefined, issues:
            // undefined }`, a refusal a client cannot read.
            input: options.input,
        };
        this.assertEntryRegistration(definition);
        const handler = options.handler;
        return { name, mode, definition, handler: async (ctx) => await handler(ctx), notMockedReason: null };
    }
    /** A mock for a public endpoint: a handler, or the handler with the endpoint's declarations restated. */
    publicApi(name, entry) {
        return this.buildEntry(name, "public", entry);
    }
    /** A mock for a session endpoint: the pipeline fetches the session before the handler runs, and refuses without one. */
    sessionApi(name, entry) {
        return this.buildEntry(name, "session", entry);
    }
    /**
     * A public endpoint deliberately left without a mock; a call answers the
     * notMocked refusal carrying the reason.
     *
     * Public and session get separate builders, as publicApi and sessionApi
     * do, because the refusal runs through the pipeline so the steps BEFORE
     * dispatch still happen, and the session read is one of them. Were every
     * not-mocked endpoint public, a session endpoint with no session would
     * answer "not mocked" where the server answers sessionExpired, and its
     * events and call log would carry the wrong mode. The contract is a type,
     * so the mode cannot be recovered at runtime: the builder has to say it.
     */
    notMocked(name, reason) {
        return this.buildNotMockedEntry(name, "public", reason);
    }
    /** A session endpoint deliberately left without a mock: the session is still read, and refused before the notMocked refusal. */
    sessionNotMocked(name, reason) {
        return this.buildNotMockedEntry(name, "session", reason);
    }
    /**
     * "Everything I did not register is not mocked, for this reason", as an
     * argument to the same register() call:
     *
     * ```ts
     * mockApp.register(userMocks, billingMocks, mockApp.restNotMocked("not mocked yet"));
     * ```
     *
     * It lets mocks be adopted over a contract they do not cover yet:
     * register() stays exhaustive by construction, and endpoints nothing
     * claims answer the notMocked refusal with this reason instead of
     * apiNotFound, so a screen that reaches one says "not mocked yet" rather
     * than "unknown error". Strays and duplicates in the explicit slices are
     * still refused, and an entry registered later (registerPartial, or a
     * second register) takes its endpoint back from the rest.
     *
     * What it cannot do is the session read. The mode of an unregistered name
     * is not knowable at runtime (the contract is a type), so a call it
     * answers is processed as public: the protocol's pre-pass still runs, so
     * a stale client still hears versionExpired, but a signed-out call to an
     * unmocked session endpoint answers "not mocked" where the server answers
     * sessionExpired. Declare an endpoint whose signed-out path a test cares
     * about with sessionNotMocked instead.
     */
    restNotMocked(reason) {
        return { restNotMockedReason: reason };
    }
    buildNotMockedEntry(name, mode, reason) {
        const definition = { name, mode };
        this.assertEntryRegistration(definition);
        return { name, mode, definition, handler: null, notMockedReason: reason };
    }
    /** The entries of one module as a slice, keyed by name. Two entries for one endpoint is an error here. */
    apiSlice(...entries) {
        const slice = {};
        for (const entry of entries) {
            if (slice[entry.name])
                throw new Error(`LambderMockApp: endpoint "${entry.name}" appears twice in one slice.`);
            slice[entry.name] = entry;
        }
        return slice;
    }
    addSlices(slices) {
        this.registry.addSlices(slices);
    }
    /**
     * Registers the whole contract: every endpoint in exactly one slice, or
     * in the reach of a restNotMocked entry passed beside them.
     * Completeness, strays and overlap are checked by the compiler against
     * the contract type; overlap and key-to-name agreement are checked again
     * at runtime for slices built dynamically, and a second rest entry is
     * refused there the way a duplicate name is.
     */
    register(...slices) {
        this.addSlices(slices);
        return this;
    }
    /** Registers some endpoints, for a test that wants three and not three hundred. Overlap is still an error. */
    registerPartial(...slices) {
        this.addSlices(slices);
        return this;
    }
    /**
     * Replaces one endpoint's handler until restored: returns its own undo,
     * which a test scopes with try/finally. The entry's declarations (mode,
     * guards, rate limit, idempotency) stay as registered; only the handler
     * changes.
     *
     * Overrides nest. A second override over the same endpoint stands on the
     * first, and restoring it uncovers the first rather than the registry, so
     * an override one `it` scoped cannot drop the one a describe put in place
     * around it.
     */
    override(name, handler) {
        const base = this.registry.registered(name);
        // A name with no entry has no declarations to keep, and inventing a
        // public one would answer a session endpoint with no session, no
        // guards and no rate limit: a test would read that as a pass for a
        // call the server refuses. Register it first, then override it.
        if (!base) {
            throw new Error(`LambderMockApp: override("${name}") has nothing to override. Register the endpoint first (register or registerPartial), then override its handler.`);
        }
        const entry = { ...base, handler: async (ctx) => await handler(ctx), notMockedReason: null };
        return this.registry.pushOverride(name, entry);
    }
    /** Puts every overridden handler back, however deeply they were stacked. */
    restoreOverrides() {
        this.registry.restoreOverrides();
    }
    /** The registered endpoint names. */
    get registeredNames() {
        return this.registry.names;
    }
    /**
     * Whether a call to this name would be answered from the registry, which
     * is what an adapter asks before passing one on.
     *
     * True for every name once a rest entry is registered, since it answers
     * whatever nothing else claimed. That makes a rest entry and the MSW
     * adapter's `onUnmocked: "passthrough"` alternatives rather than layers:
     * with one registered, nothing is handed on to the network.
     */
    hasRegisteredEntry(apiName) {
        return this.entryFor(apiName) !== null || this.registry.restNotMockedReason !== null;
    }
    entryFor(apiName) {
        return this.registry.entryFor(apiName);
    }
    /**
     * The entry that answers a name nothing registered, when register() was
     * given a rest entry: the notMocked refusal carrying its reason, run
     * through the pipeline as a public endpoint, since the mode of an
     * unregistered name cannot be recovered at runtime. Everything before
     * dispatch still runs (the signature gate, the payload restore); the
     * missing session read is the fidelity limit restNotMocked documents.
     */
    restNotMockedEntry(apiName) {
        const reason = this.registry.restNotMockedReason;
        if (reason === null)
            return null;
        return { name: apiName, mode: "public", definition: { name: apiName, mode: "public" }, handler: null, notMockedReason: reason };
    }
    // -----------------------------------------------------------------------
    // Control surface
    // -----------------------------------------------------------------------
    /** The next call to the endpoint fails this way; several calls queue in order. */
    failNext(apiName, failure) {
        this.failures.failNext(apiName, failure);
    }
    /** Every call to the endpoint fails this way until cleared with null. */
    setFailure(apiName, failure) {
        this.failures.setFailure(apiName, failure);
    }
    /** Every call rejects at the transport, as with no network at all. */
    setOffline(offline) {
        this.failures.setOffline(offline);
    }
    setLatency(latency) {
        this.failures.setLatency(latency);
    }
    /**
     * Rewinds the runtime: sessions, rate-limit counters, replay records,
     * overrides, injected failures, the offline switch, the configured
     * latency, the call log and its numbering, the cookies its own transports
     * hold, then onReset, so the app rewinds its own data too.
     *
     * The cookies matter as much as the sessions: a jar still holding the
     * token of an emptied store's session reads as signed in until an answer
     * says sessionExpired. So every jar transport() built for itself is
     * emptied, and the cookies a "document" transport mirrored are expired.
     *
     * The registry survives, being configuration rather than accumulated
     * state. Subscriptions survive too, being how a test watches the runtime;
     * a listener muted for throwing is unmuted, so one bad call does not
     * silence it for the rest of the run. A session store or cookie jar the
     * app supplied survives: the runtime did not create it and does not know
     * what else holds it.
     */
    reset() {
        this.sessionStore?.reset();
        this.rateLimiter?.reset();
        this.idempotencyStore?.reset();
        this.registry.restoreOverrides();
        this.failures.reset();
        this.recorder.reset();
        this.browserCookies.reset();
        this.onReset?.();
    }
    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------
    /**
     * The four session members refuse in the mock's own words, naming the
     * option a mock is created with. The pipeline's guard names the SERVER's
     * option (`session`), which a reader does not find on the mock's create()
     * (`sessions`); assertEntryRegistration does the same for registration.
     */
    assertSessionsConfigured(member) {
        if (!this.pipeline.hasSessions)
            throw new Error(`LambderMockApp: ${member} needs the sessions option at creation.`);
    }
    /** The session manager, for tests that inspect or manipulate sessions directly. Throws when sessions are off. */
    get sessionManager() {
        this.assertSessionsConfigured("sessionManager");
        return this.pipeline.sessionManager;
    }
    /**
     * Starts a session without a login endpoint: creates it through the
     * session controller, the way a login handler does, plants its cookies
     * into the jar when one is given, so the jar's transport is signed in
     * from its next call, and mirrors the readable ones into document.cookie
     * the way an answer's cookies are. Returns the raw tokens too.
     */
    async signIn(sessionKey, data, options = {}) {
        this.assertSessionsConfigured("signIn()");
        // The app's one cookie host unless this call names another: planted
        // under a host the transport does not read them back at, the cookies
        // are simply never sent, and every session call answers sessionExpired
        // with a full jar.
        const host = options.host ?? this.cookieHost;
        const ctx = createApiCallContext();
        const controller = this.pipeline.sessionController(ctx, { host, cookies: {}, csrfToken: null });
        const created = await controller.issueSession(sessionKey, data, options.ttlSeconds ?? this.sessionTtlSeconds);
        const headers = {};
        ctx.responseHeaders.applyInto(headers);
        const setCookies = getAnswerHeader(headers, "Set-Cookie") ?? [];
        // Planted for the host the controller wrote them for: a jar checks
        // every Domain against the sending host and refuses one it cannot
        // check, so unscoped, the session cookie of an app that configures a
        // cookie domain would be dropped silently.
        options.jar?.storeSetCookies(setCookies, { host });
        // Through the same mirror every other cookie writer uses. Behind the
        // MSW adapter the page's caller reads its CSRF token from
        // document.cookie, not the jar, so a signIn that only filled a jar
        // would leave the token empty and every session call would answer
        // sessionExpired.
        this.browserCookies.mirrorSetCookies(setCookies);
        return created;
    }
    /**
     * Ends every session of the subject ("log this subject out everywhere")
     * and clears what signIn planted: the cookies in the jar given, and the
     * copies in document.cookie.
     *
     * Symmetric on purpose, the way reset() is. The records alone leave the
     * jar and the page carrying a token for a session that no longer exists,
     * which reads as signed in until an answer says otherwise.
     */
    async signOut(sessionKey, options = {}) {
        this.assertSessionsConfigured("signOut()");
        await this.pipeline.sessionManager.deleteSessionAllByKey(sessionKey);
        const host = options.host ?? this.cookieHost;
        // The scope signIn planted under: a deletion only reaches a cookie
        // carrying the same Domain and Path, so it is built from the app's own
        // cookie options rather than from defaults.
        const cleared = [
            serializeClearCookie(this.tokenCookieKey, { ...this.sessionCookieOptions, httpOnly: true }, host),
            serializeClearCookie(this.csrfCookieKey, this.sessionCookieOptions, host),
        ];
        options.jar?.storeSetCookies(cleared, { host });
        this.browserCookies.mirrorSetCookies(cleared);
    }
    /** Marks the subject's session data stale, so the next read renews it through dataRefresh. */
    async expireSessionData(sessionKey) {
        this.assertSessionsConfigured("expireSessionData()");
        await this.pipeline.sessionManager.expireSessionDataAllByKey(sessionKey);
    }
    // -----------------------------------------------------------------------
    // Observation
    // -----------------------------------------------------------------------
    /**
     * Listens to every call, both phases. Keyed, so a hot-reloaded module
     * replaces its own listener instead of stacking a duplicate. Returns the
     * unsubscribe.
     */
    subscribe(key, listener) {
        return this.recorder.subscribe(key, listener);
    }
    /** The completed calls, oldest first, bounded by callLogSize. */
    get calls() {
        return this.recorder.calls;
    }
    emit(event) {
        this.recorder.emit(event);
    }
    // -----------------------------------------------------------------------
    // Handling a call
    // -----------------------------------------------------------------------
    /** The context one call runs on: the core's call context plus what mock guards and handlers see. */
    createContext(request) {
        const pipeline = this.pipeline;
        const base = createApiCallContext();
        const ctx = Object.assign(base, {
            apiName: request.apiName,
            request,
            signal: request.signal ?? new AbortController().signal,
            envelope: {},
            payload: request.payload,
            guardInputs: request.guardInputs,
            // The key as a handler can use it. A non-string is not a key: the
            // engine refuses one with a 400 on every endpoint that declares
            // idempotency, and on one that does not it is a value nothing
            // reads, so handing it over typed as a string would be the lie.
            idempotencyKey: typeof request.idempotencyKey === "string" ? request.idempotencyKey : undefined,
        });
        // The controller reads and writes this very context, so it is bound
        // after it, the way the server binds its own. Without sessions
        // configured, touching it says why.
        const chargeRateLimit = async (policy, key, refuse) => {
            const { checkResult, refusal } = await pipeline.chargeRateLimit(policy, { apiName: request.apiName, ip: request.ip, session: ctx.session, key });
            if (refuse && refusal)
                throw refusal;
            return checkResult;
        };
        bindCallTools(ctx, {
            getters: {
                sessionController: () => {
                    if (!pipeline.hasSessions)
                        throw new Error(`LambderMockApp: ctx.sessionController on "${request.apiName}" needs the sessions option at creation.`);
                    return pipeline.sessionController(ctx, LambderApiPipeline.sessionInfoOf(request));
                },
            },
            methods: {
                rateLimit: async (policy, key) => { await chargeRateLimit(policy, key, true); },
                isRateLimited: (policy, key) => chargeRateLimit(policy, key, false),
            },
        });
        return ctx;
    }
    /** What a call looks like on the way in, for the runtime's own calls and for one an adapter passes on. */
    requestEvent(id, request, mode, at) {
        return {
            phase: "request", id, apiName: request.apiName, mode,
            payload: request.payload, guardInputs: request.guardInputs, idempotencyKey: request.idempotencyKey,
            version: request.version, signature: request.signature, headers: request.headers,
            hasSessionCookie: (request.cookies[this.tokenCookieKey]?.length ?? 0) > 0,
            at,
        };
    }
    /**
     * Records a call an adapter handed on instead of answering: the MSW
     * adapter's passthrough. Without it a name the registry does not know
     * leaves no trace at all, and a mistyped endpoint reaches the real
     * network with nothing in the call log or on the subscription to say so,
     * which is the one failure the log exists to make visible.
     */
    notePassthrough(request) {
        const facts = this.callFacts(this.recorder.nextCallId(), request, null);
        this.emit(this.requestEvent(facts.id, request, null, facts.startedAt));
        this.recorder.settle(facts, { answer: null, outcome: "passthrough", guardsRun: [] });
    }
    /** What every record of one call repeats (see LambderMockCallFacts). */
    callFacts(id, request, mode) {
        return { id, apiName: request.apiName, mode, startedAt: Date.now(), request };
    }
    /** One call from a parsed request to its answer, events included. The entry point every transport and adapter shares. */
    async handleRequest(request) {
        const id = this.recorder.nextCallId();
        const registered = this.entryFor(request.apiName);
        // The rest entry answers whatever nothing registered, when register()
        // was given one. The mode reported stays the registered entry's, so it
        // is null here exactly as it is for a name the registry does not know:
        // the rest answer is processed as public, which is a property of the
        // answer rather than a claim about the endpoint.
        const entry = registered ?? this.restNotMockedEntry(request.apiName);
        const mode = registered?.mode ?? null;
        const facts = this.callFacts(id, request, mode);
        const startedAt = facts.startedAt;
        const ctx = this.createContext(request);
        // The pipeline's own trace, handed in rather than read off what run()
        // returns: a crash unwinds past the return, and the guards that ran
        // before it are exactly what a developer reading the call log is
        // looking for. Written as the call goes, so it survives the throw.
        const trace = { guardsRun: [], replayed: false };
        let answer;
        let outcome;
        let error;
        try {
            // The protocol's pre-pass, run before the name is resolved, as on
            // the server. Otherwise an unknown name would reach the notFound
            // refusal without the signature gate or the payload restore (a
            // stale client or a malformed compressed payload answered unlike
            // the server), and the request event would carry the wire fields
            // instead of the payload, so a dev panel would show nothing for
            // exactly the compressed calls. run() calls prepare again, which
            // is safe by construction.
            const prepared = await this.pipeline.prepare(request);
            this.emit(this.requestEvent(id, request, mode, startedAt));
            await this.failures.wait(this.failures.latencyFor(request.apiName), request.signal);
            if (this.failures.offline)
                throw new LambderMockTransportError("offline");
            // Taken after the wait and the offline check, both of which end
            // the call before it reaches a handler: taken first, a queued
            // failNext would be spent on a call it never got to fail, and the
            // next call, the one the test arranged it for, would answer
            // normally.
            const failure = this.failures.take(request.apiName);
            if (failure) {
                answer = await this.failures.answerFor(failure, request);
                outcome = "injected";
            }
            else if (prepared) {
                answer = prepared;
            }
            else if (!entry) {
                answer = this.pipeline.answerUnknownApi(ctx);
                outcome = "unknownApi";
            }
            else {
                const handler = entry.handler;
                const result = await this.pipeline.run(request, ctx, entry.definition, handler
                    ? async (callCtx) => {
                        // The payload the handler sees is the restored one.
                        callCtx.payload = request.payload;
                        const payload = await handler(callCtx);
                        return envelopeAnswer(buildApiEnvelope(this.apiVersion, payload === undefined ? null : payload, {
                            message: callCtx.envelope.message,
                            logList: callCtx.logList,
                        }));
                    }
                    // A notMocked entry refuses where a handler would run, not
                    // ahead of the pipeline, so the steps that precede
                    // dispatch still happen: a stale client hears
                    // versionExpired as it would from the server, and a
                    // compressed payload reaches the events.
                    : async () => {
                        throw new LambderApiRefusal(`Not mocked: ${entry.notMockedReason}`, {
                            errorMessage: { type: "warning", code: LAMBDER_REFUSAL_CODES.notMocked, content: `"${request.apiName}" is not mocked: ${entry.notMockedReason}` },
                        });
                    }, trace);
                answer = result.answer;
                if (result.replayed)
                    outcome = "replayed";
            }
        }
        catch (err) {
            if (err instanceof LambderMockTransportError) {
                this.recorder.settle(facts, { answer: null, outcome: "injected", guardsRun: trace.guardsRun, error: err });
                throw err;
            }
            error = coerceToError(err);
            // A mock runtime is a development tool: the point of a handler
            // that threw is the message it threw, and replacing it with the
            // server's wording sends a developer looking through a call log
            // for what could have been on the screen. Apps that want the
            // production shape turn it off.
            answer = this.revealHandlerErrors
                ? envelopeAnswer(buildApiEnvelope(this.apiVersion, null, { errorMessage: error.message }), { statusCode: 500 })
                : crashAnswer(this.apiVersion);
            outcome = "crash";
        }
        // Every header written during the call belongs on the answer, however
        // the call ended. The pipeline applies them to the answers it produces,
        // but a crash unwinds past it and an injected failure never reaches
        // it: a handler that created a session and then threw would otherwise
        // leave the jar with no cookie and nothing to explain it. applyInto is
        // idempotent, so answers the pipeline already handled are unaffected.
        ctx.responseHeaders.applyInto(answer.headers);
        this.recorder.settle(facts, { answer, guardsRun: trace.guardsRun, ...(outcome ? { outcome } : {}), ...(error ? { error } : {}) });
        return answer;
    }
    /**
     * A transport request as the core's request: the envelope read the way the
     * server reads it. Public because the adapters call it, which is what
     * keeps them from each reading a transport request their own way.
     */
    requestFromTransport(transportRequest) {
        const info = {
            headers: lowercaseHeaderNames(transportRequest.headers),
            cookies: cookieValuesByName(transportRequest.cookies ?? []),
            // One textual form per address, as the server's own context
            // resolves it: a `per: "ip"` limit keyed on whatever spelling a
            // caller wrote is a limit that does not limit, and a test written
            // over it proves less than it looks like it does.
            ip: normalizeClientIp(transportRequest.clientIp ?? this.defaultClientIp),
            host: transportRequest.siteHost || this.cookieHost,
            ...(transportRequest.signal ? { signal: transportRequest.signal } : {}),
        };
        // Through the wire's own serialization, as every server-bound
        // transport sends it: the handler gets a parse of the JSON, never the
        // page's object. Handed over by reference, a handler that stores the
        // payload would share it with the page's form (later edits changing
        // the "saved" record with no call), a Date would stay a Date and a
        // key set to undefined keep its place, none of which a server sees.
        const envelope = JSON.parse(JSON.stringify(buildTransportEnvelope(transportRequest)));
        const request = readApiEnvelope(envelope, info);
        if (!request)
            throw new Error("LambderMockApp: the transport request names no api.");
        return request;
    }
    /** One call from a transport request to its answer: what the mock transport and the adapters call. */
    async handle(transportRequest) {
        return await this.handleRequest(this.requestFromTransport(transportRequest));
    }
    // -----------------------------------------------------------------------
    // Transports
    // -----------------------------------------------------------------------
    /**
     * The direct transport: a caller's request into handle(), the answer
     * back in the form the caller reads, cookies carried by a jar the way
     * a browser carries them. Each transport gets its own jar unless one is
     * given, so two transports hold two sessions; the jar is on the returned
     * transport as `cookieJar`, so a test can read or clear the one it did
     * not create itself, and reset() empties it.
     */
    transport(options = {}) {
        const clientIp = options.clientIp ?? this.defaultClientIp;
        const direct = async (request) => toHttpAnswer(await this.handle({ ...request, clientIp: request.clientIp ?? clientIp }));
        const cookies = options.cookies ?? "memory";
        if (cookies === false)
            return transportCarrying(direct, null);
        const jar = cookies instanceof LambderCookieJar ? cookies : new LambderCookieJar();
        // A jar this runtime built is this runtime's to empty on reset; one
        // the caller passed is the caller's, the way an app-supplied session
        // store is.
        if (jar !== cookies)
            this.browserCookies.adoptJar(jar);
        // The runtime's one cookie host, so the jar scopes what it sends the
        // way the browser this transport stands in for would; scoped to
        // whatever host a caller names, cookies signIn planted would go
        // unsent.
        const withJar = lambderCookieJarTransport(direct, { jar, csrfCookieKey: this.csrfCookieKey, host: this.cookieHost });
        // Where the page's readable cookies live, one answer per mode. In
        // memory mode it is this jar alone, so the token the caller read is
        // dropped and the jar fills in its own CSRF cookie. A page's caller
        // reading document.cookie would find what signIn mirrors for the MSW
        // adapter's sake and no later answer of this transport writes, so
        // after a logout and a login it would post the first session's token
        // and be signed out.
        if (cookies !== "document")
            return transportCarrying(async (request) => await withJar({ ...request, token: "" }), jar);
        // The page's own cookie storage sees the non-HttpOnly cookies (the
        // CSRF token), so the caller's cookie read and clear paths run for
        // real; the HttpOnly session cookie stays in the jar, as a browser
        // would keep it out of document.cookie.
        return transportCarrying(async (request) => {
            const answer = await withJar(request);
            this.mirrorCookiesIntoDocument(answer.setCookies ?? []);
            return answer;
        }, jar);
    }
    /**
     * Mirrors an answer's non-HttpOnly cookies into document.cookie and
     * remembers them, so reset() expires them again. The direct transport's
     * "document" mode and the MSW adapter both come through here: one
     * implementation of the mirror, one record of what was planted.
     */
    mirrorCookiesIntoDocument(setCookies) {
        this.browserCookies.mirrorSetCookies(setCookies);
    }
    /**
     * Takes a jar an adapter built for itself as the runtime's own, so reset()
     * empties it with the rest. The MSW adapter's jar holds the session
     * cookies of calls that never touch transport(); left full after a reset,
     * the next request would carry a token for a session the emptied store no
     * longer has.
     */
    adoptCookieJar(jar) {
        this.browserCookies.adoptJar(jar);
    }
    /** caller.setTransport(mockApp.transport(options)); returns the transport, its jar on it. */
    attach(caller, options = {}) {
        const transport = this.transport(options);
        caller.setTransport(transport);
        return transport;
    }
}
/**
 * Fixes the contract and session data types, then hands out the guard
 * builder bound to the mock's contexts and the create() that infers
 * everything else (the guard map, the rate-limit policies) from its options.
 * Curried for the same reason initLambder is: TypeScript type arguments are
 * all-or-nothing per call.
 *
 * ```ts
 * const mock = initLambderMock<ApiContractType, SessionData>();
 * const mockApp = mock.create({
 *     apiVersion: "1.4.0",
 *     sessions: true,
 *     guards: { tenant: mock.guard({ guardInput: z.object({ tenantId: z.uuid() }), session: true, handler: ... }) },
 * });
 * ```
 */
export const initLambderMock = () => ({
    /** Builds a mock guard: the server guard's shape, the handler seeing the mock's contexts. */
    guard: lambderGuardBuilder(),
    /**
     * Builds a mock rate-limit key, the counterpart of `guard`. Bound to the
     * mock's own call context, because the server's lambderRateLimitKey() is
     * bound to the render context and a handler written with it compiles here
     * while reading fields the mock context does not have.
     */
    rateLimitKey: lambderRateLimitKeyBuilder(),
    /**
     * The mock app, with the guard map and the rate-limit policies inferred
     * from the options.
     *
     * `const` on each of them pins a restatement to the contract, at a cost:
     * inferring a generic from an object literal switches excess-property
     * checking off for the whole literal, nested objects included, so a typo
     * inside `rateLimits.policies` or `idempotency` would compile and be
     * dropped. `I` exists for the same reason `P` does, and
     * LambderMockSurplusKeys puts the error back on the key.
     */
    create(options) {
        return new LambderMockApp(options);
    },
});

import { LambderApiPipeline } from "../api/LambderApiPipeline.js";
import { readApiEnvelope, cookieValuesByName, lowercaseHeaderNames } from "../api/LambderApiRequest.js";
import { createApiCallContext } from "../api/LambderApiCallContext.js";
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
 * Lambda server runs) over memory stores, with a registry of typed mock
 * handlers where the server has app handlers, and mock guards where it has
 * app guards. Everything the protocol does (envelope, refusals, sessions
 * and their cookies, guards, rate limits, idempotency, the version gate)
 * happens in the core; this class only resolves a name to an entry, wraps
 * the handler's return into the envelope, and adds what a mock needs on
 * top: failure injection, latency, a subscription, a call log, reset.
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
     * The client IP a transport request carrying none is read as. Public
     * because an adapter has to read the same default the direct transport
     * uses: the MSW adapter had a hardcoded "127.0.0.1" of its own, so an app
     * that set defaultClientIp saw one address through the transport and
     * another through the service worker, and a per-IP rate limit counted two
     * clients where there was one.
     */
    defaultClientIp;
    /** The host this runtime's cookies belong to (see the cookieHost option). */
    cookieHost;
    /**
     * The API core, every protocol step of it. Private: the mock's surface is
     * the app, and a consumer reaching past it would be configuring the
     * server's pipeline through a development tool. The three adapters take
     * what they need from the app's own methods (handleRequest,
     * requestFromTransport), which is why none of them names this.
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
        // The loopback address when nothing names a client, as a request from
        // the page itself, and the same constant the in-process handler
        // transport defaults to. Normalized here rather than at every reader:
        // one textual form per address is what makes a per-IP rate limit's
        // counter one counter, and this value is read by the direct transport,
        // by the MSW adapter and by every request that names no client.
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
            maxRequestPayloadBytes: options.maxRequestPayloadBytes,
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
                        // "did this runtime create it": an app that passes its
                        // own LambderMemorySessionStore got WebCrypto and threw
                        // on the first session call where the default path
                        // degrades, and a store that outlives the process still
                        // gets real hashing, which is what the declaration is
                        // there to say.
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
                    // The engine's own option is typed for the base call
                    // context, being the one thing every adapter shares; what
                    // it actually hands the function is the context of the
                    // adapter running it, which here is the mock's. So the
                    // option is declared for the mock context, where a reader
                    // can use ctx.request, and widened at the one place that
                    // knows both sides.
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
     * One place, so no registration path can skip either check. A session
     * endpoint on a mock without sessions would otherwise register silently
     * and answer the first call with a 500 from inside the pipeline, naming
     * the SERVER's option name, for a mistake whose fix is one option at
     * create().
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
     * Public and session have separate builders for the same reason publicApi
     * and sessionApi do: the refusal runs through the pipeline so that the
     * steps BEFORE dispatch still happen, and the session read is one of them.
     * Declaring every not-mocked endpoint public switched that step off, so a
     * session endpoint with no session answered "not mocked" where the server
     * answers sessionExpired, and the mode on its events and call log was
     * wrong too. The mode cannot be recovered at runtime, because the contract
     * is a type, so the builder is where it has to be said.
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
     * What it buys is adoption over a contract the mocks do not cover yet:
     * register() stays exhaustive by construction, and the endpoints nothing
     * claims answer the notMocked refusal carrying this reason instead of
     * apiNotFound, so a screen that reaches one says "not mocked yet" rather
     * than "unknown error". Strays and duplicates in the explicit slices are
     * refused exactly as they are without it, and an entry registered later
     * (registerPartial, or a second register) takes the endpoint back from the
     * rest.
     *
     * The one thing it cannot do is the session read. A call it answers is
     * processed as a public endpoint: the protocol's pre-pass still runs, so a
     * stale client still hears versionExpired, but the mode of a name nothing
     * registered is not knowable at runtime, the contract being a type. So a
     * signed-out call to an unmocked session endpoint is answered "not mocked"
     * where the server answers sessionExpired, and the endpoint whose
     * signed-out path a test cares about is the one to declare with
     * sessionNotMocked instead.
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
     * True for every name once a rest entry is registered, because the rest
     * entry is what answers the names nothing else claimed. That is what makes
     * a rest entry and the MSW adapter's `onUnmocked: "passthrough"`
     * alternatives rather than layers: with one registered, the runtime
     * answers everything itself and nothing is handed on to the network.
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
     * through the pipeline as a public endpoint.
     *
     * Public because the mode of an unregistered name cannot be recovered at
     * runtime, the contract being a type. Everything that precedes dispatch
     * still runs (the version gate, the payload restore); the session read is
     * the one step this answer cannot have, which is the fidelity limit
     * restNotMocked documents.
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
     * The cookies matter as much as the sessions do: emptying the session
     * store while a jar still holds the token for one of them leaves the next
     * call carrying a session that no longer exists, which reads as signed in
     * until the answer says sessionExpired. So every jar transport() built
     * for itself is emptied, and the cookies a "document" transport mirrored
     * are expired again.
     *
     * The registry survives, being what the runtime was configured with
     * rather than what it accumulated. Subscriptions survive too, because
     * they are how a test watches the runtime rather than state it is
     * testing; a listener muted for throwing is unmuted, so one bad call does
     * not silence it for the rest of the run. A session store or a cookie jar
     * the app supplied itself survives: the runtime did not create it and
     * does not know what else holds it.
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
     * option a mock is created with.
     *
     * The pipeline's guard says "Configure the session option at creation",
     * which is the SERVER's option name: the mock's is `sessions`, and a
     * reader who goes looking for `session` on create() does not find it.
     * The registration path was fixed for exactly this one method over.
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
        // The host these cookies came from, which is the same one the
        // controller wrote them for. A jar checks every Domain against the
        // sending host and refuses one it cannot check, so planting them
        // unscoped dropped the session cookie of any app that configures a
        // cookie domain, silently.
        options.jar?.storeSetCookies(setCookies, { host });
        // Through the same mirror every other cookie writer uses. Behind the
        // MSW adapter the jar is not where a page reads its CSRF token: the
        // browser caller reads document.cookie and posts what it finds, so a
        // signIn that only filled a jar left the token empty and every one of
        // the session endpoints answered sessionExpired.
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
            sessions: undefined,
        });
        // The controller reads and writes this very context, so it is built
        // after it. Without sessions configured, touching it says why.
        Object.defineProperty(ctx, "sessions", {
            enumerable: true,
            get() {
                if (!pipeline.hasSessions)
                    throw new Error(`LambderMockApp: ctx.sessions on "${request.apiName}" needs the sessions option at creation.`);
                return pipeline.sessionController(ctx, LambderApiPipeline.sessionInfoOf(request));
            },
        });
        return ctx;
    }
    /** What a call looks like on the way in, for the runtime's own calls and for one an adapter passes on. */
    requestEvent(id, request, mode, at) {
        return {
            phase: "request", id, apiName: request.apiName, mode,
            payload: request.payload, guardInputs: request.guardInputs, idempotencyKey: request.idempotencyKey,
            version: request.version, headers: request.headers,
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
            // The protocol's pre-pass, run before the name is resolved, which
            // is where the server runs it. Two things depended on it: an
            // unknown name reached the notFound refusal without the version
            // gate or the payload restore, so a stale client or a malformed
            // compressed payload was answered differently here than on the
            // server; and the request event carried the wire fields instead of
            // the payload, so a dev panel watching calls in flight showed
            // nothing for exactly the compressed calls someone opens a panel
            // for. run() calls prepare again, which is safe by construction.
            const prepared = await this.pipeline.prepare(request);
            this.emit(this.requestEvent(id, request, mode, startedAt));
            await this.failures.wait(this.failures.latencyFor(request.apiName), request.signal);
            if (this.failures.offline)
                throw new LambderMockTransportError("offline");
            // After the wait and the offline check, both of which end the call
            // before it reaches a handler: taking the failure first spent a
            // queued failNext on a call that never got to be failed by it, and
            // the next call, the one the test was arranging for, then answered
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
                answer = this.pipeline.answerUnknownApi(request, ctx);
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
                    // ahead of the pipeline: answering it directly skipped the
                    // steps that precede dispatch, so a stale client heard
                    // "not mocked" from a mock the server would have answered
                    // versionExpired to, and a compressed payload never reached
                    // the events at all.
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
        // Every header written during the call belongs on the answer, whichever
        // way the call ended. The pipeline does this for the answers it
        // produces itself, but a crash unwinds past it and an injected failure
        // never reaches it, and those are the two that hurt most in
        // development: a handler that created a session and then threw would
        // otherwise leave the jar with no cookie and nothing to explain it.
        // applyInto is idempotent, so the answers the pipeline already handled
        // are unaffected.
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
        const request = readApiEnvelope(buildTransportEnvelope(transportRequest), info);
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
        // way the browser this transport stands in for would. Without it the
        // scope was whatever host the caller happened to name, which is the
        // page's, and cookies signIn planted went unsent.
        const withJar = lambderCookieJarTransport(direct, { jar, csrfCookieKey: this.csrfCookieKey, host: this.cookieHost });
        if (cookies !== "document")
            return transportCarrying(withJar, jar);
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
     * cookies of calls that never touch transport(), and a reset that leaves
     * it full is the same stale-session bug: the store is empty and the next
     * request still carries a token for one of its sessions.
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
     * `const` on each of them is what pins a restatement to the contract, and
     * it has one cost: inferring a generic from an object literal switches
     * excess-property checking off for the whole literal, nested objects
     * included, so a typo inside `rateLimits.policies` or `idempotency`
     * compiled and was dropped in silence. `I` exists for the same reason `P`
     * does, and LambderMockSurplusKeys puts the error back on the key.
     */
    create(options) {
        return new LambderMockApp(options);
    },
});

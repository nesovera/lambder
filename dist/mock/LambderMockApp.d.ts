import type { z } from "zod";
import type { LambderApiContractShape } from "../shared/wire/LambderApiContract.js";
import { type LambderApiRequest } from "../api/LambderApiRequest.js";
import { type LambderApiAnswer } from "../api/LambderApiAnswer.js";
import { type LambderApiTransport, type LambderApiTransportRequest } from "../shared/transport/LambderApiTransport.js";
import { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
import { type LambderApiGuard, type LambderGuardBuilder } from "../api/LambderApiGuards.js";
import { LambderMemoryRateLimiter } from "../stores/LambderMemoryRateLimiter.js";
import { LambderMemoryIdempotencyStore } from "../stores/LambderMemoryIdempotencyStore.js";
import { LambderMemorySessionStore } from "../stores/LambderMemorySessionStore.js";
import LambderSessionManager, { type LambderCreatedSession } from "../session/LambderSessionManager.js";
import type { LambderMockAppOptions, LambderMockIdempotencyOptions, LambderMockTransport, LambderMockTransportOptions } from "./LambderMockCreateOptions.js";
import type { LambderMockCallContext, LambderMockCallRecord, LambderMockEntry, LambderMockEntryInput, LambderMockFailure, LambderMockFailureReason, LambderMockHandler, LambderMockLatency, LambderMockListener, LambderMockPublicNames, LambderMockRateLimitPolicies, LambderMockRegistryCheck, LambderMockRestEntry, LambderMockSessionCallContext, LambderMockSessionNames, LambderMockSlice, LambderMockOverride } from "./LambderMockTypes.js";
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
export declare class LambderMockApp<C extends LambderApiContractShape, S = any, G extends Record<string, LambderApiGuard<any, any, any>> = {}> {
    readonly apiVersion: string | null;
    /** The memory stores, for assertions and reset; null for a subsystem that is off or backed by a store of yours. */
    readonly sessionStore: LambderMemorySessionStore<S> | null;
    readonly rateLimiter: LambderMemoryRateLimiter | null;
    readonly idempotencyStore: LambderMemoryIdempotencyStore | null;
    readonly tokenCookieKey: string;
    readonly csrfCookieKey: string;
    /**
     * The client IP a transport request carrying none is read as. Public
     * because an adapter has to read the same default the direct transport
     * uses: the MSW adapter had a hardcoded "127.0.0.1" of its own, so an app
     * that set defaultClientIp saw one address through the transport and
     * another through the service worker, and a per-IP rate limit counted two
     * clients where there was one.
     */
    readonly defaultClientIp: string;
    /** The host this runtime's cookies belong to (see the cookieHost option). */
    readonly cookieHost: string;
    /**
     * The API core, every protocol step of it. Private: the mock's surface is
     * the app, and a consumer reaching past it would be configuring the
     * server's pipeline through a development tool. The three adapters take
     * what they need from the app's own methods (handleRequest,
     * requestFromTransport), which is why none of them names this.
     */
    private readonly pipeline;
    /** The cookie scope signIn plants under, so signOut can name the same one when it clears them. */
    private readonly sessionCookieOptions;
    private readonly sessionTtlSeconds;
    private readonly onReset;
    private readonly revealHandlerErrors;
    /** Injected failures, the offline switch and the configured latency (see LambderMockFailureInjector). */
    private readonly failures;
    /** Subscriptions and the bounded call log (see LambderMockCallRecorder). */
    private readonly recorder;
    /** Registered entries and the overrides over them (see LambderMockEntryRegistry). */
    private readonly registry;
    /** The jars the runtime owns and what it planted in document.cookie (see LambderMockBrowserCookies). */
    private readonly browserCookies;
    constructor(options: LambderMockAppOptions<C, S, G>);
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
    private assertEntryRegistration;
    private buildEntry;
    /** A mock for a public endpoint: a handler, or the handler with the endpoint's declarations restated. */
    publicApi<K extends LambderMockPublicNames<C>, TInputSchema extends z.ZodType = z.ZodType>(name: K, entry: LambderMockEntryInput<C, K, S, G, TInputSchema>): LambderMockEntry<C, K>;
    /** A mock for a session endpoint: the pipeline fetches the session before the handler runs, and refuses without one. */
    sessionApi<K extends LambderMockSessionNames<C>, TInputSchema extends z.ZodType = z.ZodType>(name: K, entry: LambderMockEntryInput<C, K, S, G, TInputSchema>): LambderMockEntry<C, K>;
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
    notMocked<K extends LambderMockPublicNames<C>>(name: K, reason: string): LambderMockEntry<C, K>;
    /** A session endpoint deliberately left without a mock: the session is still read, and refused before the notMocked refusal. */
    sessionNotMocked<K extends LambderMockSessionNames<C>>(name: K, reason: string): LambderMockEntry<C, K>;
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
    restNotMocked(reason: string): LambderMockRestEntry;
    private buildNotMockedEntry;
    /** The entries of one module as a slice, keyed by name. Two entries for one endpoint is an error here. */
    apiSlice<const E extends readonly LambderMockEntry<C, keyof C & string>[]>(...entries: E): LambderMockSlice<C, E[number]["name"]>;
    private addSlices;
    /**
     * Registers the whole contract: every endpoint in exactly one slice, or
     * in the reach of a restNotMocked entry passed beside them.
     * Completeness, strays and overlap are checked by the compiler against
     * the contract type; overlap and key-to-name agreement are checked again
     * at runtime for slices built dynamically, and a second rest entry is
     * refused there the way a duplicate name is.
     */
    register<const Slices extends readonly (Record<string, LambderMockEntry<C, any>> | LambderMockRestEntry)[]>(...slices: Slices & LambderMockRegistryCheck<C, Slices>): this;
    /** Registers some endpoints, for a test that wants three and not three hundred. Overlap is still an error. */
    registerPartial(...slices: readonly Record<string, LambderMockEntry<C, any>>[]): this;
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
    override<K extends keyof C & string>(name: K, handler: LambderMockHandler<C, K, S, G>): LambderMockOverride;
    /** Puts every overridden handler back, however deeply they were stacked. */
    restoreOverrides(): void;
    /** The registered endpoint names. */
    get registeredNames(): string[];
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
    hasRegisteredEntry(apiName: string): boolean;
    private entryFor;
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
    private restNotMockedEntry;
    /** The next call to the endpoint fails this way; several calls queue in order. */
    failNext(apiName: keyof C & string, failure: LambderMockFailure | LambderMockFailureReason): void;
    /** Every call to the endpoint fails this way until cleared with null. */
    setFailure(apiName: keyof C & string, failure: LambderMockFailure | LambderMockFailureReason | null): void;
    /** Every call rejects at the transport, as with no network at all. */
    setOffline(offline: boolean): void;
    setLatency(latency: LambderMockLatency): void;
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
    reset(): void;
    /**
     * The four session members refuse in the mock's own words, naming the
     * option a mock is created with.
     *
     * The pipeline's guard says "Configure the session option at creation",
     * which is the SERVER's option name: the mock's is `sessions`, and a
     * reader who goes looking for `session` on create() does not find it.
     * The registration path was fixed for exactly this one method over.
     */
    private assertSessionsConfigured;
    /** The session manager, for tests that inspect or manipulate sessions directly. Throws when sessions are off. */
    get sessionManager(): LambderSessionManager<S>;
    /**
     * Starts a session without a login endpoint: creates it through the
     * session controller, the way a login handler does, plants its cookies
     * into the jar when one is given, so the jar's transport is signed in
     * from its next call, and mirrors the readable ones into document.cookie
     * the way an answer's cookies are. Returns the raw tokens too.
     */
    signIn(sessionKey: string, data: S, options?: {
        jar?: LambderCookieJar;
        ttlSeconds?: number;
        host?: string;
    }): Promise<LambderCreatedSession<S>>;
    /**
     * Ends every session of the subject ("log this subject out everywhere")
     * and clears what signIn planted: the cookies in the jar given, and the
     * copies in document.cookie.
     *
     * Symmetric on purpose, the way reset() is. The records alone leave the
     * jar and the page carrying a token for a session that no longer exists,
     * which reads as signed in until an answer says otherwise.
     */
    signOut(sessionKey: string, options?: {
        jar?: LambderCookieJar;
        host?: string;
    }): Promise<void>;
    /** Marks the subject's session data stale, so the next read renews it through dataRefresh. */
    expireSessionData(sessionKey: string): Promise<void>;
    /**
     * Listens to every call, both phases. Keyed, so a hot-reloaded module
     * replaces its own listener instead of stacking a duplicate. Returns the
     * unsubscribe.
     */
    subscribe(key: string, listener: LambderMockListener): () => void;
    /** The completed calls, oldest first, bounded by callLogSize. */
    get calls(): readonly LambderMockCallRecord[];
    private emit;
    /** The context one call runs on: the core's call context plus what mock guards and handlers see. */
    private createContext;
    /** What a call looks like on the way in, for the runtime's own calls and for one an adapter passes on. */
    private requestEvent;
    /**
     * Records a call an adapter handed on instead of answering: the MSW
     * adapter's passthrough. Without it a name the registry does not know
     * leaves no trace at all, and a mistyped endpoint reaches the real
     * network with nothing in the call log or on the subscription to say so,
     * which is the one failure the log exists to make visible.
     */
    notePassthrough(request: LambderApiRequest): void;
    /** What every record of one call repeats (see LambderMockCallFacts). */
    private callFacts;
    /** One call from a parsed request to its answer, events included. The entry point every transport and adapter shares. */
    handleRequest(request: LambderApiRequest): Promise<LambderApiAnswer>;
    /**
     * A transport request as the core's request: the envelope read the way the
     * server reads it. Public because the adapters call it, which is what
     * keeps them from each reading a transport request their own way.
     */
    requestFromTransport(transportRequest: LambderApiTransportRequest): LambderApiRequest;
    /** One call from a transport request to its answer: what the mock transport and the adapters call. */
    handle(transportRequest: LambderApiTransportRequest): Promise<LambderApiAnswer>;
    /**
     * The direct transport: a caller's request into handle(), the answer
     * back in the form the caller reads, cookies carried by a jar the way
     * a browser carries them. Each transport gets its own jar unless one is
     * given, so two transports hold two sessions; the jar is on the returned
     * transport as `cookieJar`, so a test can read or clear the one it did
     * not create itself, and reset() empties it.
     */
    transport(options?: LambderMockTransportOptions): LambderMockTransport;
    /**
     * Mirrors an answer's non-HttpOnly cookies into document.cookie and
     * remembers them, so reset() expires them again. The direct transport's
     * "document" mode and the MSW adapter both come through here: one
     * implementation of the mirror, one record of what was planted.
     */
    mirrorCookiesIntoDocument(setCookies: readonly string[]): void;
    /**
     * Takes a jar an adapter built for itself as the runtime's own, so reset()
     * empties it with the rest. The MSW adapter's jar holds the session
     * cookies of calls that never touch transport(), and a reset that leaves
     * it full is the same stale-session bug: the store is empty and the next
     * request still carries a token for one of its sessions.
     */
    adoptCookieJar(jar: LambderCookieJar): void;
    /** caller.setTransport(mockApp.transport(options)); returns the transport, its jar on it. */
    attach(caller: {
        setTransport(transport: LambderApiTransport): unknown;
    }, options?: LambderMockTransportOptions): LambderMockTransport;
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
export declare const initLambderMock: <C extends LambderApiContractShape, S = any>() => {
    /** Builds a mock guard: the server guard's shape, the handler seeing the mock's contexts. */
    guard: LambderGuardBuilder<LambderMockCallContext<S>, LambderMockSessionCallContext<S>>;
    /**
     * Builds a mock rate-limit key, the counterpart of `guard`. Bound to the
     * mock's own call context, because the server's lambderRateLimitKey() is
     * bound to the render context and a handler written with it compiles here
     * while reading fields the mock context does not have.
     */
    rateLimitKey: import("../api/LambderApiRateLimits.js").LambderRateLimitKeyBuilder<LambderMockCallContext<S>>;
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
    create<const G extends Record<string, LambderApiGuard<any, any, any, LambderMockCallContext<S>, LambderMockSessionCallContext<S>>> = {}, const P extends LambderMockRateLimitPolicies<S> = {}, I extends boolean | LambderMockIdempotencyOptions<S> = boolean | LambderMockIdempotencyOptions<S>>(options: LambderMockAppOptions<C, S, G, P, I>): LambderMockApp<C, S, G>;
};

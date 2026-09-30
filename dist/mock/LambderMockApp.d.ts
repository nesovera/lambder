import type { z } from "zod";
import type { LambderApiContractShape } from "../shared/wire/LambderApiContract.js";
import { type LambderApiRequest } from "../api/LambderApiRequest.js";
import { type LambderApiAnswer } from "../api/LambderApiAnswer.js";
import { type LambderDeclaredRefuse, type LambderRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import { type LambderDeclaredVocabulary, type LambderHandlerRefusalsOf, type LambderRefusalVocabulary, type LambderRefusalVocabularyOption, type LambderRefusalVocabularyOptionChecks, type LambderMergedRefusalVocabulary } from "../api/LambderApiRefusals.js";
import { type LambderApiTransport, type LambderApiTransportRequest } from "../shared/transport/LambderApiTransport.js";
import { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
import { type LambderApiGuard, type LambderGuardBuilder } from "../api/LambderApiGuards.js";
import { LambderMemoryRateLimiter } from "../stores/LambderMemoryRateLimiter.js";
import { LambderMemoryIdempotencyStore } from "../stores/LambderMemoryIdempotencyStore.js";
import { LambderMemorySessionStore } from "../stores/LambderMemorySessionStore.js";
import LambderSessionManager, { type LambderCreatedSession } from "../session/LambderSessionManager.js";
import type { LambderMockAppOptions, LambderMockIdempotencyOptions, LambderMockTransport, LambderMockTransportOptions } from "./LambderMockCreateOptions.js";
import type { LambderApiOptionEntry, LambderGuardDeclarationEntry } from "../shared/wire/LambderApiOptionEntries.js";
import type { LambderMockCallContext, LambderMockCallRecord, LambderMockEntry, LambderMockEntryInput, LambderMockFailure, LambderMockFailureReason, LambderMockHandler, LambderMockLatency, LambderMockListener, LambderMockNotMockedInput, LambderMockRateLimitPolicies, LambderMockRegistryCheck, LambderMockRestEntry, LambderMockSessionCallContext, LambderMockSlice, LambderMockOverride, LambderMockRefusalsOf } from "./LambderMockTypes.js";
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
 * inferred from the options. `TDerived` is true for a mock created with the
 * generated `apiOptions` table, whose entries are their handlers alone.
 * `TVocabulary` and `TCodesRequired` are the refusal vocabulary the init
 * declared (declareRefusals), which types every handler's ctx.refuse.
 */
export declare class LambderMockApp<C extends LambderApiContractShape, S = any, G extends Record<string, LambderApiGuard<any, any, any>> = {}, TDerived extends boolean = false, TVocabulary extends LambderRefusalVocabulary = never, TCodesRequired extends boolean = false> {
    readonly apiVersion: string | null;
    /** The memory stores, for assertions and reset; null for a subsystem that is off or backed by a store of yours. */
    readonly sessionStore: LambderMemorySessionStore<S> | null;
    readonly rateLimiter: LambderMemoryRateLimiter | null;
    readonly idempotencyStore: LambderMemoryIdempotencyStore | null;
    readonly tokenCookieKey: string;
    readonly csrfCookieKey: string;
    /**
     * The client IP a transport request carrying none is read as. Public so
     * every adapter reads the same default the direct transport uses: with a
     * default of its own, an app that set defaultClientIp would show one
     * address through the transport and another through the service worker,
     * and a per-IP rate limit would count two clients where there is one.
     */
    readonly defaultClientIp: string;
    /** The host this runtime's cookies belong to (see the cookieHost option). */
    readonly cookieHost: string;
    /**
     * The API core, every protocol step of it. Private: the mock's surface is
     * the app, and a consumer reaching past it would be configuring the
     * server's pipeline through a development tool. The adapters use the
     * app's own methods (handleRequest, requestFromTransport) instead.
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
    /** The server's declared options per API, when create() was given the generated table; the entries' declarations come from here. */
    private readonly apiOptions;
    /** The mock's own guards as create() was given them: which of them need a session, for an entry's mode without the apiOptions table. */
    private readonly mockGuards;
    /** The server's guard declarations, when create() was given the generated table: the refusal codes a declared guard adds to an entry. */
    private readonly guardDeclarations;
    /** The server's refusal vocabulary, when create() was given the generated table: whether each code an entry may refuse with carries data. */
    private readonly refusalVocabulary;
    /** Whether every refusal an entry answers with has to name a code, as the server's declareRefusals() requireCodes. */
    private readonly requireRefusalCodes;
    /** The jars the runtime owns and what it planted in document.cookie (see LambderMockBrowserCookies). */
    private readonly browserCookies;
    constructor(options: LambderMockAppOptions<C, S, G, LambderMockRateLimitPolicies<S>, boolean | LambderMockIdempotencyOptions<S>, {}, Record<string, LambderApiOptionEntry> | undefined>, 
    /** The vocabulary the init declared, or null: what initLambderMock().declareRefusals() passes on. */
    declared?: LambderDeclaredVocabulary<TVocabulary, TCodesRequired> | null);
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
    private assertEntryRegistration;
    /**
     * The table's entry for an endpoint, when create() was given one: null
     * without a table, and a throw for a name the table does not hold. The
     * compiler already refuses it against the contract; this is where a
     * stale table meets a caller the compiler did not see.
     */
    private declaredOptionsOf;
    /**
     * An entry's mode, by the server's rule: a session endpoint when one of
     * its guards needs a session. The guards are the apiOptions table's when
     * create() was given one (which records the mode it came to as well), and
     * otherwise the ones the entry restates, each read off the guardDeclarations
     * table or the mock's own guards.
     */
    private modeOf;
    /**
     * The codes an entry may refuse with, read off the generated tables (its
     * own from apiOptions, its guards' from guardDeclarations), each resolved
     * through the vocabulary the init declared, exactly as the server
     * resolves its own: schema, status and flag. An entry that declares
     * guards needs the guardDeclarations table, and one with any code needs
     * the vocabulary; a code the tables name that the vocabulary lacks means
     * the two describe different servers.
     */
    private declaredRefusalsOf;
    /** The mode the apiOptions table gives a name, or null without a table or for a name it does not hold. */
    private declaredModeOf;
    private buildEntry;
    /**
     * A mock for an endpoint: a handler, or the handler with the endpoint's
     * declarations restated. Its mode is the server's (see modeOf): a
     * session endpoint's session is fetched before the handler runs, and a
     * call without one is refused as on the server.
     */
    api<K extends keyof C & string, TInputSchema extends z.ZodType = z.ZodType>(name: K, entry: LambderMockEntryInput<C, K, S, G, TInputSchema, TDerived, TVocabulary, TCodesRequired>): LambderMockEntry<C, K>;
    /**
     * An endpoint deliberately left without a mock; a call answers the
     * notMocked refusal carrying the reason. The refusal runs through the
     * pipeline, so the steps before dispatch still happen, the session read
     * among them, under the server's mode (see modeOf): a signed-out call to
     * a session endpoint answers sessionExpired as on the server. Without the
     * apiOptions table a session endpoint restates its guards to say so,
     * `notMocked(name, { reason, guards })`; no guard runs.
     */
    notMocked<K extends keyof C & string>(name: K, input: LambderMockNotMockedInput<C, K, TDerived>): LambderMockEntry<C, K>;
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
     * The mode of an unregistered name comes from the apiOptions table, when
     * create() was given one, so an unmocked session endpoint still reads the
     * session and a signed-out call answers sessionExpired as on the server.
     * Without the table the mode is not knowable at runtime (the contract is
     * a type), and a call it answers is processed as public: the protocol's
     * pre-pass still runs, so a stale client still hears versionExpired, but
     * a signed-out call to an unmocked session endpoint answers "not mocked"
     * where the server answers sessionExpired. Give create() the table where
     * a test cares about that path.
     */
    restNotMocked(reason: string): LambderMockRestEntry;
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
    override<K extends keyof C & string>(name: K, handler: LambderMockHandler<C, K, S, G, TVocabulary, TCodesRequired>): LambderMockOverride;
    /** Puts every overridden handler back, however deeply they were stacked. */
    restoreOverrides(): void;
    /** The registered endpoint names. */
    get registeredNames(): string[];
    /**
     * Whether a call to this name would be answered from the registry, which
     * is what an adapter asks before passing one on.
     *
     * True for every name once a rest entry is registered, since it answers
     * whatever nothing else claimed. That makes a rest entry and the MSW
     * adapter's `onUnmocked: "passthrough"` alternatives rather than layers:
     * with one registered, nothing is handed on to the network.
     */
    hasRegisteredEntry(apiName: string): boolean;
    private entryFor;
    /**
     * The entry that answers a name nothing registered, when register() was
     * given a rest entry: the notMocked refusal carrying its reason, run
     * through the pipeline under the mode the apiOptions table gives the
     * name, and as a public endpoint where there is no table to say (the
     * mode of an unregistered name cannot otherwise be recovered at runtime).
     * Everything before dispatch still runs (the signature gate, the payload
     * restore, and for a session endpoint the session read).
     */
    private restNotMockedEntry;
    /** The next call to the endpoint fails this way; several calls queue in order. An injected refusal names one of the endpoint's declared codes, its data as a handler raises it (see LambderMockRefusalsOf), and is checked and sent as a real one is. */
    failNext<K extends keyof C & string>(apiName: K, failure: LambderMockFailure<LambderRefusalMessage<LambderMockRefusalsOf<C, K, TVocabulary>>> | LambderMockFailureReason): void;
    /** Every call to the endpoint fails this way until cleared with null. */
    setFailure<K extends keyof C & string>(apiName: K, failure: LambderMockFailure<LambderRefusalMessage<LambderMockRefusalsOf<C, K, TVocabulary>>> | LambderMockFailureReason | null): void;
    /** Every call rejects at the transport, as with no network at all. */
    setOffline(offline: boolean): void;
    setLatency(latency: LambderMockLatency): void;
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
    reset(): void;
    /**
     * The four session members refuse in the mock's own words, naming the
     * option a mock is created with. The pipeline's guard names the SERVER's
     * option (`session`), which a reader does not find on the mock's create()
     * (`sessions`); assertEntryRegistration does the same for registration.
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
     * cookies of calls that never touch transport(); left full after a reset,
     * the next request would carry a token for a session the emptied store no
     * longer has.
     */
    adoptCookieJar(jar: LambderCookieJar): void;
    /** caller.setTransport(mockApp.transport(options)); returns the transport, its jar on it. */
    attach(caller: {
        setTransport(transport: LambderApiTransport): unknown;
    }, options?: LambderMockTransportOptions): LambderMockTransport;
}
/**
 * The mock's entry point: fixes the contract and session types, and hands
 * out the builders and create() that share them. `declareRefusals()` binds
 * the server's refusal vocabulary too, the same object the server's init
 * declares, so a mock handler's ctx.refuse takes a code's data in the
 * schema's input form and the mock parses it exactly as the server does.
 */
export declare const initLambderMock: <C extends LambderApiContractShape, S = any>() => {
    /**
     * Declares the server's refusal vocabulary on the mock: the same map, or
     * list of maps, and the same `requireCodes`, the server's init declares,
     * imported from shared code (codes, zod schemas, statuses and flags hold
     * nothing secret). Given, every refusal an entry answers with is checked and sent
     * as the server would send it: the code among the codes the tables give
     * the entry, its data parsed through the code's schema from the input
     * form, and the declaration's status and flag. An entry whose tables name
     * a code needs it.
     */
    declareRefusals<const TVocabulary extends LambderRefusalVocabularyOption, const TRequireCodes extends boolean = false>(refusals: TVocabulary & LambderRefusalVocabularyOptionChecks<TVocabulary>, options?: {
        requireCodes?: TRequireCodes;
    }): {
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
         * refuse() typed to the vocabulary the mock declared, for a mock guard or
         * a helper of the mock with no endpoint in hand: `code` is one of its
         * codes and `data` the schema's input form, parsed as the server parses
         * it. The free refuse() where the mock declared none.
         */
        refuse: [LambderMergedRefusalVocabulary<TVocabulary>] extends [never] ? (content: string, options?: import("../shared/wire/LambderApiRefusal.js").LambderRefuseOptions) => never : LambderDeclaredRefuse<LambderHandlerRefusalsOf<LambderMergedRefusalVocabulary<TVocabulary>, keyof LambderMergedRefusalVocabulary<TVocabulary> & string>, TRequireCodes>;
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
        create<const G extends Record<string, LambderApiGuard<any, any, any, LambderMockCallContext<S>, LambderMockSessionCallContext<S>>> = {}, const P extends LambderMockRateLimitPolicies<S> = {}, I extends boolean | LambderMockIdempotencyOptions<S> = boolean | LambderMockIdempotencyOptions<S>, const D extends Record<string, LambderGuardDeclarationEntry> = {}, const A extends Record<string, LambderApiOptionEntry> | undefined = undefined>(options: LambderMockAppOptions<C, S, G, P, I, D, A>): LambderMockApp<C, S, G, [A] extends [undefined] ? false : true, LambderMergedRefusalVocabulary<TVocabulary>, TRequireCodes>;
    };
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
     * refuse() typed to the vocabulary the mock declared, for a mock guard or
     * a helper of the mock with no endpoint in hand: `code` is one of its
     * codes and `data` the schema's input form, parsed as the server parses
     * it. The free refuse() where the mock declared none.
     */
    refuse: (content: string, options?: import("../shared/wire/LambderApiRefusal.js").LambderRefuseOptions) => never;
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
    create<const G extends Record<string, LambderApiGuard<any, any, any, LambderMockCallContext<S>, LambderMockSessionCallContext<S>>> = {}, const P extends LambderMockRateLimitPolicies<S> = {}, I extends boolean | LambderMockIdempotencyOptions<S> = boolean | LambderMockIdempotencyOptions<S>, const D extends Record<string, LambderGuardDeclarationEntry> = {}, const A extends Record<string, LambderApiOptionEntry> | undefined = undefined>(options: LambderMockAppOptions<C, S, G, P, I, D, A>): LambderMockApp<C, S, G, [A] extends [undefined] ? false : true, never, false>;
};

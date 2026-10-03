import { AsyncLocalStorage } from "async_hooks";
import type { Context } from "aws-lambda";
import type Lambder from "../core/Lambder.js";
import { createContext, type LambderHttpEventFormat } from "../core/LambderContext.js";
import type { LambderHandler } from "../core/LambderCreateOptions.js";
import { localLambdaContext, synthesizeLambdaHttpEvent } from "../invoke/LambderLambdaEvent.js";
import type LambderSessionManager from "../session/LambderSessionManager.js";
import type { LambderFileSource } from "../shared/contracts/LambderFileSource.js";
import type { LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import type { LambderRateLimiter } from "../shared/contracts/LambderRateLimiter.js";
import type { LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import { LAMBDER_BACKEND_SWAP, LAMBDER_CRASH_WATCH } from "../shared/util/LambderTestingDoors.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import type { LambderApiContractShape } from "../shared/wire/LambderApiContract.js";
import type { LambderCallSummary } from "../core/LambderCallSummary.js";
import { LambderMemoryIdempotencyStore } from "../stores/LambderMemoryIdempotencyStore.js";
import { LambderMemoryRateLimiter } from "../stores/LambderMemoryRateLimiter.js";
import { LambderMemorySessionStore } from "../stores/LambderMemorySessionStore.js";
import { LambderMemoryCache } from "../stores/LambderMemoryCache.js";
import { LambderMemoryOneShotSecretStore } from "../stores/LambderMemoryOneShotSecretStore.js";
import { LambderMemoryUploadBucket } from "../stores/LambderMemoryUploadBucket.js";
import type { LambderDdbCache } from "../stores/LambderDdbCache.js";
import type { LambderDdbOneShotSecretStore } from "../stores/LambderDdbOneShotSecretStore.js";
import type { LambderS3UploadBucket } from "../stores/LambderS3UploadBucket.js";
import type LambderInvokeCaller from "../invoke/LambderInvokeCaller.js";
import type { LambderMockApp } from "../mock/LambderMockApp.js";
import { lambderMockInvokeTransport } from "../mock/lambderMockInvokeTransport.js";
import { liveSwappableInstances, watchSwappableInstances, type LambderSwappableInstance } from "../shared/util/LambderSwappableInstances.js";
import { LambderTestVisitor, type LambderTestVisitorArgs, type LambderTestVisitorOptions, type LambderTestVisitorWiring } from "./LambderTestVisitor.js";

/**
 * What a test app may be told. Nothing is required: `lambderTestApp(lambder)`
 * is a working test app over memory stores.
 *
 * The stores sit where create() takes them (`session.store`,
 * `rateLimits.limiter`, `idempotency.store`, `files`), naming only the part a
 * test replaces; everything else the app configured there stays in force. One
 * given for a subsystem the app was created without throws, naming the
 * option.
 */
export type LambderTestAppOptions = {
    /** The host visitors browse unless they name their own. Default: "localhost". An app that scopes its session cookie to a domain needs a host under it. */
    host?: string;
    /**
     * The gateway shape the handler is called with: "v2" (an HTTP API, a
     * Function URL) or "v1" (a REST API). Default: "v2". A handler answers
     * both alike through its context, so this matters only to code that reads
     * the raw `ctx.event`, or to a suite that should run on exactly what
     * production delivers.
     */
    eventFormat?: LambderHttpEventFormat;
    /** Default: a fresh LambderMemorySessionStore. Pass your own to run the suite over another store (DynamoDB Local, say). */
    session?: { store?: LambderSessionStore<any> };
    /** Default: a fresh LambderMemoryRateLimiter. */
    rateLimits?: { limiter?: LambderRateLimiter };
    /** Default: a fresh LambderMemoryIdempotencyStore. */
    idempotency?: { store?: LambderIdempotencyStore };
    /** Default: the app's own source, which suits one that reads a local folder. Pass a LambderLocalFileSource over fixtures for an app whose production source is S3 or HTTP. */
    files?: LambderFileSource;
    /**
     * The mock apps that answer the app's invoke callers, by the function
     * name each caller was built with. A LambderInvokeCaller built without a
     * transport is answered by the mock its function has here, through
     * lambderMockInvokeTransport; with none, every call it makes fails,
     * naming the function. Default: none.
     */
    invokeMocks?: { [functionName: string]: Pick<LambderMockApp<any>, "handleRequest"> };
};

/**
 * What a test app offers a registered instance's swap door: a twin for each
 * class that registers, which the door picks from. The intersection of the
 * doors' own parameters, so a door that asks for more fails to compile here.
 */
type LambderTwinOffer =
    & Parameters<LambderDdbCache[typeof LAMBDER_BACKEND_SWAP]>[0]
    & Parameters<LambderDdbOneShotSecretStore[typeof LAMBDER_BACKEND_SWAP]>[0]
    & Parameters<LambderS3UploadBucket[typeof LAMBDER_BACKEND_SWAP]>[0]
    & Parameters<LambderInvokeCaller[typeof LAMBDER_BACKEND_SWAP]>[0];

/** A memory twin the test app put under one of the app's own stores. */
type LambderMemoryTwin = LambderMemoryCache | LambderMemoryOneShotSecretStore | LambderMemoryUploadBucket;

/**
 * A Lambder instance as a test app takes it: any instance, read for its
 * session data type and, through the ApiContract property rather than the
 * class parameter, for its contract. The property lets a large app name the
 * contract writeApiContract generated for its clients
 * (`lambderTestApp<SessionData, ApiContractType>(lambder)`), so the tests type
 * their calls against plain members rather than the chained intersection.
 */
export type LambderTestedInstance<TSessionData, TContract> =
    Pick<Lambder<any, any>, "apiPath" | "getHandler" | "getSessionController" | "getSessionManager" | typeof LAMBDER_BACKEND_SWAP | typeof LAMBDER_CRASH_WATCH>
    & { readonly AppTypes: { session: TSessionData }; readonly ApiContract: TContract };

/**
 * A real Lambder app under test: the instance an app already has, with memory
 * stores put under it in place, and as many simulated browsers in front of it
 * as a test needs. No HTTP, no AWS, and nothing in the app restructured.
 *
 * The app's own declarations all run as written: guards, named rate-limit
 * policies, idempotency settings, session salt, cookie options and
 * dataRefresh, hooks and error handlers. Only where things rest is replaced:
 * once this is created, the stores the app was configured with are out of the
 * instance's reach, so a test cannot touch a production table by mistake.
 * What the app reaches on its own (its database, a mailer) is the app's to
 * replace.
 *
 * The Lambder classes an app builds itself, beside the instance, are put
 * under test too, wherever they were built: each LambderDdbCache,
 * LambderDdbOneShotSecretStore and LambderS3UploadBucket answers from a
 * memory twin of its own (see memoryTwinOf), and each LambderInvokeCaller
 * built without a transport from the mock app `invokeMocks` names for its
 * function. Those classes register themselves as they are constructed, so
 * one built before the test app and one built after (in a handler, say) are
 * both reached.
 *
 * The sibling of LambderMockApp, which serves a contract from mock handlers:
 * the same verbs (`signIn`, `signOut`, `expireSessionData`, `reset`) over the
 * real handlers.
 *
 * Time is not this class's: fake `Date` with the test runner
 * (`vi.useFakeTimers({ toFake: ["Date"] })`), which moves the framework, the
 * memory stores and the app's own handlers together.
 *
 * One test app per instance: a second one puts its own stores under the same
 * instance and takes over its crash watch, so the first stops seeing either.
 * The app's own classes are the process's rather than an instance's, so the
 * test app created last puts its twins under every one of them.
 */
export class LambderTestApp<TContract extends LambderApiContractShape = any, TSessionData = any> {
    /** The instance's handler: what `event()` and every visitor call. */
    readonly handler: LambderHandler;
    /** The host visitors browse unless they name their own. */
    readonly host: string;
    /** The session store now under the instance, for assertions; null when the app has no sessions. A LambderMemorySessionStore unless one was given. */
    readonly sessionStore: LambderSessionStore<TSessionData> | null;
    /** The rate limiter now under the instance; null when the app declares no rate limits. */
    readonly rateLimiter: LambderRateLimiter | null;
    /** The idempotency store now under the instance; null when the app has no idempotency. */
    readonly idempotencyStore: LambderIdempotencyStore | null;

    private readonly lambder: LambderTestedInstance<TSessionData, TContract>;
    private readonly wiring: LambderTestVisitorWiring<TSessionData>;
    /** The memory stores this test app made itself, which reset() empties. One the test supplied is the test's: nothing here knows what else holds it. */
    private readonly ownStores: { reset(): void }[] = [];
    /** The twin under each of the app's own stores, by the store, for memoryTwinOf and reset. */
    private readonly memoryTwins = new WeakMap<object, LambderMemoryTwin>();
    private visitorCount = 0;
    private resetCount = 0;
    private readonly crashList: Error[] = [];
    /** Every call summary the app wrote since the last reset; see callSummaries. */
    private readonly callSummaryList: LambderCallSummary[] = [];
    /**
     * The call a crash happened under. The app's 500 says nothing about the
     * crash, so the error travels beside the answer, and with concurrent
     * calls (a duplicate sent while the original is in flight is an ordinary
     * idempotency test) only the async context says which call it belongs to.
     */
    private readonly crashScope = new AsyncLocalStorage<{ crash: Error | null }>();

    constructor(lambder: LambderTestedInstance<TSessionData, TContract>, options: LambderTestAppOptions = {}){
        // Only a Lambder instance from this same package copy answers to the
        // key; saying so here beats a bare "is not a function".
        if(typeof (lambder as { [LAMBDER_BACKEND_SWAP]?: unknown } | null)?.[LAMBDER_BACKEND_SWAP] !== "function"){
            throw new Error("lambderTestApp: expected a Lambder instance (what initLambder().create() returns), from the same installed copy of lambder as lambder/testing.");
        }
        const own = <TStore extends { reset(): void }>(store: TStore): TStore => { this.ownStores.push(store); return store; };
        const sessionStore = options.session?.store ?? own(new LambderMemorySessionStore<TSessionData>());
        const rateLimiter = options.rateLimits?.limiter ?? own(new LambderMemoryRateLimiter());
        const idempotencyStore = options.idempotency?.store ?? own(new LambderMemoryIdempotencyStore());
        // The summaries are collected rather than written, so a suite's
        // output stays its own and a test can read what a call recorded.
        const swap = lambder[LAMBDER_BACKEND_SWAP]({
            sessionStore, rateLimiter, idempotencyStore, fileSource: options.files,
            callSummary: (summary) => { this.callSummaryList.push(summary); },
        });
        // A store given for a subsystem the app does not have would be put
        // under nothing: the suite it was meant for would run over no store
        // while reading as if it ran over that one.
        if(options.session?.store && !swap.sessions){
            throw new Error("lambderTestApp: the session.store option was given, but the app was created without sessions, so nothing reads sessions to put a store under.");
        }
        if(options.rateLimits?.limiter && !swap.rateLimits){
            throw new Error("lambderTestApp: the rateLimits.limiter option was given, but the app was created without rate limits, so nothing counts calls to put a limiter under.");
        }
        if(options.idempotency?.store && !swap.idempotency){
            throw new Error("lambderTestApp: the idempotency.store option was given, but the app was created without idempotency, so nothing records answers to put a store under.");
        }
        if(options.files && !swap.files){
            throw new Error("lambderTestApp: the files option was given, but the app was created without one, so nothing reads files to put a source under.");
        }

        const invokeMocks = options.invokeMocks ?? {};
        for(const [functionName, mockApp] of Object.entries(invokeMocks)){
            if(typeof (mockApp as { handleRequest?: unknown } | null)?.handleRequest !== "function"){
                throw new Error(`lambderTestApp: invokeMocks["${functionName}"] is not a LambderMockApp (what initLambderMock().create() returns).`);
            }
        }
        // Every one of the app's own classes alive now, and every one
        // constructed from now on, until another test app takes over.
        const putTwinUnder = (swappable: LambderSwappableInstance): void => {
            const kept = <TTwin extends LambderMemoryTwin>(twin: TTwin): TTwin => { this.memoryTwins.set(swappable.instance, twin); return twin; };
            const twins: LambderTwinOffer = {
                cache: (cacheOptions) => kept(new LambderMemoryCache(cacheOptions)),
                oneShotSecretStore: () => kept(new LambderMemoryOneShotSecretStore()),
                uploadBucket: (bucketOptions) => kept(new LambderMemoryUploadBucket(bucketOptions)),
                invokeTransport: ({ functionName, apiPath }) => {
                    const mockApp = Object.hasOwn(invokeMocks, functionName) ? invokeMocks[functionName] : undefined;
                    if(mockApp) return lambderMockInvokeTransport(mockApp, { apiPath });
                    return async () => {
                        throw new Error(
                            `lambderTestApp: no invoke mock answers the function "${functionName}", and under a test app an invoke caller never reaches AWS. ` +
                            `Pass invokeMocks: { "${functionName}": mockApp } to answer it from a LambderMockApp.`
                        );
                    };
                },
            };
            swappable.swapIn(twins);
        };
        for(const swappable of liveSwappableInstances()) putTwinUnder(swappable);
        watchSwappableInstances(putTwinUnder);

        lambder[LAMBDER_CRASH_WATCH]((error) => {
            this.crashList.push(error);
            const scope = this.crashScope.getStore();
            if(scope) scope.crash = error;
        });

        this.lambder = lambder;
        this.handler = lambder.getHandler();
        this.host = options.host ?? "localhost";
        this.sessionStore = swap.sessions ? sessionStore : null;
        this.rateLimiter = swap.rateLimits ? rateLimiter : null;
        this.idempotencyStore = swap.idempotency ? idempotencyStore : null;
        this.wiring = {
            handler: this.handler,
            apiPath: lambder.apiPath,
            eventFormat: options.eventFormat ?? "v2",
            sessionCookieNames: swap.sessions,
            resetCount: () => this.resetCount,
            watchCrash: async (run) => {
                const scope: { crash: Error | null } = { crash: null };
                return { result: await this.crashScope.run(scope, run), crash: scope.crash };
            },
            issueSession: async (host, sessionKey, data, ttlSeconds) => {
                // Through a session controller on a request context, as a
                // login handler does, so the cookies are what the app's own
                // cookie options produce for that host.
                const event = synthesizeLambdaHttpEvent({ method: "GET", path: "/", host }, { invoke: false });
                const ctx = createContext(event, localLambdaContext("lambder-test"), { apiPath: lambder.apiPath });
                const created = await lambder.getSessionController(ctx).issueSession(sessionKey, data, ttlSeconds);
                const headers: Record<string, string[]> = {};
                ctx.responseHeaders.applyInto(headers);
                return { created, setCookies: getAnswerHeader(headers, "Set-Cookie") ?? [] };
            },
        };
    }

    /**
     * Every error the app threw while answering a request since the last
     * reset, in order: what reached its global error handler, or the
     * framework's last-resort 500. The answers say nothing about what was
     * thrown, so a test reads it here; `expect(app.crashes).toEqual([])`
     * says nothing crashed. A refusal is not a crash, and neither is an
     * error an `event()` rejects with, which the test already holds.
     */
    get crashes(): readonly Error[] {
        return this.crashList;
    }

    /**
     * The summary of every API call, and every request a route answered,
     * since the last reset, in order (see LambderCallSummary): what the app's
     * callSummary option would have been handed, collected here instead of
     * written to stdout.
     */
    get callSummaries(): readonly LambderCallSummary[] {
        return this.callSummaryList;
    }

    /**
     * Fails every test that leaves a crash behind: installs, through the
     * runner's own `afterEach`, a check that throws when `crashes` is not
     * empty, listing each crash with its stack. The crashes it reports are
     * forgotten, so the next test starts clean whether or not it resets. A
     * test that provokes a crash on purpose asserts on `crashes` and ends
     * with `reset()`.
     *
     * ```typescript
     * const app = lambderTestApp(lambder);
     * app.assertNoCrashesAfterEach(afterEach);
     * ```
     */
    assertNoCrashesAfterEach(afterEach: (check: () => void) => unknown): void {
        afterEach(() => {
            if(this.crashList.length === 0) return;
            const crashes = this.crashList.splice(0);
            const listed = crashes.map((crash, index) => {
                const [first, ...frames] = (crash.stack ?? `${crash.name}: ${crash.message}`).split("\n");
                return [`${index + 1}) ${first}`, ...frames.map((frame) => `   ${frame.trim()}`)].join("\n");
            });
            throw new Error(
                `The app crashed answering ${crashes.length === 1 ? "a request" : `${crashes.length} requests`} in this test:\n\n${listed.join("\n\n")}`
            );
        });
    }

    /**
     * The memory twin under one of the app's own stores, to seed, inspect or
     * drive: what the app's LambderDdbCache, LambderDdbOneShotSecretStore or
     * LambderS3UploadBucket answers from under this test app. An upload
     * test hands the bucket twin's handleStorageRequest the request a
     * client would send to the ticket's URL. Throws for anything this test
     * app put no twin under.
     */
    memoryTwinOf(cache: LambderDdbCache): LambderMemoryCache;
    memoryTwinOf(store: LambderDdbOneShotSecretStore): LambderMemoryOneShotSecretStore;
    memoryTwinOf(bucket: LambderS3UploadBucket): LambderMemoryUploadBucket;
    memoryTwinOf(instance: LambderDdbCache | LambderDdbOneShotSecretStore | LambderS3UploadBucket): LambderMemoryTwin {
        const twin = this.memoryTwins.get(instance);
        if(!twin){
            throw new Error(
                "lambderTestApp: memoryTwinOf() was handed something this test app put no memory twin under. It takes a LambderDdbCache, " +
                "LambderDdbOneShotSecretStore or LambderS3UploadBucket, and the test app created last puts its own twins under every one."
            );
        }
        return twin;
    }

    /** The session manager, for tests that inspect or manipulate sessions directly. Throws when the app has no sessions. */
    get sessionManager(): LambderSessionManager<TSessionData> {
        return this.lambder.getSessionManager();
    }

    /**
     * A new simulated browser: its own cookie jar, and its own address unless
     * one is given. A stranger until it signs in, through the app's own login
     * API or through `signIn`.
     */
    visitor<TProvidedGuards extends string = never>(
        ...[options]: LambderTestVisitorArgs<LambderTestVisitorOptions<TContract, TProvidedGuards>, TProvidedGuards>
    ): LambderTestVisitor<TContract, TSessionData, TProvidedGuards> {
        this.visitorCount += 1;
        return new LambderTestVisitor<TContract, TSessionData, TProvidedGuards>(this.wiring, {
            ...(options as LambderTestVisitorOptions<TContract, TProvidedGuards>),
            host: options?.host ?? this.host,
            // One private address per visitor, counted up and never handed out
            // twice, so no two visitors share a per-ip counter by accident.
            clientIp: options?.clientIp ?? `10.${(this.visitorCount >> 16) & 255}.${(this.visitorCount >> 8) & 255}.${this.visitorCount & 255}`,
        });
    }

    /**
     * A new visitor, already signed in: `visitor()` followed by its
     * `signIn()`. The session is minted by the app's own session model, so
     * no login endpoint has to exist or be called.
     *
     * ```typescript
     * const owner = await app.signIn("user:ada", { userId: "ada", role: "owner" });
     * expect(await owner.api("store.rename", { name })).toEqual({ ok: true });
     * ```
     */
    async signIn<TProvidedGuards extends string = never>(
        sessionKey: string,
        data: TSessionData,
        ...[options]: LambderTestVisitorArgs<LambderTestVisitorOptions<TContract, TProvidedGuards> & { ttlSeconds?: number }, TProvidedGuards>
    ): Promise<LambderTestVisitor<TContract, TSessionData, TProvidedGuards>> {
        const { ttlSeconds, ...visitorOptions } = (options ?? {}) as LambderTestVisitorOptions<TContract, TProvidedGuards> & { ttlSeconds?: number };
        const visitor = this.visitor<TProvidedGuards>(...[visitorOptions] as LambderTestVisitorArgs<LambderTestVisitorOptions<TContract, TProvidedGuards>, TProvidedGuards>);
        await visitor.signIn(sessionKey, data, { ttlSeconds });
        return visitor;
    }

    /**
     * Ends every session of the subject, the way "log out everywhere" does.
     * A visitor signed in as that subject keeps its cookies, as a browser
     * would, so its next call is what a real one's would be: answered
     * sessionExpired, with the stale cookies evicted.
     */
    async signOut(sessionKey: string): Promise<void> {
        await this.sessionManager.deleteSessionAllByKey(sessionKey);
    }

    /** Marks the subject's session data stale, so the next read renews it through the app's dataRefresh. */
    async expireSessionData(sessionKey: string): Promise<void> {
        await this.sessionManager.expireSessionDataAllByKey(sessionKey);
    }

    /**
     * Hands the handler an event that is not an HTTP request (a schedule, an
     * SNS or SQS delivery), which is how an addAction handler runs, with a
     * Lambda context filled in. Resolves to whatever the action returned.
     *
     * ```typescript
     * await app.event({ source: "aws.events", "detail-type": "Scheduled Event" });
     * ```
     */
    async event(event: unknown, context: Partial<Context> = {}): Promise<unknown> {
        return await this.handler(event, localLambdaContext("lambder-test", context));
    }

    /**
     * Rewinds what accumulated: sessions, rate-limit counters and replay
     * records in the stores this test app made, the memory twins under the
     * app's own stores, the crashes and call summaries it recorded, and the
     * cookies of every visitor it created (each empties its jar the next
     * time it is used). For a beforeEach. The app's own data (its database)
     * is the app's to rewind, and so are the invoke mocks.
     */
    reset(): void {
        for(const store of this.ownStores) store.reset();
        for(const { instance } of liveSwappableInstances()) this.memoryTwins.get(instance)?.reset();
        this.crashList.length = 0;
        this.callSummaryList.length = 0;
        this.resetCount += 1;
    }
}

/**
 * Puts a built Lambder instance under test. See LambderTestApp.
 *
 * ```typescript
 * import { lambderTestApp } from "lambder/testing";
 * import { lambder } from "../src/index.js";
 *
 * const app = lambderTestApp(lambder);
 * beforeEach(() => app.reset());
 * ```
 */
export const lambderTestApp = <TSessionData = any, TContract extends LambderApiContractShape = any>(
    lambder: LambderTestedInstance<TSessionData, TContract>,
    options: LambderTestAppOptions = {},
): LambderTestApp<TContract, TSessionData> => new LambderTestApp<TContract, TSessionData>(lambder, options);

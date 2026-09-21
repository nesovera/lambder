import { AsyncLocalStorage } from "async_hooks";
import { createContext } from "../core/LambderContext.js";
import { localLambdaContext, synthesizeLambdaHttpEvent } from "../invoke/LambderLambdaEvent.js";
import { LAMBDER_BACKEND_SWAP, LAMBDER_CRASH_WATCH } from "../shared/util/LambderTestingDoors.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import { LambderMemoryIdempotencyStore } from "../stores/LambderMemoryIdempotencyStore.js";
import { LambderMemoryRateLimiter } from "../stores/LambderMemoryRateLimiter.js";
import { LambderMemorySessionStore } from "../stores/LambderMemorySessionStore.js";
import { LambderTestVisitor } from "./LambderTestVisitor.js";
/**
 * A real Lambder app under test: the instance an app already has, with memory
 * stores put under it in place, and as many simulated browsers in front of it
 * as a test needs. No HTTP, no AWS, and nothing in the app restructured.
 *
 * The app's own declarations all run as written: its guards, its named
 * rate-limit policies, its idempotency settings, its session salt, cookie
 * options and dataRefresh, its hooks and error handlers. Only where things
 * rest is replaced, and from the moment this is created the stores the app
 * was configured with are out of the instance's reach, so a test cannot touch
 * a production table even by mistake. What the app reaches on its own (its
 * database, a mailer) is the app's to replace.
 *
 * The sibling of LambderMockApp, which serves a contract from mock handlers:
 * the same verbs (`signIn`, `signOut`, `expireSessionData`, `reset`) over the
 * real handlers instead.
 *
 * Time is not this class's: fake `Date` with the test runner
 * (`vi.useFakeTimers({ toFake: ["Date"] })`), which moves the framework, the
 * memory stores and the app's own handlers together.
 *
 * One test app per instance: a second one puts its own stores under the same
 * instance and takes over its crash watch, so the first stops seeing either.
 */
export class LambderTestApp {
    /** The instance's handler: what `event()` and every visitor call. */
    handler;
    /** The host visitors browse unless they name their own. */
    host;
    /** The session store now under the instance, for assertions; null when the app has no sessions. A LambderMemorySessionStore unless one was given. */
    sessionStore;
    /** The rate limiter now under the instance; null when the app declares no rate limits. */
    rateLimiter;
    /** The idempotency store now under the instance; null when the app has no idempotency. */
    idempotencyStore;
    lambder;
    wiring;
    /** The memory stores this test app made itself, which reset() empties. One the test supplied is the test's: nothing here knows what else holds it. */
    ownStores = [];
    visitorCount = 0;
    resetCount = 0;
    crashList = [];
    /**
     * The call a crash happened under. The app answers a crash with a 500
     * that says nothing about it, so the error has to travel beside the
     * answer, and with calls running concurrently (a duplicate sent while
     * the original is in flight is an ordinary idempotency test) only the
     * async context says which call a crash belongs to.
     */
    crashScope = new AsyncLocalStorage();
    constructor(lambder, options = {}) {
        // Only a Lambder instance of this same package copy answers to the
        // key, so the failure is said here rather than as "is not a function".
        if (typeof lambder?.[LAMBDER_BACKEND_SWAP] !== "function") {
            throw new Error("lambderTestApp: expected a Lambder instance (what initLambder().create() returns), from the same installed copy of lambder as lambder/testing.");
        }
        const own = (store) => { this.ownStores.push(store); return store; };
        const sessionStore = options.session?.store ?? own(new LambderMemorySessionStore());
        const rateLimiter = options.rateLimits?.limiter ?? own(new LambderMemoryRateLimiter());
        const idempotencyStore = options.idempotency?.store ?? own(new LambderMemoryIdempotencyStore());
        const swap = lambder[LAMBDER_BACKEND_SWAP]({ sessionStore, rateLimiter, idempotencyStore, fileSource: options.files });
        if (options.files && !swap.files) {
            throw new Error("lambderTestApp: the files option was given, but the app was created without one, so nothing reads files to put a source under.");
        }
        lambder[LAMBDER_CRASH_WATCH]((error) => {
            this.crashList.push(error);
            const scope = this.crashScope.getStore();
            if (scope)
                scope.crash = error;
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
                const scope = { crash: null };
                return { result: await this.crashScope.run(scope, run), crash: scope.crash };
            },
            issueSession: async (host, sessionKey, data, ttlSeconds) => {
                // Through a session controller on a request context, the way a
                // login handler does it, so the cookies are the ones the app's
                // own cookie options produce for that host.
                const event = synthesizeLambdaHttpEvent({ method: "GET", path: "/", host }, { invoke: false });
                const ctx = createContext(event, localLambdaContext("lambder-test"), lambder.apiPath);
                const created = await lambder.getSessionController(ctx).issueSession(sessionKey, data, ttlSeconds);
                const headers = {};
                ctx.responseHeaders.applyInto(headers);
                return { created, setCookies: getAnswerHeader(headers, "Set-Cookie") ?? [] };
            },
        };
    }
    /**
     * Every error the app threw while answering a request since the last
     * reset, in order: what reached its global error handler, or the
     * framework's last-resort 500. The answers themselves say nothing about
     * what was thrown, so this is where a test reads it, and
     * `expect(app.crashes).toEqual([])` is how one says nothing crashed.
     * A refusal is not a crash, and neither is an error an `event()` rejects
     * with, which the test already holds.
     */
    get crashes() {
        return this.crashList;
    }
    /** The session manager, for tests that inspect or manipulate sessions directly. Throws when the app has no sessions. */
    get sessionManager() {
        return this.lambder.getSessionManager();
    }
    /**
     * A new simulated browser: its own cookie jar, and its own address unless
     * one is given. A stranger until it signs in, through the app's own login
     * API or through `signIn`.
     */
    visitor(...[options]) {
        this.visitorCount += 1;
        return new LambderTestVisitor(this.wiring, {
            ...options,
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
     * const admin = await app.signIn("user:ada", { userId: "ada", role: "admin" });
     * expect(await admin.api("org.rename", { name })).toEqual({ ok: true });
     * ```
     */
    async signIn(sessionKey, data, ...[options]) {
        const { ttlSeconds, ...visitorOptions } = (options ?? {});
        const visitor = this.visitor(...[visitorOptions]);
        await visitor.signIn(sessionKey, data, { ttlSeconds });
        return visitor;
    }
    /**
     * Ends every session of the subject, the way "log out everywhere" does.
     * A visitor signed in as that subject keeps its cookies, as a browser
     * would, so its next call is what a real one's would be: answered
     * sessionExpired, with the stale cookies evicted.
     */
    async signOut(sessionKey) {
        await this.sessionManager.deleteSessionAllByKey(sessionKey);
    }
    /** Marks the subject's session data stale, so the next read renews it through the app's dataRefresh. */
    async expireSessionData(sessionKey) {
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
    async event(event, context = {}) {
        return await this.handler(event, localLambdaContext("lambder-test", context));
    }
    /**
     * Rewinds what accumulated: sessions, rate-limit counters and replay
     * records in the stores this test app made, the crashes it recorded, and
     * the cookies of every visitor it created (each empties its jar the next
     * time it is used). For a beforeEach. The app's own data (its database)
     * is the app's to rewind.
     */
    reset() {
        for (const store of this.ownStores)
            store.reset();
        this.crashList.length = 0;
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
export const lambderTestApp = (lambder, options = {}) => new LambderTestApp(lambder, options);

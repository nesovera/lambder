import type { Context } from "aws-lambda";
import type Lambder from "../core/Lambder.js";
import { type LambderHttpEventFormat } from "../core/LambderContext.js";
import type { LambderHandler } from "../core/LambderCreateOptions.js";
import type LambderSessionManager from "../session/LambderSessionManager.js";
import type { LambderFileSource } from "../shared/contracts/LambderFileSource.js";
import type { LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import type { LambderRateLimiter } from "../shared/contracts/LambderRateLimiter.js";
import type { LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import type { LambderApiContractShape } from "../shared/wire/LambderApiContract.js";
import { LambderTestVisitor, type LambderTestVisitorArgs, type LambderTestVisitorOptions } from "./LambderTestVisitor.js";
/**
 * What a test app may be told. Nothing is required: `lambderTestApp(lambder)`
 * is a working test app over memory stores.
 *
 * The stores sit where create() takes them (`session.store`,
 * `rateLimits.limiter`, `idempotency.store`, `files`), naming only the part a
 * test replaces; everything else the app configured there stays in force.
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
    session?: {
        store?: LambderSessionStore<any>;
    };
    /** Default: a fresh LambderMemoryRateLimiter. */
    rateLimits?: {
        limiter?: LambderRateLimiter;
    };
    /** Default: a fresh LambderMemoryIdempotencyStore. */
    idempotency?: {
        store?: LambderIdempotencyStore;
    };
    /** Default: the app's own source, which suits one that reads a local folder. Pass a LambderLocalFileSource over fixtures for an app whose production source is S3 or HTTP. */
    files?: LambderFileSource;
};
/**
 * A Lambder instance as a test app takes it: any instance, read for its
 * session data type and, through the ApiContract property rather than the
 * class parameter, for its contract. The property lets a large app name its
 * flattened contract interface explicitly
 * (`lambderTestApp<SessionData, ApiContractType>(lambder)`) and keep the
 * cheap type check that interface exists for.
 */
export type LambderTestedInstance<TSessionData, TContract> = Lambder<TSessionData, any, any, any, any, any, any, any> & {
    readonly ApiContract: TContract;
};
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
 */
export declare class LambderTestApp<TContract extends LambderApiContractShape = any, TSessionData = any> {
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
    private readonly lambder;
    private readonly wiring;
    /** The memory stores this test app made itself, which reset() empties. One the test supplied is the test's: nothing here knows what else holds it. */
    private readonly ownStores;
    private visitorCount;
    private resetCount;
    private readonly crashList;
    /**
     * The call a crash happened under. The app's 500 says nothing about the
     * crash, so the error travels beside the answer, and with concurrent
     * calls (a duplicate sent while the original is in flight is an ordinary
     * idempotency test) only the async context says which call it belongs to.
     */
    private readonly crashScope;
    constructor(lambder: LambderTestedInstance<TSessionData, TContract>, options?: LambderTestAppOptions);
    /**
     * Every error the app threw while answering a request since the last
     * reset, in order: what reached its global error handler, or the
     * framework's last-resort 500. The answers say nothing about what was
     * thrown, so a test reads it here; `expect(app.crashes).toEqual([])`
     * says nothing crashed. A refusal is not a crash, and neither is an
     * error an `event()` rejects with, which the test already holds.
     */
    get crashes(): readonly Error[];
    /** The session manager, for tests that inspect or manipulate sessions directly. Throws when the app has no sessions. */
    get sessionManager(): LambderSessionManager<TSessionData>;
    /**
     * A new simulated browser: its own cookie jar, and its own address unless
     * one is given. A stranger until it signs in, through the app's own login
     * API or through `signIn`.
     */
    visitor<TProvidedGuards extends string = never>(...[options]: LambderTestVisitorArgs<LambderTestVisitorOptions<TContract, TProvidedGuards>, TProvidedGuards>): LambderTestVisitor<TContract, TSessionData, TProvidedGuards>;
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
    signIn<TProvidedGuards extends string = never>(sessionKey: string, data: TSessionData, ...[options]: LambderTestVisitorArgs<LambderTestVisitorOptions<TContract, TProvidedGuards> & {
        ttlSeconds?: number;
    }, TProvidedGuards>): Promise<LambderTestVisitor<TContract, TSessionData, TProvidedGuards>>;
    /**
     * Ends every session of the subject, the way "log out everywhere" does.
     * A visitor signed in as that subject keeps its cookies, as a browser
     * would, so its next call is what a real one's would be: answered
     * sessionExpired, with the stale cookies evicted.
     */
    signOut(sessionKey: string): Promise<void>;
    /** Marks the subject's session data stale, so the next read renews it through the app's dataRefresh. */
    expireSessionData(sessionKey: string): Promise<void>;
    /**
     * Hands the handler an event that is not an HTTP request (a schedule, an
     * SNS or SQS delivery), which is how an addAction handler runs, with a
     * Lambda context filled in. Resolves to whatever the action returned.
     *
     * ```typescript
     * await app.event({ source: "aws.events", "detail-type": "Scheduled Event" });
     * ```
     */
    event(event: unknown, context?: Partial<Context>): Promise<unknown>;
    /**
     * Rewinds what accumulated: sessions, rate-limit counters and replay
     * records in the stores this test app made, the crashes it recorded, and
     * the cookies of every visitor it created (each empties its jar the next
     * time it is used). For a beforeEach. The app's own data (its database)
     * is the app's to rewind.
     */
    reset(): void;
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
export declare const lambderTestApp: <TSessionData = any, TContract extends LambderApiContractShape = any>(lambder: LambderTestedInstance<TSessionData, TContract>, options?: LambderTestAppOptions) => LambderTestApp<TContract, TSessionData>;

import LambderCaller from "../client/LambderCaller.js";
import type { LambderHttpEventFormat } from "../core/LambderContext.js";
import type { LambderHandler } from "../core/LambderCreateOptions.js";
import { type LambderLambdaHttpResult } from "../invoke/LambderLambdaEvent.js";
import type { LambderCreatedSession } from "../session/LambderSessionManager.js";
import { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
import type { LambderApiContractShape } from "../shared/wire/LambderApiContract.js";
import type { LambderApiSignatureMap } from "../shared/wire/LambderApiSignature.js";
import type { LambderGuardInputsProviderOption } from "../shared/wire/LambderCallOptions.js";
/**
 * How one visitor differs from the next. Everything is optional: a visitor
 * nobody described is a stranger on the app's host, at an address of its own.
 */
export type LambderTestVisitorOptions<TContract, TProvidedGuards extends string = never> = {
    /** The host this visitor browses (ctx.host), and the host its cookies are scoped to. Default: the test app's. */
    host?: string;
    /**
     * The address the gateway observed (ctx.ip). Default: one no other
     * visitor of this test app has, so a `per: "ip"` rate limit counts each
     * visitor apart, as it does for two people in production. Give two
     * visitors the same one to test what a shared address does.
     */
    clientIp?: string;
    /** Headers every request of this visitor carries, under those a single call or request adds: what a CDN in front of the app writes (a country header), or a user agent. */
    headers?: Record<string, string>;
    /** Sent with every API call as `version`. Default: none, and a call naming no version is not judged by minApiVersion. */
    apiVersion?: string;
    /** Sent per API call as `signature`. Default: none, and a call carrying no signature is never gated; pass a map to test the gate itself. */
    apiSignatures?: LambderApiSignatureMap;
} & LambderGuardInputsProviderOption<TContract, TProvidedGuards>;
/** What `request()` sends beside the method and the path. */
export type LambderTestRequestInit = {
    /** Query parameters, merged over any the path itself carries. */
    query?: Record<string, string>;
    headers?: Record<string, string>;
    /** Sent as is: a string is JSON unless a content-type header says otherwise, a Buffer is binary. */
    body?: string | Buffer;
};
/**
 * What a test app hands each of its visitors: the handler they call, and the
 * one thing a visitor cannot do alone, which is start a session without a
 * login endpoint. The session model is the instance's, so the test app mints
 * and the visitor keeps the cookies.
 */
export type LambderTestVisitorWiring<TSessionData> = {
    handler: LambderHandler;
    apiPath: string;
    /** The gateway shape every event is synthesized in; the test app's, since a deployment sits behind one gateway. */
    eventFormat: LambderHttpEventFormat;
    /** The app's session cookie names, or null when it has no sessions. */
    sessionCookieNames: {
        tokenCookieKey: string;
        csrfCookieKey: string;
    } | null;
    issueSession: (host: string, sessionKey: string, data: TSessionData, ttlSeconds?: number) => Promise<{
        created: LambderCreatedSession<TSessionData>;
        setCookies: string[];
    }>;
    /** How many times the test app was reset. A visitor compares it with the count it last saw, so the test app keeps no list of the visitors it made. */
    resetCount: () => number;
    /** Runs one call, and hands back beside its result the error the app threw while answering it, if it crashed. */
    watchCrash: <TResult>(run: () => Promise<TResult>) => Promise<{
        result: TResult;
        crash: Error | null;
    }>;
};
/**
 * The options argument of `visitor()` and `signIn()`: optional, until the
 * call names provided guards. Then the provider that supplies them is
 * required, as it is on LambderCaller, since naming guards without one would
 * send nothing for them.
 */
export type LambderTestVisitorArgs<TOptions, TProvidedGuards extends string> = [
    TProvidedGuards
] extends [never] ? [options?: TOptions] : [options: TOptions];
/**
 * One simulated browser in front of a real Lambder app: a cookie jar, an
 * address and a host of its own, and two ways in. `api` / `apiOutcome` are a
 * typed LambderCaller's, over the real handler in this process, so a call
 * runs the whole pipeline (rate limits, session, replay, guards, validation)
 * the way a browser's would. `request` is everything else a browser sends:
 * pages, redirects, session routes, file requests. Both carry the same jar,
 * so a session started through one is the session the other presents.
 *
 * Created by `LambderTestApp.visitor()` and `signIn()`, not constructed.
 */
export declare class LambderTestVisitor<TContract extends LambderApiContractShape = any, TSessionData = any, TProvidedGuards extends string = never> {
    readonly host: string;
    readonly clientIp: string;
    /**
     * The typed caller `api` and `apiOutcome` run on, for code under test
     * that takes a LambderCaller itself (a frontend store, a shared client
     * module): handed this one, it talks to the real server in this process.
     * An answer's logList is not printed; it is on the outcome.
     */
    readonly caller: LambderCaller<TContract, TProvidedGuards>;
    /** The payload on success, `undefined` on a failure: LambderCaller.api, through this visitor. */
    readonly api: LambderCaller<TContract, TProvidedGuards>["api"];
    /**
     * The full outcome, never throwing: LambderCaller.apiOutcome, through
     * this visitor. Pair it with assertApiSuccess / assertApiFailure.
     *
     * When the app crashed answering the call, the outcome is the `server`
     * failure any client would get, whose error says only "Request failed:
     * 500"; here that error's `cause` is what the app actually threw, stack
     * included, so a failing test points at the line in the handler.
     */
    readonly apiOutcome: LambderCaller<TContract, TProvidedGuards>["apiOutcome"];
    private readonly wiring;
    private readonly headers;
    private readonly cookieJar;
    private seenResetCount;
    constructor(wiring: LambderTestVisitorWiring<TSessionData>, options: LambderTestVisitorOptions<TContract, TProvidedGuards> & {
        host: string;
        clientIp: string;
    });
    /**
     * This visitor's cookies, to inspect or clear; every call and request
     * reads and fills them. The test app's reset() empties them, noticed here
     * the next time anything asks: a jar still holding the token of an
     * emptied store would read as signed in until an answer said otherwise.
     */
    get jar(): LambderCookieJar;
    /**
     * One HTTP request to the app that is not an API call, answered by
     * whatever answers it in production: a route, a session route, the public
     * files, the index page, a fallback. The answer comes back decoded
     * (decompressed, headers lowercased), redirects are not followed, and
     * its Set-Cookie headers land in this visitor's jar.
     *
     * ```typescript
     * const page = await visitor.request("GET", "/orders?page=2");
     * expect(page.statusCode).toBe(200);
     * expect(page.text()).toContain("Your orders");
     * ```
     */
    request(method: string, path: string, init?: LambderTestRequestInit): Promise<LambderLambdaHttpResult>;
    /**
     * Starts a session for this visitor without a login endpoint: minted by
     * the app's own session model, under its own cookie options, and planted
     * in this visitor's jar, so its next call is signed in. Returns the raw
     * tokens too, as LambderMockApp.signIn does.
     *
     * Throws when the cookies do not stick. An app that scopes its session
     * cookie to a domain (`cookie: { domain: ".example.com" }`) this visitor's
     * host is not under writes a cookie a browser on that host would drop, and
     * the jar drops it too; left silent, every later session call would
     * answer sessionExpired with nothing to say why.
     */
    signIn(sessionKey: string, data: TSessionData, options?: {
        ttlSeconds?: number;
    }): Promise<LambderCreatedSession<TSessionData>>;
}

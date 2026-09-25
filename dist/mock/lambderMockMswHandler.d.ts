import { type LambderApiRequest } from "../api/LambderApiRequest.js";
import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
/**
 * The parts of the msw module the adapter uses: `import * as msw from "msw"`.
 *
 * Written so the real package satisfies it. msw's resolver answers a
 * Response, or `undefined` to hand the request back (its
 * AsyncResponseResolverReturnType); a resolver declared to return
 * `Promise<unknown>` is not assignable to that, so `http.post` would not fit
 * here and the returned handler would not fit `setupWorker`.
 */
export type LambderMswModule = {
    http: {
        post: (path: string, resolver: (info: {
            request: Request;
        }) => Promise<Response | undefined>) => unknown;
    };
    HttpResponse: {
        new (body?: BodyInit | null, init?: ResponseInit): Response;
        error(): Response;
    };
};
/** What the adapter needs from the mock app: a parsed request in, an answer out, and the runtime's own bookkeeping. */
export type LambderMockMswTarget = {
    handleRequest(request: LambderApiRequest): Promise<LambderApiAnswer>;
    /**
     * Whether this name would be answered from the registry, overrides and a
     * registered rest entry included; asked once per request, so not a list to
     * scan.
     */
    hasRegisteredEntry(apiName: string): boolean;
    /** Records a request this adapter handed on rather than answering. */
    notePassthrough(request: LambderApiRequest): void;
    /** Mirrors an answer's readable cookies into document.cookie, and remembers them for reset(). */
    mirrorCookiesIntoDocument(setCookies: readonly string[]): void;
    /** Takes the jar this adapter built as the runtime's own, so reset() empties it too. */
    adoptCookieJar(jar: LambderCookieJar): void;
    /** The IP a call carrying none is read as arriving from, so this adapter and the direct transport report one address. */
    readonly defaultClientIp: string;
    /**
     * The host the runtime's cookies belong to, which this adapter's jar is
     * scoped by. The runtime's value, not the request URL's: signIn plants at
     * the app's cookieHost and the direct transport's jar sends from there.
     * Scoped by the page's host instead, the jar would hold session cookies
     * at a host it never sends them to, and every session call behind the
     * worker would answer sessionExpired with a full jar.
     */
    readonly cookieHost: string;
};
/**
 * ONE MSW request handler for the whole API path, over the mock app: the
 * opt-in that makes mocked calls appear in the browser's network panel as
 * genuine requests, with real method, status, timing and bodies. The request
 * is read the way the server reads it, headers included, with the cookies a
 * browser would send.
 *
 * Session cookies are held in a jar here, because the browser will not hold
 * them: a response a service worker synthesizes never reaches the cookie
 * store, and MSW's own jar comma-joins the Set-Cookie headers before parsing
 * them, losing every cookie after the first. So the answer's cookies go into
 * the jar, the next request carries them back, and the ones a page's scripts
 * may see are mirrored into document.cookie. The Set-Cookie headers still
 * travel on the response, where the network panel shows them.
 *
 * A request's cookies are therefore the jar's and document.cookie's, never
 * its Cookie header: MSW fills that from its own store, which captures the
 * HttpOnly session cookie off those Set-Cookie headers and keeps it in
 * localStorage across reloads. Reading it would send a second session after
 * a user switch (every call answering sessionExpired), keep a cleared jar
 * signed in, and put the raw token into request events.
 *
 * Lambder never depends on msw: the app installs it and passes the module
 * in. An injected network failure answers MSW's network error. A POST whose
 * body is not an API envelope is left to other handlers.
 *
 * Generic over the module so the handler keeps msw's own handler type, which
 * is what `setupWorker(...)` and `setupServer(...)` take; typed `unknown`,
 * the documented wiring would be a type error at the consumer.
 */
export declare const lambderMockMswHandler: <M extends LambderMswModule>(mockApp: LambderMockMswTarget, options: {
    msw: M;
    apiPath: string;
    cookieJar?: LambderCookieJar;
    /**
     * What happens to a call the runtime has no entry for. "refuse"
     * (the default) answers the apiNotFound refusal, which is what an
     * exhaustive `register` is for. "passthrough" leaves the request to
     * MSW's other handlers and, failing those, to the network: the shape
     * a partially mocked app runs in while its remaining endpoints still
     * come from a real backend.
     *
     * This and `mockApp.restNotMocked(reason)` answer the same question,
     * and the rest entry wins: it gives the runtime an entry for every
     * name, so nothing is unmocked here and a call is answered notMocked
     * rather than passed on. Pick the rest entry for an app with no
     * backend to reach, and this for one whose remaining endpoints are
     * served by a real one.
     */
    onUnmocked?: "refuse" | "passthrough";
    /** The client IP its calls are read as arriving from. Default: the runtime's own defaultClientIp. */
    clientIp?: string;
}) => ReturnType<M["http"]["post"]>;

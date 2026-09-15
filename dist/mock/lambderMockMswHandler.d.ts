import { type LambderApiRequest } from "../api/LambderApiRequest.js";
import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
/**
 * The parts of the msw module the adapter uses: `import * as msw from "msw"`.
 *
 * Written so the real package satisfies it, which is the whole point of a
 * structural declaration and was not true of the previous one. msw's resolver
 * answers a Response, or `undefined` to hand the request back (its
 * AsyncResponseResolverReturnType), and a resolver declared to return
 * `Promise<unknown>` is not assignable to that, so `http.post` did not fit
 * here and the handler this returned did not fit `setupWorker`. Both errors
 * landed on the documented five-line wiring.
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
     * the app's cookieHost and the direct transport's jar sends from there, so
     * an adapter scoping by whatever host the page is served from held the
     * session cookies at a host it never sent them to, and every session call
     * behind the worker answered sessionExpired with a full jar.
     */
    readonly cookieHost: string;
};
/**
 * ONE MSW request handler for the whole API path, over the mock app: the
 * opt-in that makes mocked calls appear in the browser's network panel as
 * genuine requests, with real method, status, timing and bodies. The request
 * is read the way the server reads it, its headers and Cookie header
 * included.
 *
 * Session cookies are held in a jar here rather than by the browser, because
 * the browser will not hold them: a response a service worker synthesizes
 * never reaches the cookie store, and MSW's own jar comma-joins the
 * Set-Cookie headers before parsing them, which loses every cookie after the
 * first. So the answer's cookies go into the jar, the next request carries
 * them back, and the ones a page's scripts may see are mirrored into
 * document.cookie. The Set-Cookie headers still travel on the response, where
 * the network panel shows them.
 *
 * Lambder never depends on msw: the app installs it and passes the module
 * in. An injected network failure answers MSW's network error. A POST whose
 * body is not an API envelope is left to other handlers.
 *
 * Generic over the module so the handler keeps msw's own handler type, which
 * is what `setupWorker(...)` and `setupServer(...)` take. Returning `unknown`
 * made the documented wiring an error at the consumer.
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
     * This and `mockApp.restNotMocked(reason)` are the two answers to the
     * same question, and the rest entry wins: it leaves the runtime with
     * an entry for every name, so nothing is ever unmocked here and a call
     * that would have gone to the network is answered notMocked instead.
     * Pick the rest entry for an app with no backend to reach, and this
     * for one whose remaining endpoints are served by a real one.
     */
    onUnmocked?: "refuse" | "passthrough";
    /** The client IP its calls are read as arriving from. Default: the runtime's own defaultClientIp. */
    clientIp?: string;
}) => ReturnType<M["http"]["post"]>;

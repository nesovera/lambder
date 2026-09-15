import { LambderMockTransportError } from "./LambderMockFailureInjector.js";
import { readApiEnvelope, cookieValuesByName, lowercaseHeaderNames } from "../api/LambderApiRequest.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
import { normalizeClientIp } from "../shared/util/LambderClientIp.js";
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
export const lambderMockMswHandler = (mockApp, options) => {
    const { msw, apiPath } = options;
    if (!msw?.http || !msw?.HttpResponse) {
        throw new Error('lambderMockMswHandler requires the msw module: lambderMockMswHandler(mockApp, { apiPath, msw: await import("msw") }). Install it with: npm install msw --save-dev');
    }
    const jar = options.cookieJar ?? new LambderCookieJar();
    // A jar the app passed stays the app's; the one built here is the
    // runtime's, so its reset() empties it along with the sessions those
    // cookies name.
    if (!options.cookieJar)
        mockApp.adoptCookieJar(jar);
    // The runtime's default, not a second one of this adapter's own: an app
    // that set defaultClientIp saw its address through the direct transport
    // and 127.0.0.1 through the service worker, so a per-IP rate limit counted
    // two clients where there was one and the two adapters disagreed about
    // what ctx.request.ip is.
    // Normalized the way every other adapter's is, so one address is one
    // counter under a `per: "ip"` limit however it was spelled.
    const clientIp = normalizeClientIp(options.clientIp ?? mockApp.defaultClientIp);
    const handler = msw.http.post(apiPath, async ({ request }) => {
        let post;
        try {
            post = await request.clone().json();
        }
        catch {
            return undefined;
        }
        // Through the one header map every adapter builds, which is built on
        // Object.create(null): a header literally named __proto__ was dropped
        // here and landed as an own key on the server, and headers["toString"]
        // handed a guard an inherited function where every other adapter gives
        // undefined.
        const headers = lowercaseHeaderNames(Object.fromEntries(request.headers));
        const url = new URL(request.url);
        // Only the cookies whose scope covers this call, as a browser would
        // send: reading the whole jar sent one host's session to another as
        // soon as a jar was shared across hosts, and read cookies the request
        // path was never in scope for. The host is the runtime's own, the path
        // the one this call is going to. The jar's copies come first: where a
        // name is in both, the jar holds what this runtime last set and the
        // document's copy is the mirror of it, so the jar is the one to
        // believe.
        const cookieScope = { host: mockApp.cookieHost, path: url.pathname };
        const cookies = cookieValuesByName(jar.cookiePairs(cookieScope));
        // Pair by pair, so a name the document holds at two scopes keeps both
        // values and the session controller can weigh them, as it does on
        // the server.
        for (const [name, values] of Object.entries(cookieValuesByName((request.headers.get("cookie") ?? "").split(";")))) {
            for (const value of values) {
                if (!cookies[name]?.includes(value))
                    (cookies[name] ??= []).push(value);
            }
        }
        const parsed = readApiEnvelope(post, {
            headers, cookies, ip: clientIp, host: url.host, signal: request.signal,
        });
        if (!parsed)
            return undefined;
        // Returning undefined hands the request back to MSW, which tries its
        // other handlers and then the network. Noted on the runtime first:
        // a passthrough that leaves no event and no call-log row is a
        // mistyped endpoint name reaching the real backend in silence.
        if (options.onUnmocked === "passthrough" && !mockApp.hasRegisteredEntry(parsed.apiName)) {
            mockApp.notePassthrough(parsed);
            return undefined;
        }
        let answer;
        try {
            answer = await mockApp.handleRequest(parsed);
        }
        catch (err) {
            if (err instanceof LambderMockTransportError)
                return msw.HttpResponse.error();
            throw err;
        }
        const setCookies = getAnswerHeader(answer.headers, "Set-Cookie") ?? [];
        jar.storeSetCookies(setCookies, cookieScope);
        // The cookies a page's own scripts may see are mirrored into
        // document.cookie, so it reads the same in mocked development as it
        // does against the real backend. Not decoration: the browser caller
        // reads the CSRF token from there and posts it on the envelope, so
        // without this every session call fails its CSRF check. Through the
        // runtime, which is where the one mirror implementation lives and
        // where what was planted is remembered for reset().
        mockApp.mirrorCookiesIntoDocument(setCookies);
        const responseHeaders = new Headers();
        for (const [key, values] of Object.entries(answer.headers)) {
            for (const value of values)
                responseHeaders.append(key, value);
        }
        return new msw.HttpResponse(answer.body, { status: answer.statusCode, headers: responseHeaders });
    });
    // The call above is resolved against the constraint, which says `unknown`;
    // what the module actually hands back is its own handler type, and naming
    // it is the whole reason this function is generic.
    return handler;
};

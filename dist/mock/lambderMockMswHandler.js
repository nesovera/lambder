import { LambderMockTransportError } from "./LambderMockFailureInjector.js";
import { apiNameOfCallPath } from "../shared/wire/LambderApiNames.js";
import { readApiEnvelopeText, cookieValuesByName, isApiCallContentType, lowercaseHeaderNames } from "../api/LambderApiRequest.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import { normalizeClientIp } from "../shared/util/LambderClientIp.js";
import { LAMBDER_MOCK_ADAPTER_DOOR } from "./LambderMockAdapterDoor.js";
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
 * travel on the response, where the network panel shows them. The jar is the
 * runtime's page jar unless one is given, the one signIn plants into when it
 * is given none, so `mockApp.signIn(key, data)` signs the page in.
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
export const lambderMockMswHandler = (mockApp, options) => {
    const { msw, apiPath } = options;
    if (!msw?.http || !msw?.HttpResponse) {
        throw new Error('lambderMockMswHandler requires the msw module: lambderMockMswHandler(mockApp, { apiPath, msw: await import("msw") }). Install it with: npm install msw --save-dev');
    }
    // The runtime's bookkeeping is reached through the door a LambderMockApp
    // carries; anything else would fail on its first call rather than here.
    const door = mockApp?.[LAMBDER_MOCK_ADAPTER_DOOR];
    if (typeof door?.hasRegisteredEntry !== "function") {
        throw new Error("lambderMockMswHandler serves a LambderMockApp: pass the app initLambderMock().create() built, as lambderMockMswHandler(mockApp, { apiPath, msw }).");
    }
    // The page's jar unless the app passes its own: a jar of this adapter's
    // alone would hold the session of the calls it serves and never the one
    // signIn planted, and every session call behind the worker after a
    // signIn would answer sessionExpired.
    const jar = options.cookieJar ?? mockApp.pageCookieJar;
    // The runtime's default, not one of this adapter's own, so the direct
    // transport and the service worker agree on ctx.request.ip and a per-IP
    // rate limit counts one client as one. Normalized the way every other
    // adapter's is, so one address is one counter under a `per: "ip"` limit
    // however it was spelled.
    const clientIp = normalizeClientIp(options.clientIp ?? mockApp.defaultClientIp);
    // Every call goes to `{apiPath}/{group}/{action}`; the endpoint is read
    // off the path as the server reads it (apiNameOfCallPath).
    const handler = msw.http.post(`${apiPath.replace(/\/+$/, "")}/:group/:action`, async ({ request }) => {
        // Through the one header map every adapter builds, on
        // Object.create(null): on a plain object, a header literally named
        // __proto__ would be dropped here though the server keeps it as an own
        // key, and headers["toString"] would hand a guard an inherited
        // function where every other adapter gives undefined.
        const headers = lowercaseHeaderNames(Object.fromEntries(request.headers));
        // A POST of another type is no API call on the server either: it
        // goes on to MSW's other handlers and the network, rather than
        // working here and not in production.
        if (!isApiCallContentType(headers))
            return undefined;
        // The cookies travel as `cookies` below, as the direct transport's do.
        delete headers.cookie;
        const url = new URL(request.url);
        // Only the cookies whose scope covers this call, as a browser would
        // send: the whole jar would send one host's session to another once a
        // jar is shared across hosts, and cookies the request path is not in
        // scope for. The host is the runtime's own, the path the one this call
        // is going to. The jar's copies come first: where a name is in both,
        // the jar holds what this runtime last set and the document's copy
        // mirrors it, so the jar is the one to believe.
        const cookieScope = { host: mockApp.cookieHost, path: url.pathname };
        const cookies = cookieValuesByName(jar.cookiePairs(cookieScope));
        // Pair by pair, so a name the document holds at two scopes keeps both
        // values and the session controller can weigh them, as it does on
        // the server.
        const pageCookies = typeof document === "undefined" ? "" : document.cookie;
        for (const [name, values] of Object.entries(cookieValuesByName(pageCookies.split(";")))) {
            for (const value of values) {
                if (!cookies[name]?.includes(value))
                    (cookies[name] ??= []).push(value);
            }
        }
        const apiName = apiNameOfCallPath(new URL(apiPath, url).pathname, url.pathname);
        if (apiName === null)
            return undefined;
        // Read from the text, as the server reads it: a body that is not a
        // JSON object, or not JSON, is a call the pipeline refuses as the
        // server does, not one handed on to the network.
        const parsed = readApiEnvelopeText(await request.clone().text(), {
            headers, cookies, ip: clientIp, host: url.host, signal: request.signal,
        }, apiName);
        // Returning undefined hands the request back to MSW, which tries its
        // other handlers and then the network. Noted on the runtime first:
        // a passthrough that leaves no event and no call-log row is a
        // mistyped endpoint name reaching the real backend in silence.
        if (options.onUnmocked === "passthrough" && !door.hasRegisteredEntry(parsed.apiName)) {
            door.notePassthrough(parsed);
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
        // document.cookie, so it reads the same in mocked development as
        // against the real backend. Not decoration: the browser caller reads
        // the CSRF token from there and posts it on the envelope, so without
        // this every session call fails its CSRF check. Done by the runtime,
        // which owns the one mirror implementation and remembers what was
        // planted for reset().
        door.mirrorCookiesIntoDocument(setCookies);
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

import { buildTransportEnvelope, LambderTransportFailure } from "../shared/transport/LambderApiTransport.js";
/**
 * fetch, with a clearer error for one failure. Outside a page a relative
 * apiPath has nothing to resolve against, so fetch rejects with a URL parse
 * error that reaches the caller looking like the network is down. The
 * condition is read from the actual failure rather than guessed beforehand,
 * so a runtime that resolves relative URLs some other way is left alone.
 */
const fetchOrExplain = async (url, init) => {
    try {
        return await fetch(url, init);
    }
    catch (err) {
        // Narrow on purpose: only a URL parse failure is rewritten. A fetch
        // that rejected for any other reason, a stubbed one included, keeps
        // its own error.
        const failedToParseUrl = err instanceof TypeError && /failed to parse url|invalid url/i.test(String(err.message));
        if (failedToParseUrl && url.startsWith("/") && typeof globalThis.location?.href !== "string") {
            throw new LambderTransportFailure("protocol", `lambderFetchTransport could not resolve the relative apiPath "${url}": there is no page to resolve it against outside a browser. `
                + "Give the caller an absolute apiPath (https://api.example.com/api), or a transport that does not need one.", { cause: err });
        }
        throw err;
    }
};
/**
 * The production transport: one POST of the envelope to the API path over
 * fetch, with the cookie and CORS behaviour a browser call needs. The
 * caller's default, built from its isCorsEnabled option. `cors` defaults to
 * whether the call's apiPath is on another origin than the page's: a browser
 * refuses a same-origin mode request to another origin outright, and a
 * credentialed cross-origin one is what a separate API host needs.
 */
export const lambderFetchTransport = (options = {}) => async (request) => {
    let cors = options.cors;
    if (cors === undefined) {
        // Resolved against the page, so a protocol-relative `//api.example.com`
        // counts as another origin too. Outside a page a relative path
        // resolves against nothing and an absolute one has no page origin to
        // match, and neither matters there: a fetch outside a browser does
        // not enforce the mode.
        try {
            cors = new URL(request.apiPath, globalThis.location?.href).origin !== globalThis.location?.origin;
        }
        catch {
            cors = false;
        }
    }
    // The headers this transport sets itself leave the caller's set in any
    // spelling: fetch merges header names case-insensitively, so a
    // `content-type` beside the transport's `Content-Type` would join it
    // ("text/plain, application/json") rather than give way to it.
    const owned = new Set(['content-type', ...(request.cookies?.length ? ['cookie'] : [])]);
    const callerHeaders = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([name]) => !owned.has(name.toLowerCase())));
    const response = await fetchOrExplain(request.apiPath, {
        method: 'POST', cache: 'no-cache',
        // Cross-origin API hosts need CORS mode and included credentials.
        mode: cors ? 'cors' : 'same-origin',
        credentials: cors ? 'include' : 'same-origin',
        redirect: 'follow', referrerPolicy: 'origin',
        headers: {
            // The caller's own headers go on first so they cannot displace the
            // ones this transport owns (the synthesized invoke event does the
            // same). With the spread last, a per-call `Cookie` header would
            // replace the whole Cookie header a jar had just built, and the
            // session would go missing with nothing pointing at the cause.
            ...callerHeaders,
            'Content-Type': 'application/json',
            // The cookies the request carries: this is how a cookie jar works
            // over fetch outside a browser, where undici sends the header. A
            // page cannot (Cookie is a forbidden header name, so a browser
            // drops it and uses its own cookie store, which is right there).
            // Without it a jar would collect every Set-Cookie and send none
            // back, and a Node script against a deployed app would get
            // sessionExpired on every session call.
            ...(request.cookies?.length ? { Cookie: request.cookies.join('; ') } : {}),
        },
        body: JSON.stringify(buildTransportEnvelope(request)),
        ...(request.signal ? { signal: request.signal } : {}),
    });
    // Read here, inside the call, so the caller's timeout and abort cover the
    // whole answer: fetch resolves on the headers, and a body abandoned while
    // it downloads would otherwise read as a malformed answer (a server
    // error) rather than the timeout or abort it was.
    const body = await response.text();
    return {
        status: response.status,
        statusText: response.statusText,
        header: (name) => response.headers?.get?.(name) ?? null,
        json: async () => JSON.parse(body),
        text: async () => body,
        // Set-Cookie is unreadable from a page's script; where the runtime
        // exposes it (Node's fetch), a cookie jar can still consume it.
        ...(typeof response.headers?.getSetCookie === "function" ? { setCookies: response.headers.getSetCookie() } : {}),
    };
};

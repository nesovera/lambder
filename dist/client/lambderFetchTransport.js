import { buildTransportEnvelope, LambderTransportFailure } from "../shared/transport/LambderApiTransport.js";
/**
 * fetch, with one failure worth a better sentence than the platform gives it.
 * A relative apiPath is resolved against the page; outside a page there is no
 * page to resolve it against, so fetch rejects with a URL parse error that
 * arrives at the caller looking like the network is down. The condition is
 * read from the actual failure rather than guessed beforehand, so a runtime
 * that resolves relative URLs some other way is left alone.
 */
const fetchOrExplain = async (url, init) => {
    try {
        return await fetch(url, init);
    }
    catch (err) {
        // Narrow on purpose: only the URL failing to parse, which is what
        // this is. A transport that rejected for any other reason, a stubbed
        // one included, keeps its own meaning.
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
 * caller's default, built from its isCorsEnabled option.
 */
export const lambderFetchTransport = (options = {}) => async (request) => {
    const cors = options.cors ?? false;
    const response = await fetchOrExplain(request.apiPath, {
        method: 'POST', cache: 'no-cache',
        // Cross-origin API hosts need CORS mode and included credentials.
        mode: cors ? 'cors' : 'same-origin',
        credentials: cors ? 'include' : 'same-origin',
        redirect: 'follow', referrerPolicy: 'origin',
        headers: {
            // The caller's own headers go on first, so the ones this transport
            // owns cannot be displaced by them, the way the synthesized invoke
            // event does it. With the spread last, a per-call `Cookie` header
            // (to carry one extra cookie, say) replaced the whole Cookie
            // header a jar had just built, and the session went missing with
            // nothing in the failure pointing at the cause.
            ...(request.headers ?? {}),
            'Content-Type': 'application/json',
            // The cookies the request is meant to carry, which is how a cookie
            // jar works over fetch outside a browser: undici sends this
            // header, and a page cannot (Cookie is a forbidden header name, so
            // a browser drops it silently and uses its own cookie store, which
            // is the right answer there). Without it the jar collected every
            // Set-Cookie and sent none of them back, so a Node script against
            // a deployed app got its CSRF token filled in and sessionExpired
            // on every session call.
            ...(request.cookies?.length ? { Cookie: request.cookies.join('; ') } : {}),
        },
        body: JSON.stringify(buildTransportEnvelope(request)),
        ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
        status: response.status,
        statusText: response.statusText,
        header: (name) => response.headers?.get?.(name) ?? null,
        json: () => response.json(),
        text: () => response.text(),
        // Set-Cookie is unreadable from a page's script; where the runtime
        // exposes it (Node's fetch), a cookie jar can still consume it.
        ...(typeof response.headers?.getSetCookie === "function" ? { setCookies: response.headers.getSetCookie() } : {}),
    };
};

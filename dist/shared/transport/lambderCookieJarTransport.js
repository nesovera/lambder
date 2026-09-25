import { DEFAULT_SESSION_CSRF_COOKIE_KEY } from "../wire/LambderSessionCookieNames.js";
import { resolveApiPathTarget } from "./LambderApiTransport.js";
/**
 * Makes any transport carry a cookie jar the way a browser carries its
 * cookies: the jar's cookies ride on every request, the answer's Set-Cookie
 * headers land in the jar, and, as a page's script reads the non-HttpOnly
 * CSRF cookie, the request's `token` is filled from the jar when the caller
 * sent an empty one. This is how a session survives between calls without a
 * browser: in a Node test through lambderHandlerTransport, or in the mock
 * runtime's direct transport.
 *
 * The jar is only as scoped as the host it is told about. An absolute apiPath
 * carries one, `host` names one when the path is relative, and a browser's
 * caller falls back to its page's; an in-process or mock transport posts to a
 * relative path from a runtime with no location, so nothing there names the
 * host. Without any of the three the jar is a single host's and refuses
 * Domain cookies it cannot check (see LambderCookieJar), so give `host` (or
 * the jar one) to any jar that more than one host answers into.
 *
 * Its own file, like its three sibling transports, because it pulls in
 * tough-cookie, which a bundle that never carries a jar should be able to
 * drop.
 */
export const lambderCookieJarTransport = (inner, options) => {
    return async (request) => {
        // The caller's own name wins over the default, and an explicit option
        // over both: reading the default name regardless would hand every
        // session call an empty token whenever a caller was told a custom one
        // through setSessionCookieKey.
        const csrfCookieKey = options.csrfCookieKey ?? request.csrfCookieKey ?? DEFAULT_SESSION_CSRF_COOKIE_KEY;
        // Where the call is going. An apiPath that names its own host is a
        // fact about this request and outranks both the `host` option (the
        // fallback for a relative path) and the caller's siteHost (only the
        // page the caller is on). The other way round, a transport pinned to
        // `host: "app.example.com"` would send that host's session to an
        // absolute cross-origin apiPath. siteHost is "" outside a browser, and
        // an empty host would scope every cookie to nothing while claiming to
        // scope it.
        const target = resolveApiPathTarget(request.apiPath);
        const cookieScope = {
            host: target.host ?? options.host ?? (request.siteHost || undefined),
            path: target.path,
            ...(target.secure !== undefined ? { secure: target.secure } : {}),
        };
        const postedToken = request.token || options.jar.get(csrfCookieKey, cookieScope) || "";
        const answer = await inner({
            ...request,
            token: postedToken,
            cookies: [...(request.cookies ?? []), ...options.jar.cookiePairs(cookieScope)],
        });
        // The same scope the request was made under, so a Set-Cookie is judged
        // against the channel it actually arrived on: a Secure cookie from a
        // plain-http target is one this jar could never send back.
        if (answer.setCookies?.length)
            options.jar.storeSetCookies(answer.setCookies, cookieScope);
        // The session lives in the jar, not in document.cookie, so the caller
        // tells a sessionExpired about an older session (a poll sent before a
        // login) by the jar's token, as a page does by its cookie.
        return { ...answer, csrfTokens: { posted: postedToken, held: () => options.jar.get(csrfCookieKey, cookieScope) ?? "" } };
    };
};

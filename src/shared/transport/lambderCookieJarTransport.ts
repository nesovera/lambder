import { DEFAULT_SESSION_CSRF_COOKIE_KEY } from "../wire/LambderSessionCookieNames.js";
import { resolveApiPathTarget, type LambderApiTransport } from "./LambderApiTransport.js";
import type { LambderCookieJar } from "./LambderCookieJar.js";

/**
 * Makes any transport carry a cookie jar the way a browser carries its
 * cookies: the jar's cookies ride on every request, the answer's Set-Cookie
 * headers land in the jar, and, because a page's script reads the
 * non-HttpOnly CSRF cookie the same way, the request's `token` is filled
 * from the jar when the caller sent an empty one. This is how a session
 * survives between calls where there is no browser: in a Node test through
 * lambderHandlerTransport, or in the mock runtime's direct transport.
 *
 * The jar is only as scoped as the host it is told about. An absolute apiPath
 * carries one, `host` names one when the path is relative, and a browser's
 * caller falls back to its page's: an in-process or mock transport posts to a
 * relative path from a runtime with no location, so nothing there says which
 * host these cookies belong to. Without any of the three the jar is a single
 * host's, refusing Domain cookies it cannot check (see LambderCookieJar), so
 * give `host` (or the jar one) to any jar that more than one host answers
 * into.
 *
 * Its own file rather than a passage inside the transport seam: it is a
 * transport like its three siblings, and it is the one of them that pulls in
 * tough-cookie, which a bundle that never carries a jar should be able to
 * drop.
 */
export const lambderCookieJarTransport = (
    inner: LambderApiTransport,
    options: { jar: LambderCookieJar; csrfCookieKey?: string; host?: string },
): LambderApiTransport => {
    return async (request) => {
        // The caller's own name wins over the default, and an explicit option
        // over both: reading the default name regardless would hand every
        // session call an empty token whenever a caller was told a custom one
        // through setSessionCookieKey.
        const csrfCookieKey = options.csrfCookieKey ?? request.csrfCookieKey ?? DEFAULT_SESSION_CSRF_COOKIE_KEY;
        // Where the call is going. An apiPath that names its own host is a
        // fact about this request and outranks both the `host` option and the
        // caller's siteHost: the option is the fallback for a relative path,
        // where nothing says which host these cookies belong to, and siteHost
        // is only the page the caller happens to be on. Read the other way
        // round, a transport pinned to `host: "app.example.com"` sent
        // app.example.com's session to an absolute cross-origin apiPath.
        // siteHost is "" outside a browser, and an empty host would scope
        // every cookie to nothing while claiming to scope it.
        const target = resolveApiPathTarget(request.apiPath);
        const cookieScope = {
            host: target.host ?? options.host ?? (request.siteHost || undefined),
            path: target.path,
            ...(target.secure !== undefined ? { secure: target.secure } : {}),
        };
        const answer = await inner({
            ...request,
            token: request.token || options.jar.get(csrfCookieKey, cookieScope) || "",
            cookies: [...(request.cookies ?? []), ...options.jar.cookiePairs(cookieScope)],
        });
        // The same scope the request was made under, so a Set-Cookie is judged
        // against the channel it actually arrived on: a Secure cookie from a
        // plain-http target is one this jar could never send back.
        if(answer.setCookies?.length) options.jar.storeSetCookies(answer.setCookies, cookieScope);
        return answer;
    };
};

import { type LambderApiTransport } from "./LambderApiTransport.js";
import type { LambderCookieJar } from "./LambderCookieJar.js";
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
export declare const lambderCookieJarTransport: (inner: LambderApiTransport, options: {
    jar: LambderCookieJar;
    csrfCookieKey?: string;
    host?: string;
}) => LambderApiTransport;

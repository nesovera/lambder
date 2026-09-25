import { type LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
/**
 * Where the runtime's cookies live outside its own answers: the jars it built
 * for itself, and the copies it planted in the page's cookie storage. A
 * collaborator of LambderMockApp that owns state nothing else touches, meets
 * the runtime at two calls (an answer coming back, reset()), and holds the
 * one outside dependency, `document`, keeping the app free of browser
 * conditionals.
 *
 * The direct transport's "document" mode and the MSW adapter share one
 * instance, so they cannot disagree on dropping `Secure`: on plain http
 * (device testing on a LAN address) a kept `Secure` makes the browser
 * silently refuse the CSRF cookie, failing every session call's CSRF check
 * with nothing in any log.
 */
export declare class LambderMockBrowserCookies {
    /** The jars transport() and the adapters built for themselves, which reset() is therefore free to empty. */
    private readonly ownedJars;
    /** What was mirrored into document.cookie, so reset() can expire exactly those. */
    private readonly mirroredCookies;
    /**
     * Takes a jar built for the runtime as the runtime's own, so reset()
     * empties it with the rest. A jar the app passed in stays the app's, like
     * an app-supplied session store: the runtime does not know what else
     * holds it.
     */
    adoptJar(jar: LambderCookieJar): void;
    /**
     * Mirrors an answer's non-HttpOnly cookies into document.cookie and
     * remembers them for reset().
     *
     * HttpOnly cookies are skipped as a real browser skips them; the jar is
     * the store no script can reach. `Secure` is dropped where the page is not
     * a secure context, since the browser would refuse the write and plain
     * http on a LAN address has to keep working. The browser then discards a
     * `__Host-` or `__Secure-` name for breaking its prefix rule, which is
     * correct: such a name cannot work on plain http, and localhost is a
     * secure context.
     */
    mirrorSetCookies(setCookies: readonly string[]): void;
    /**
     * Empties the jars the runtime owns and expires what it mirrored, which is
     * what clearing the page's cookie storage would do.
     *
     * Part of a rewind as much as the session store is: emptying the store
     * while a jar still holds one of its session tokens leaves the next call
     * carrying a dead session, which reads as signed in until the answer says
     * sessionExpired.
     */
    reset(): void;
}

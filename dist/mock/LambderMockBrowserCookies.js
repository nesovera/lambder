import { parseSetCookie } from "../shared/transport/LambderCookieJar.js";
/**
 * Where the runtime's cookies live outside its own answers: the jars it built
 * for itself, and the copies it planted in the page's own cookie storage.
 *
 * The fourth of LambderMockApp's collaborators, and the same argument as the
 * other three: it owns state nothing else touches and meets the runtime at two
 * calls (a transport's answer coming back, and reset()). It is the piece with
 * an outside dependency, `document`, so keeping it here is also what keeps the
 * app free of browser conditionals.
 *
 * Both the direct transport's "document" mode and the MSW adapter come through
 * one instance, so there is one mirror implementation and one record of what
 * was planted. They carried a copy each before: the MSW copy dropped `Secure`
 * on a page that is not a secure context and the transport's did not, so on
 * plain http (device testing on a LAN address) the browser silently refused
 * the CSRF cookie and every session call failed its CSRF check with nothing in
 * any log to say why.
 */
export class LambderMockBrowserCookies {
    /** The jars transport() and the adapters built for themselves, which reset() is therefore free to empty. */
    ownedJars = new Set();
    /** What was mirrored into document.cookie, so reset() can expire exactly those. */
    mirroredCookies = new Map();
    /**
     * Takes a jar built for the runtime as the runtime's own, so reset()
     * empties it with the rest. A jar the app passed in stays the app's, the
     * way an app-supplied session store does: the runtime did not create it and
     * does not know what else holds it.
     */
    adoptJar(jar) {
        this.ownedJars.add(jar);
    }
    /**
     * Mirrors an answer's non-HttpOnly cookies into document.cookie and
     * remembers them for reset().
     *
     * HttpOnly cookies are skipped exactly as a real browser skips them, the
     * jar being the store no script can reach. `Secure` is dropped where the
     * page is not a secure context, because the browser would refuse the write
     * and development over plain http on a LAN address has to keep working. A
     * `__Host-` or `__Secure-` cookie name is then discarded by the browser
     * for breaking its own prefix rule, which is correct: such a name cannot
     * work on plain http at all, and localhost is a secure context.
     */
    mirrorSetCookies(setCookies) {
        if (typeof document === "undefined")
            return;
        const secureContext = typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : true;
        for (const header of setCookies) {
            const cookie = parseSetCookie(header, Date.now());
            if (!cookie || cookie.httpOnly)
                continue;
            document.cookie = secureContext ? header : header.replace(/;\s*Secure\b/i, "");
            this.mirroredCookies.set(`${cookie.name}|${cookie.path}`, { name: cookie.name, path: cookie.path });
        }
    }
    /**
     * Empties the jars the runtime owns and expires what it mirrored, which is
     * what clearing the page's cookie storage would do.
     *
     * As much a part of a rewind as the session store is: emptying the store
     * while a jar still holds the token for one of its sessions leaves the next
     * call carrying a session that no longer exists, which reads as signed in
     * until the answer says sessionExpired.
     */
    reset() {
        for (const jar of this.ownedJars)
            jar.clear();
        if (typeof document !== "undefined") {
            for (const cookie of this.mirroredCookies.values())
                document.cookie = `${cookie.name}=; Path=${cookie.path}; Max-Age=0`;
        }
        this.mirroredCookies.clear();
    }
}

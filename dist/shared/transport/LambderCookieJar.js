/**
 * The cookie jar a transport carries (LambderCookieJar), and the Set-Cookie
 * parsing behind it. tough-cookie is reached from this module and no other, so
 * a bundle that never carries a jar drops it.
 */
import { Cookie, CookieJar as ToughCookieJar, defaultPath, pathMatch } from "tough-cookie";
/**
 * Stands in for the host of a jar that was never told one. Every store and
 * read of such a jar uses it, so the jar behaves consistently as the browser
 * of one unnamed host. `.invalid` is IANA-reserved, so a cookie parked here
 * can never match a real target by accident.
 */
const UNNAMED_JAR_HOST = "lambder-cookie-jar.invalid";
/** The host without its port, lowercased: "App.Test:3000" is "app.test", "[::1]:8080" is "[::1]". */
const normalizeHost = (host) => {
    const lowered = host.trim().toLowerCase();
    // An IPv6 literal is bracketed and full of colons, so only what follows
    // the closing bracket can be a port; splitting on ":" would leave "[".
    if (lowered.startsWith("[")) {
        const close = lowered.indexOf("]");
        return close === -1 ? lowered : lowered.slice(0, close + 1);
    }
    return lowered.split(":")[0] ?? lowered;
};
/** The URL tough-cookie works in terms of. https unless the target says it speaks plain http, which is what decides a Secure cookie. */
const urlFor = (host, path, secure) => `${secure ? "https" : "http"}://${host}${path && path.startsWith("/") ? path : "/"}`;
/**
 * When a cookie actually dies, as an absolute moment.
 *
 * Max-Age and Expires are stored separately and Max-Age wins, so reading
 * `expires` alone would call a `Max-Age=0` deletion immortal. The library's
 * expiryTime() resolves Max-Age against whatever moment it is handed (or
 * lastAccessed), so it cannot answer "when does this die" on a fixed clock.
 * A browser measures Max-Age from when the cookie arrived, its creation.
 */
const cookieExpiryAt = (cookie, now) => {
    if (typeof cookie.maxAge === "number") {
        const receivedAt = cookie.creation instanceof Date ? cookie.creation.getTime() : now;
        return receivedAt + cookie.maxAge * 1000;
    }
    return cookie.expires instanceof Date ? cookie.expires.getTime() : undefined;
};
const storedFromCookie = (cookie, now) => {
    const hostOnly = cookie.hostOnly === true;
    const domain = typeof cookie.domain === "string" ? cookie.domain : undefined;
    const expiryAt = cookieExpiryAt(cookie, now);
    return {
        name: cookie.key ?? "",
        value: cookie.value ?? "",
        domain: hostOnly ? undefined : domain,
        // A jar that never learned a host parks cookies under the stand-in,
        // an implementation detail rather than something it knows.
        ...(hostOnly && domain !== undefined && domain !== UNNAMED_JAR_HOST ? { host: domain } : {}),
        path: typeof cookie.path === "string" ? cookie.path : "/",
        expires: expiryAt,
        httpOnly: cookie.httpOnly === true,
        secure: cookie.secure === true,
    };
};
/**
 * One Set-Cookie header value, read the way a browser reads it. `requestPath`
 * is the path the answer came from, which decides the default Path. Returns
 * null for a header no browser would keep.
 */
export const parseSetCookie = (header, now, requestPath) => {
    const parsed = Cookie.parse(header, { loose: false });
    if (!parsed)
        return null;
    // Cookie.parse stamps creation with the real clock, but Max-Age is
    // measured from the caller's `now`, when this header arrived.
    parsed.creation = new Date(now);
    // Max-Age against Expires on the caller's clock, as the jar resolves it,
    // so a test moving time forward reads the same expiry here.
    return {
        ...storedFromCookie(parsed, now),
        // Cookie.parse leaves an absent Path absent; the default-path is the
        // sending path's directory, which only the caller knows.
        path: parsed.path ?? defaultPath(requestPath ?? "/"),
    };
};
/**
 * A browser's cookie storage, for transports that have no browser: the
 * in-process handler transport in a Node test, and the mock runtime's direct
 * transport. It stores what an answer's Set-Cookie headers set, honours their
 * expiry and deletion, and hands back the Cookie pairs the next request should
 * carry. One jar is one browser.
 *
 * The rules (domain and path matching, default-path, Max-Age against Expires,
 * Secure, HttpOnly, the __Host-/__Secure- prefixes) are tough-cookie's, the
 * reference RFC 6265 implementation, imported for its public suffix list:
 * counting labels can tell `Domain=com` is a registry suffix but not `co.uk`,
 * so a hand-rolled jar either trusts `Domain=co.uk` or bans every two-label
 * domain.
 *
 * What stays Lambder's is the shape of a transport's questions: Set-Cookie
 * header lists in (storeSetCookies), `name=value` pairs out (cookiePairs),
 * and a target given as host and path, since a transport that never speaks
 * HTTP has no URL. An omitted field matches anything, because a jar pointed
 * at a single host is the ordinary case and should not have to name it.
 *
 * SameSite is stored but never consulted: it answers "did another site
 * initiate this", and every transport call is same-site by construction.
 */
export class LambderCookieJar {
    // prefixSecurity "silent" drops a __Host-/__Secure- cookie that breaks its
    // own prefix rules instead of throwing, which is what a browser does.
    jar = new ToughCookieJar(undefined, { prefixSecurity: "silent", allowSpecialUseDomain: true });
    now;
    host;
    /** `host` is the host this jar is the browser of: the sender of every answer and the target of every request that names none. */
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.host = options.host === undefined ? undefined : normalizeHost(options.host);
    }
    /** The host a call is about, or the stand-in when neither the call nor the jar names one. */
    hostFor(given) {
        return given !== undefined ? normalizeHost(given) : this.host ?? UNNAMED_JAR_HOST;
    }
    /**
     * Applies Set-Cookie header values as a browser would: stores, replaces,
     * and deletes on an expiry in the past. `request` says where the answer
     * came from. Its `host` is the sending host, which every Domain is checked
     * against, and its `path` is the default Path of a cookie that names none.
     *
     * A Domain the sender is not under voids the cookie rather than narrowing
     * it (RFC 6265 section 5.3 step 6), and so does a public-suffix Domain.
     * Otherwise evil.example.com could plant a cookie that bank.example.com
     * is handed on the next call.
     */
    storeSetCookies(headers, request = {}) {
        // A cookie is judged against the channel it arrived on. Assuming https
        // would accept Secure cookies from a plain-http answer and then never
        // send them, leaving the jar silently holding an unusable session.
        const secure = request.secure !== false;
        const url = urlFor(this.hostFor(request.host), request.path, secure);
        const now = new Date(this.now());
        for (const header of headers) {
            // tough-cookie checks Domain, prefixes and HttpOnly against the
            // URL but leaves Secure to the caller: RFC 6265 lets plain http
            // set one, browsers do not. A cookie this jar would refuse to send
            // is one it refuses to keep.
            if (!secure && Cookie.parse(header, { loose: false })?.secure)
                continue;
            // ignoreError: a cookie a browser would refuse is one this jar
            // refuses, silently, rather than failing the call that carried it.
            this.jar.setCookieSync(header, url, { http: true, now, ignoreError: true });
        }
    }
    /** Every live cookie. */
    list() {
        const now = this.now();
        return (this.jar.serializeSync()?.cookies ?? [])
            .map((serialized) => Cookie.fromJSON(serialized))
            .filter((cookie) => cookie !== undefined)
            .map((cookie) => storedFromCookie(cookie, now))
            .filter((cookie) => cookie.expires === undefined || cookie.expires > now);
    }
    /**
     * The Cookie header pairs the next request carries, as `name=value`, in
     * RFC 6265 section 5.4 order: longest Path first, and among equal paths
     * the one set first. Servers that read only the first value of a repeated
     * name depend on that order, as does any test about which of two
     * same-named cookies wins.
     *
     * Only cookies whose scope covers the target travel. An omitted target
     * field matches anything, so a caller that cannot name its host still
     * gets the cookies of the one host its jar talks to.
     */
    cookiePairs(target = {}) {
        return this.matchingCookies(target).map((cookie) => `${cookie.name}=${cookie.value}`);
    }
    /**
     * One cookie's value as a page's script would read it: HttpOnly cookies
     * are invisible unless asked for, which is how the transport fills in the
     * CSRF token the caller would have read from document.cookie.
     */
    get(name, options = {}) {
        return this.matchingCookies(options, options.includeHttpOnly === true)
            .find((cookie) => cookie.name === name)?.value;
    }
    /**
     * The live cookies whose scope reaches this target, in RFC 6265 send
     * order. Delegated to tough-cookie whenever a host is known, the case
     * worth getting exactly right; with no host, every cookie the jar holds
     * is filtered by the rules that need none and ordered the same way.
     */
    matchingCookies(target, includeHttpOnly = true) {
        const secure = target.secure !== false;
        if (target.host !== undefined || this.host !== undefined) {
            const url = urlFor(this.hostFor(target.host), target.path, secure);
            return this.jar
                .getCookiesSync(url, {
                // http: false is a script reading document.cookie, which
                // is exactly what hides an HttpOnly cookie.
                http: includeHttpOnly,
                // A target that named no path is asking about the jar, not
                // about one endpoint.
                allPaths: target.path === undefined,
                // tough-cookie returns store order unless asked; RFC 6265
                // order is what a server reading the first of a repeated
                // name gets.
                sort: true,
            })
                .map((cookie) => storedFromCookie(cookie, this.now()))
                // getCookiesSync expires against the real clock; a jar given
                // an injected one is usually a test moving time forward.
                .filter((cookie) => cookie.expires === undefined || cookie.expires > this.now())
                // tough-cookie treats a loopback or localhost target as a
                // secure context and sends Secure cookies to it over http.
                // This jar takes `secure: false` at its word both ways, so
                // what it stores and what it sends agree.
                .filter((cookie) => secure || !cookie.secure);
        }
        return this.list()
            .filter((cookie) => {
            if (cookie.httpOnly && !includeHttpOnly)
                return false;
            if (cookie.secure && !secure)
                return false;
            if (target.path !== undefined && !pathMatch(target.path, cookie.path))
                return false;
            return true;
        })
            // Longest path first, as tough-cookie sorts; the sort is stable,
            // so equal paths keep their creation order.
            .sort((a, b) => b.path.length - a.path.length);
    }
    /** Number of live cookies. */
    get size() { return this.list().length; }
    /** Forgets every cookie: the browser's storage cleared. */
    clear() {
        this.jar.removeAllCookiesSync();
    }
}

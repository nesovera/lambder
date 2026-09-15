/**
 * The cookie jar a transport carries (LambderCookieJar), and the Set-Cookie
 * parsing behind it. tough-cookie is reached from this module and no other, so
 * a bundle that never carries a jar drops it.
 */

import { Cookie, CookieJar as ToughCookieJar, defaultPath, pathMatch, type SerializedCookie } from "tough-cookie";

/** A cookie as the jar holds it. Epoch milliseconds for `expires`, and `host` set only for a host-only cookie. */
export type LambderStoredCookie = {
    name: string;
    value: string;
    /** The Domain attribute, without its leading dot; undefined for a host-only cookie. */
    domain: string | undefined;
    /** The host that set it, when it carried no Domain. Absent when the jar never learned a host. */
    host?: string;
    path: string;
    /** Epoch milliseconds; undefined for a browser-session cookie. */
    expires: number | undefined;
    httpOnly: boolean;
    /** Withheld from a target known to be plain http; a target of unknown scheme (in-process, mock) still carries it. */
    secure: boolean;
};

/** Where a call is going, as far as a cookie's scope is concerned. An absent field is one the caller could not know, and matches anything. */
type LambderCookieTarget = {
    host?: string;
    path?: string;
    /** False only for a target known to speak plain http, which neither accepts a Secure cookie nor sends one. */
    secure?: boolean;
};

/**
 * Stands in for the host of a jar that was never told one. Every store and
 * every read of such a jar uses it, so the jar is self-consistent: it behaves
 * as the browser of one unnamed host. `.invalid` is reserved by the IANA and
 * can never be a real name, so a cookie parked here can never match a real
 * target by accident.
 */
const UNNAMED_JAR_HOST = "lambder-cookie-jar.invalid";

/** The host without its port, lowercased: "App.Test:3000" is "app.test", "[::1]:8080" is "[::1]". */
const normalizeHost = (host: string): string => {
    const lowered = host.trim().toLowerCase();
    // An IPv6 literal is bracketed and full of colons, so only what follows
    // the closing bracket can be a port; splitting on ":" would leave "[".
    if(lowered.startsWith("[")){
        const close = lowered.indexOf("]");
        return close === -1 ? lowered : lowered.slice(0, close + 1);
    }
    return lowered.split(":")[0] ?? lowered;
};

/** The URL tough-cookie works in terms of. https unless the target says it speaks plain http, which is what decides a Secure cookie. */
const urlFor = (host: string, path: string | undefined, secure: boolean): string =>
    `${secure ? "https" : "http"}://${host}${path && path.startsWith("/") ? path : "/"}`;

/**
 * When a cookie actually dies, as an absolute moment.
 *
 * Max-Age and Expires are stored separately and Max-Age wins, so reading the
 * `expires` field alone calls a `Max-Age=0` deletion immortal. The library's
 * own expiryTime() resolves Max-Age against whatever moment it is handed, and
 * against lastAccessed when handed nothing, so neither answers "when does this
 * die" on a fixed clock. A browser measures Max-Age from when the cookie
 * arrived, which is its creation.
 */
const cookieExpiryAt = (cookie: Cookie, now: number): number | undefined => {
    if(typeof cookie.maxAge === "number"){
        const receivedAt = cookie.creation instanceof Date ? cookie.creation.getTime() : now;
        return receivedAt + cookie.maxAge * 1000;
    }
    return cookie.expires instanceof Date ? cookie.expires.getTime() : undefined;
};

const storedFromCookie = (cookie: Cookie, now: number): LambderStoredCookie => {
    const hostOnly = cookie.hostOnly === true;
    const domain = typeof cookie.domain === "string" ? cookie.domain : undefined;
    const expiryAt = cookieExpiryAt(cookie, now);
    return {
        name: cookie.key ?? "",
        value: cookie.value ?? "",
        domain: hostOnly ? undefined : domain,
        // A jar that never learned a host parked this under the stand-in,
        // which is an implementation detail rather than something it knows.
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
export const parseSetCookie = (header: string, now: number, requestPath?: string): LambderStoredCookie | null => {
    const parsed = Cookie.parse(header, { loose: false });
    if(!parsed) return null;
    // Cookie.parse stamps creation with the real clock, but the caller's `now`
    // is the moment this header arrived, and Max-Age is measured from there.
    parsed.creation = new Date(now);
    // Resolve Max-Age against Expires on the caller's clock, the way the jar
    // itself will, so a test moving time forward reads the same expiry here.
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
 * carry. One jar is one browser; two jars are two.
 *
 * The rules themselves are tough-cookie's, which is the reference
 * implementation of RFC 6265 and carries the public suffix list: domain and
 * path matching, default-path, Max-Age against Expires, Secure, HttpOnly, and
 * the __Host-/__Secure- prefixes. That list is the part worth importing rather
 * than writing. A hand-rolled check can tell that `Domain=com` is a registry
 * suffix by counting labels, and cannot tell that `co.uk` is one, so a
 * hand-rolled jar either trusts `Domain=co.uk` or bans every two-label domain.
 *
 * What stays Lambder's is the shape of the questions a transport asks: whole
 * Set-Cookie header lists in (storeSetCookies), `name=value` pairs out
 * (cookiePairs), and a target given as a host and path rather than a URL,
 * since a transport that never speaks HTTP has no URL to give. A field the
 * caller omits is one it could not know, and an unknown field matches
 * anything: a jar pointed at a single host is the ordinary case, and refusing
 * to answer it until it can name that host would make the common setup the
 * awkward one.
 *
 * SameSite is stored but never consulted. It answers "did another site
 * initiate this", and a transport call has no initiating site: every call here
 * is same-site by construction.
 */
export class LambderCookieJar {
    // prefixSecurity "silent" drops a __Host-/__Secure- cookie that breaks its
    // own prefix rules instead of throwing, which is what a browser does.
    private readonly jar = new ToughCookieJar(undefined, { prefixSecurity: "silent", allowSpecialUseDomain: true });
    private readonly now: () => number;
    private readonly host: string | undefined;

    /** `host` is the host this jar is the browser of: the sender of every answer and the target of every request that names none. */
    constructor(options: { now?: () => number; host?: string } = {}){
        this.now = options.now ?? (() => Date.now());
        this.host = options.host === undefined ? undefined : normalizeHost(options.host);
    }

    /** The host a call is about, or the stand-in when neither the call nor the jar names one. */
    private hostFor(given: string | undefined): string {
        return given !== undefined ? normalizeHost(given) : this.host ?? UNNAMED_JAR_HOST;
    }

    /**
     * Applies Set-Cookie header values as a browser would: stores, replaces,
     * and deletes on an expiry in the past. `request` says where the answer
     * came from. Its `host` is the sending host, which every Domain is checked
     * against, and its `path` is the default Path of a cookie that names none.
     *
     * A Domain the sender is not under does not narrow a cookie, it voids it
     * (RFC 6265 section 5.3 step 6), and so does a Domain that is a public
     * suffix. Both are how evil.example.com would otherwise plant a cookie
     * that bank.example.com is handed on the next call.
     */
    storeSetCookies(headers: readonly string[], request: LambderCookieTarget = {}): void {
        // The whole target, `secure` included: a cookie is judged against the
        // channel it actually arrived on. Hardcoding https here accepted
        // Secure cookies from a plain-http answer and then never sent one, so
        // the jar held a session it could not use and said nothing.
        const secure = request.secure !== false;
        const url = urlFor(this.hostFor(request.host), request.path, secure);
        const now = new Date(this.now());
        for(const header of headers){
            // tough-cookie checks the Domain, the prefixes and HttpOnly
            // against the URL, but leaves the Secure attribute to the caller:
            // RFC 6265 lets plain http set one and browsers stopped allowing
            // it. A cookie this jar would refuse to send is one it refuses to
            // keep.
            if(!secure && Cookie.parse(header, { loose: false })?.secure) continue;
            // ignoreError: a cookie a browser would refuse is one this jar
            // refuses, silently, rather than failing the call that carried it.
            this.jar.setCookieSync(header, url, { http: true, now, ignoreError: true });
        }
    }

    /** Every live cookie. */
    list(): LambderStoredCookie[] {
        const now = this.now();
        return (this.jar.serializeSync()?.cookies ?? [])
            .map((serialized: SerializedCookie) => Cookie.fromJSON(serialized))
            .filter((cookie): cookie is Cookie => cookie !== undefined)
            .map((cookie) => storedFromCookie(cookie, now))
            .filter((cookie) => cookie.expires === undefined || cookie.expires > now);
    }

    /**
     * The Cookie header pairs the next request carries, as `name=value`, in
     * the order RFC 6265 section 5.4 puts them in: the longest Path first,
     * and among equal paths the one set first. Servers that read only the
     * first value of a repeated name depend on that order, and so does any
     * test reasoning about which of two same-named cookies wins.
     *
     * Only the cookies whose scope covers the target travel. A field the
     * target leaves out is one the caller could not know, and matches
     * anything: a caller that cannot name its own host still gets the cookies
     * of the one host its jar talks to.
     */
    cookiePairs(target: LambderCookieTarget = {}): string[] {
        return this.matchingCookies(target).map((cookie) => `${cookie.name}=${cookie.value}`);
    }

    /**
     * One cookie's value as a page's script would read it: HttpOnly cookies
     * are invisible unless asked for, which is how the transport fills in the
     * CSRF token the caller would have read from document.cookie.
     */
    get(name: string, options: { includeHttpOnly?: boolean } & LambderCookieTarget = {}): string | undefined {
        return this.matchingCookies(options, options.includeHttpOnly === true)
            .find((cookie) => cookie.name === name)?.value;
    }

    /**
     * The live cookies whose scope reaches this target, in RFC 6265 send
     * order. Delegated to tough-cookie whenever the target names a host,
     * which is the case worth getting exactly right; an unnamed host falls
     * back to every cookie the jar holds, filtered by the rules that do not
     * need one and ordered by the same rule.
     */
    private matchingCookies(target: LambderCookieTarget, includeHttpOnly = true): LambderStoredCookie[] {
        const secure = target.secure !== false;
        if(target.host !== undefined || this.host !== undefined){
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
                    // name actually gets.
                    sort: true,
                })
                .map((cookie) => storedFromCookie(cookie, this.now()))
                // getCookiesSync expires against the real clock; a jar given
                // an injected one is usually a test moving time forward.
                .filter((cookie) => cookie.expires === undefined || cookie.expires > this.now())
                // tough-cookie treats a loopback or localhost target as a
                // secure context and sends Secure cookies to it over http.
                // This jar takes `secure: false` at its word in both
                // directions, so what it stores and what it sends agree.
                .filter((cookie) => secure || !cookie.secure);
        }
        return this.list()
            .filter((cookie) => {
                if(cookie.httpOnly && !includeHttpOnly) return false;
                if(cookie.secure && !secure) return false;
                if(target.path !== undefined && !pathMatch(target.path, cookie.path)) return false;
                return true;
            })
            // The longest path first, as tough-cookie's own comparison does;
            // the sort is stable, so equal paths keep the order they were
            // stored in, which is the order they were created in.
            .sort((a, b) => b.path.length - a.path.length);
    }

    /** Number of live cookies. */
    get size(): number { return this.list().length; }

    /** Forgets every cookie: the browser's storage cleared. */
    clear(): void {
        this.jar.removeAllCookiesSync();
    }
}

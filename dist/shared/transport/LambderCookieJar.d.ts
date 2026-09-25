/**
 * The cookie jar a transport carries (LambderCookieJar), and the Set-Cookie
 * parsing behind it. tough-cookie is reached from this module and no other, so
 * a bundle that never carries a jar drops it.
 */
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
 * One Set-Cookie header value, read the way a browser reads it. `requestPath`
 * is the path the answer came from, which decides the default Path. Returns
 * null for a header no browser would keep.
 */
export declare const parseSetCookie: (header: string, now: number, requestPath?: string) => LambderStoredCookie | null;
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
export declare class LambderCookieJar {
    private readonly jar;
    private readonly now;
    private readonly host;
    /** `host` is the host this jar is the browser of: the sender of every answer and the target of every request that names none. */
    constructor(options?: {
        now?: () => number;
        host?: string;
    });
    /** The host a call is about, or the stand-in when neither the call nor the jar names one. */
    private hostFor;
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
    storeSetCookies(headers: readonly string[], request?: LambderCookieTarget): void;
    /** Every live cookie. */
    list(): LambderStoredCookie[];
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
    cookiePairs(target?: LambderCookieTarget): string[];
    /**
     * One cookie's value as a page's script would read it: HttpOnly cookies
     * are invisible unless asked for, which is how the transport fills in the
     * CSRF token the caller would have read from document.cookie.
     */
    get(name: string, options?: {
        includeHttpOnly?: boolean;
    } & LambderCookieTarget): string | undefined;
    /**
     * The live cookies whose scope reaches this target, in RFC 6265 send
     * order. Delegated to tough-cookie whenever a host is known, the case
     * worth getting exactly right; with no host, every cookie the jar holds
     * is filtered by the rules that need none and ordered the same way.
     */
    private matchingCookies;
    /** Number of live cookies. */
    get size(): number;
    /** Forgets every cookie: the browser's storage cleared. */
    clear(): void;
}
export {};

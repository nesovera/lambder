/**
 * A cookie's Domain attribute: a fixed value such as ".example.com", or a
 * function of the request hostname for one deployment serving several apex
 * domains. Return undefined (or null) for a host-only cookie.
 */
export type LambderCookieDomain = string | ((hostname: string) => string | undefined | null);
/**
 * Attributes of a Set-Cookie header. A cookie's identity in the browser is
 * (name, domain, path): a write under a different domain or path creates a
 * second cookie beside the first instead of replacing it, and a deletion
 * only reaches the cookie whose domain and path it names.
 */
export type LambderCookieOptions = {
    domain?: LambderCookieDomain;
    /** Default "/". */
    path?: string;
    /** Default "Lax". */
    sameSite?: "Strict" | "Lax" | "None";
    /** Default true. */
    secure?: boolean;
    /** Default false. */
    httpOnly?: boolean;
    /** Lifetime in seconds (Max-Age). A cookie with neither maxAge nor expires lasts the browser session. */
    maxAge?: number;
    /** Absolute expiry (Expires). */
    expires?: Date;
    /** Value encoder. Default encodeURIComponent, which ctx.cookie reverses on the way back in. */
    encode?: (value: string) => string;
};
/** Options of a deleting Set-Cookie: only the scope matters. */
export type LambderClearCookieOptions = Omit<LambderCookieOptions, "maxAge" | "expires" | "encode">;
/** The Domain attribute for this request, or undefined for a host-only cookie. */
export declare const resolveCookieDomain: (domain: LambderCookieDomain | undefined, host?: string) => string | undefined;
/**
 * One Set-Cookie header value. `host` resolves a function-form domain; a
 * string domain needs none.
 */
export declare const serializeCookie: (name: string, value: string, options?: LambderCookieOptions, host?: string) => string;
/**
 * A Set-Cookie header value that deletes the cookie. Domain and path must
 * match the cookie being deleted: a mismatch targets a different cookie and
 * deletes nothing.
 */
export declare const serializeClearCookie: (name: string, options?: LambderClearCookieOptions, host?: string) => string;

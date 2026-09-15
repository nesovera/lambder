import cookieParser from "cookie";

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
export const resolveCookieDomain = (domain: LambderCookieDomain | undefined, host = ""): string | undefined => {
    // Host header can carry a port; browsers match the Domain attribute on hostname only.
    const hostname = host.split(":")[0] ?? "";
    const resolved = typeof domain === "function" ? domain(hostname) : domain;
    return resolved || undefined;
};

/**
 * One Set-Cookie header value. `host` resolves a function-form domain; a
 * string domain needs none.
 */
export const serializeCookie = (name: string, value: string, options: LambderCookieOptions = {}, host?: string): string =>
    cookieParser.serialize(name, value, {
        domain: resolveCookieDomain(options.domain, host),
        path: options.path ?? "/",
        sameSite: (options.sameSite ?? "Lax").toLowerCase() as "strict" | "lax" | "none",
        secure: options.secure ?? true,
        httpOnly: options.httpOnly ?? false,
        maxAge: options.maxAge,
        expires: options.expires,
        encode: options.encode,
    });

/**
 * A Set-Cookie header value that deletes the cookie. Domain and path must
 * match the cookie being deleted: a mismatch targets a different cookie and
 * deletes nothing.
 */
export const serializeClearCookie = (name: string, options: LambderClearCookieOptions = {}, host?: string): string =>
    serializeCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) }, host);

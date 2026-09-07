import cookieParser from "cookie";
/** The Domain attribute for this request, or undefined for a host-only cookie. */
export const resolveCookieDomain = (domain, host = "") => {
    // Host header can carry a port; browsers match the Domain attribute on hostname only.
    const hostname = host.split(":")[0] ?? "";
    const resolved = typeof domain === "function" ? domain(hostname) : domain;
    return resolved || undefined;
};
/**
 * One Set-Cookie header value. `host` resolves a function-form domain; a
 * string domain needs none.
 */
export const serializeCookie = (name, value, options = {}, host) => cookieParser.serialize(name, value, {
    domain: resolveCookieDomain(options.domain, host),
    path: options.path ?? "/",
    sameSite: (options.sameSite ?? "Lax").toLowerCase(),
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
export const serializeClearCookie = (name, options = {}, host) => serializeCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) }, host);

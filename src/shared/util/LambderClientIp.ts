/**
 * The client address as one textual form, and the rule for which header may
 * name it. Shared by every adapter that builds a request (the Lambda server,
 * the mock's invoke transport), so a `per: "ip"` rate limit keys the same
 * address the same way whichever runtime served the call.
 */

/**
 * The loopback address an in-process caller is given when nothing names a
 * client: the handler transport and the mock runtime both default to it, so
 * a per-IP rate limit exercised in a test keys the same way on both.
 */
export const LOOPBACK_CLIENT_IP = "127.0.0.1";

/** Longest textual IPv6 address (39) plus a scope id; beyond this the value is not an address. */
const MAX_CLIENT_IP_LENGTH = 45;

/**
 * One textual form per address, so a rate-limit counter cannot be split.
 * A forwarding proxy may write the RFC 7239 bracket-and-port form
 * ([2001:db8::1]:443) or a plain host:port, and IPv6 has many spellings for
 * one address; each variant would otherwise be its own counter, which is a
 * limit that does not limit. Anything longer than the longest valid address
 * is truncated rather than trusted as a key.
 */
export const normalizeClientIp = (value: string): string => {
    let ip = value.trim();
    if(ip.startsWith("[")){
        // [v6] or [v6]:port
        const close = ip.indexOf("]");
        if(close > 0) ip = ip.slice(1, close);
    }else if(ip.split(":").length === 2){
        // host:port, which only an IPv4 address or a hostname can be: a bare
        // IPv6 address always carries more than one colon.
        ip = ip.slice(0, ip.indexOf(":"));
    }
    return ip.toLowerCase().slice(0, MAX_CLIENT_IP_LENGTH);
};

/**
 * The first trusted header that carries anything, leftmost entry, else the
 * address the gateway observed. Nothing is trusted by default, and there is
 * no exception for an invoke: the marker header that would have signalled
 * one is an ordinary request header that any HTTP caller can set, so
 * honouring it would hand every caller the value again. A genuine invoke
 * needs no exception, because the synthesized event carries the end user's
 * address in requestContext.http.sourceIp, which is where `sourceIp` comes
 * from anyway.
 */
export const resolveClientIp = (
    lowercasedHeaders: Record<string, string>,
    sourceIp: string,
    trustedClientIpHeaders: readonly string[] = [],
): string => {
    for(const name of trustedClientIpHeaders){
        const value = lowercasedHeaders[name.toLowerCase()];
        const first = value ? (value.split(",")[0] ?? "").trim() : "";
        if(first) return normalizeClientIp(first);
    }
    return normalizeClientIp(sourceIp) || "";
};

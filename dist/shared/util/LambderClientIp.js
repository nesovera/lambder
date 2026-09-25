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
/** A dotted IPv4 address as its four octets, or null when the text is not one. */
const parseIpv4 = (value) => {
    const parts = value.split(".");
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part)))
        return null;
    const octets = parts.map(Number);
    return octets.every((octet) => octet <= 255) ? octets : null;
};
/**
 * An IPv6 address as its eight 16-bit groups, or null when the text is not
 * one: every spelling of one address (compressed or not, any case, with an
 * embedded IPv4 tail) parses to the same groups.
 */
const parseIpv6 = (value) => {
    // A zone id names the interface an address was reached on, not the address.
    let text = value.split("%")[0];
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1)
        return null;
    const tail = text.slice(lastColon + 1);
    if (tail.includes(".")) {
        const octets = parseIpv4(tail);
        if (!octets)
            return null;
        text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2)
        return null;
    const groupsOf = (part) => {
        if (part === "")
            return [];
        const groups = part.split(":");
        return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) ? groups.map((group) => parseInt(group, 16)) : null;
    };
    const head = groupsOf(halves[0]);
    const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
    if (!head || !rest)
        return null;
    if (halves.length === 1)
        return head.length === 8 ? head : null;
    const missing = 8 - head.length - rest.length;
    return missing >= 1 ? [...head, ...new Array(missing).fill(0), ...rest] : null;
};
/**
 * One textual form per address, so a rate-limit counter cannot be split.
 * A forwarding proxy may write the RFC 7239 bracket-and-port form
 * ([2001:db8::1]:443) or a plain host:port; each variant would otherwise be
 * its own counter, which is a limit that does not limit. An unbracketed IPv6
 * address with a port after it cannot be told apart by its text
 * (`2001:db8::1:443` is an address too), so this leaves it alone; the header
 * that writes that form has its port taken off by resolveClientIp, which
 * knows where the value came from. Anything longer than the longest valid
 * address is truncated rather than trusted as a key.
 */
export const normalizeClientIp = (value) => {
    let ip = value.trim();
    if (ip.startsWith("[")) {
        // [v6] or [v6]:port
        const close = ip.indexOf("]");
        if (close > 0)
            ip = ip.slice(1, close);
    }
    else if (ip.split(":").length === 2) {
        // host:port, which only an IPv4 address or a hostname can be: a bare
        // IPv6 address always carries more than one colon.
        ip = ip.slice(0, ip.indexOf(":"));
    }
    return ip.toLowerCase().slice(0, MAX_CLIENT_IP_LENGTH);
};
/**
 * Headers whose value always ends in `:port`, whatever the address before
 * it: CloudFront-Viewer-Address writes `192.0.2.1:443` and
 * `2001:db8::1:443` alike, with no brackets. The last colon-separated
 * segment of such a value is the port by definition. Read from the text
 * instead, a compressed IPv6 address with its port on still parses, the port
 * becomes its last group, and the /64 a per-IP limit counts moves with the
 * interface id the caller picks.
 */
const PORT_SUFFIXED_IP_HEADERS = new Set(["cloudfront-viewer-address"]);
/** The IPv6 prefix a per-IP rate limit counts by default: the /64 every subscriber holds at least. */
export const DEFAULT_IPV6_RATE_LIMIT_PREFIX = 64;
/**
 * The caller a per-IP rate limit counts, which is not always the address
 * itself. An IPv4 address is one subscriber. An IPv6 subscriber, a VPS
 * included, holds at least a /64 and may pick any interface id inside it, so
 * one counter per full address is a fresh counter per request for anyone
 * who rotates: the prefix is what is counted (`2001:db8:1:2:0:0:0:0/64`). An
 * IPv4-mapped IPv6 address (::ffff:192.0.2.1) is its IPv4 address, so the
 * two spellings share a counter. A value that is not an address is counted
 * as it is. ctx.ip itself stays the exact address, for logs.
 */
export const rateLimitSubjectOf = (ip, ipv6PrefixLength = DEFAULT_IPV6_RATE_LIMIT_PREFIX) => {
    const groups = parseIpv6(ip);
    if (!groups)
        return ip;
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
        return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    }
    const masked = groups.map((group, index) => {
        const kept = Math.max(0, Math.min(16, ipv6PrefixLength - index * 16));
        return kept === 0 ? 0 : group & ((0xffff << (16 - kept)) & 0xffff);
    });
    return `${masked.map((group) => group.toString(16)).join(":")}/${ipv6PrefixLength}`;
};
/**
 * The first trusted header that carries anything, leftmost entry, else the
 * address the gateway observed; a header that always appends the port (see
 * PORT_SUFFIXED_IP_HEADERS) has it taken off. Nothing is trusted by default,
 * and there is no exception for an invoke: the invoke marker is an ordinary
 * request header any HTTP caller can set, so honouring it would let every
 * caller choose its own address. A genuine invoke needs no exception,
 * because the synthesized event carries the end user's address in
 * requestContext.http.sourceIp, which is where `sourceIp` comes from anyway.
 */
export const resolveClientIp = (lowercasedHeaders, sourceIp, trustedClientIpHeaders = []) => {
    for (const name of trustedClientIpHeaders) {
        const header = name.toLowerCase();
        const value = lowercasedHeaders[header];
        const first = value ? (value.split(",")[0] ?? "").trim() : "";
        if (first)
            return normalizeClientIp(PORT_SUFFIXED_IP_HEADERS.has(header) ? first.replace(/:\d+$/, "") : first);
    }
    return normalizeClientIp(sourceIp) || "";
};

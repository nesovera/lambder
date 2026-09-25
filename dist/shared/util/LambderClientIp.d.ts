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
export declare const LOOPBACK_CLIENT_IP = "127.0.0.1";
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
export declare const normalizeClientIp: (value: string) => string;
/** The IPv6 prefix a per-IP rate limit counts by default: the /64 every subscriber holds at least. */
export declare const DEFAULT_IPV6_RATE_LIMIT_PREFIX = 64;
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
export declare const rateLimitSubjectOf: (ip: string, ipv6PrefixLength?: number) => string;
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
export declare const resolveClientIp: (lowercasedHeaders: Record<string, string>, sourceIp: string, trustedClientIpHeaders?: readonly string[]) => string;

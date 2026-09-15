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
 * ([2001:db8::1]:443) or a plain host:port, and IPv6 has many spellings for
 * one address; each variant would otherwise be its own counter, which is a
 * limit that does not limit. Anything longer than the longest valid address
 * is truncated rather than trusted as a key.
 */
export declare const normalizeClientIp: (value: string) => string;
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
export declare const resolveClientIp: (lowercasedHeaders: Record<string, string>, sourceIp: string, trustedClientIpHeaders?: readonly string[]) => string;

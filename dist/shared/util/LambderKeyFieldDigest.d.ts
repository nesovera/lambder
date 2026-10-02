/**
 * The digest a caller-controlled field of a store key is written as.
 *
 * The rate-limit engine and the idempotency engine each build a store key
 * around fields only the caller controls: an address, a session key, whatever
 * a custom rate-limit key returned, a callerIdentity, a posted idempotency
 * key. Written as they are, a table read shows who called (an email, a device
 * token, an address), and a long one passes a store's own key limit, which
 * the store answers by throwing and both engines' failOpen turns into no
 * limit or no idempotency for that caller. So every such field is written as
 * a digest of a fixed length, whatever its own, in one implementation the two
 * engines share: `<kind>:<64 hex>`, with the kind (ip, session, custom, ...)
 * left readable, as the API and policy names around it are.
 *
 * Keyed when the app has an at-rest secret (the session salt): an HMAC under
 * a subkey derived from it for this one purpose, so a table read alone cannot
 * test a guess. Derived through HKDF rather than used as it is because the
 * session store keys its partition hash with the salt itself, and that hash
 * rides in every session cookie: a sessionKey a user can choose would
 * otherwise let them read off a cookie the digest of any value they like.
 * Without a secret the digest is a plain SHA-256, which keeps the values out
 * of the table but lets a reader test guesses: an email from a list, an IPv4
 * address from all four billion.
 */
export declare class LambderKeyFieldDigest {
    /** Whether the digest is keyed by the app's at-rest secret, or a plain SHA-256. */
    readonly isKeyed: boolean;
    private readonly atRestSecret;
    private hmacKeyPromise;
    constructor(atRestSecret: string | null);
    /**
     * `value` written as a field of `kind`: `<kind>:<hex>`. The kind is part
     * of what is digested, so one value under two kinds (a session key
     * counted by a rate limit and scoping an idempotency record) gives two
     * unrelated digests, and a table read cannot join the two.
     *
     * A runtime without WebCrypto (the mock on a page served over plain http,
     * a phone on the LAN) writes `<kind>:<value>` instead: the only stores
     * such a runtime runs over are the mock's memory ones, which nobody reads
     * at rest and which have no key limit, and a key there is only ever
     * compared with keys the same runtime wrote.
     */
    digestOf(kind: string, value: string): Promise<string>;
    /** The HMAC key, derived once per instance: HKDF-SHA256 over the secret, with no salt and this purpose as its info. */
    private hmacKey;
}

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
import { joinKeyFields } from "./joinKeyFields.js";
import { bytesToHexString, resolveWebCrypto } from "./LambderTextDigest.js";
/** HKDF's `info`: the purpose the subkey is derived for, so no other derivation from the same secret meets it. */
const KEY_FIELD_DIGEST_PURPOSE = "lambder/key-field-digest";
export class LambderKeyFieldDigest {
    /** Whether the digest is keyed by the app's at-rest secret, or a plain SHA-256. */
    isKeyed;
    atRestSecret;
    hmacKeyPromise;
    constructor(atRestSecret) {
        if (atRestSecret !== null && (typeof atRestSecret !== "string" || atRestSecret === "")) {
            throw new Error("Lambder: the at-rest secret that keys the digest of rate-limit and idempotency keys is empty. Pass the app's real secret (the session salt), or none.");
        }
        this.atRestSecret = atRestSecret;
        this.isKeyed = atRestSecret !== null;
    }
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
    async digestOf(kind, value) {
        let webCrypto;
        try {
            webCrypto = await resolveWebCrypto();
        }
        catch {
            return `${kind}:${value}`;
        }
        const message = new TextEncoder().encode(joinKeyFields(kind, value));
        const digest = this.atRestSecret === null
            ? await webCrypto.subtle.digest("SHA-256", message)
            : await webCrypto.subtle.sign("HMAC", await this.hmacKey(webCrypto, this.atRestSecret), message);
        return `${kind}:${bytesToHexString(new Uint8Array(digest))}`;
    }
    /** The HMAC key, derived once per instance: HKDF-SHA256 over the secret, with no salt and this purpose as its info. */
    hmacKey(webCrypto, atRestSecret) {
        this.hmacKeyPromise ??= (async () => {
            const secretKey = await webCrypto.subtle.importKey("raw", new TextEncoder().encode(atRestSecret), "HKDF", false, ["deriveKey"]);
            return await webCrypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(KEY_FIELD_DIGEST_PURPOSE) }, secretKey, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
        })();
        return this.hmacKeyPromise;
    }
}

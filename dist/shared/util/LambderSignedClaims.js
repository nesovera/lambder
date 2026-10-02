import { base64UrlToBytes, bytesToBase64Url, isBase64Url } from "./LambderBase64.js";
import { hmacSha256Of, importHmacKey, resolveWebCrypto } from "./LambderTextDigest.js";
import { assertPositiveInteger } from "./LambderOptionChecks.js";
/**
 * One kind of signed token: constructed once with its secret, version and
 * claims schema, it keeps the imported HMAC key and answers `sign` and
 * `verify`. An app declares one instance per kind of token it hands out.
 *
 * The one claim with a meaning here is `exp`, an expiry in epoch seconds,
 * the unit sessions, DynamoDB's TTL and JWTs use. A schema that declares it
 * gets it checked on every verify; a schema without it declares a token that
 * does not expire on its own, which is right where the thing the token names
 * (a request, a message) decides what it may still do.
 *
 * `verify` answers null for every failure alike: a forged signature, another
 * version, malformed text, claims the schema refuses, an `exp` in the past.
 * A caller cannot tell them apart, and so cannot tell a client apart either.
 */
export class LambderSignedClaims {
    secret;
    version;
    schema;
    now;
    /** Imported on first use and kept: signing and verifying share one key object for the life of the instance. */
    keyPromise;
    constructor(options) {
        if (typeof options.secret !== "string" || options.secret.length === 0) {
            throw new Error("Lambder: LambderSignedClaims needs a secret to sign with.");
        }
        if (typeof options.version !== "string" || options.version.length === 0 || options.version.includes(".")) {
            throw new Error(`Lambder: LambderSignedClaims version must be text without a dot, got ${JSON.stringify(options.version)}: it is the first of the token's three dot-separated segments.`);
        }
        this.secret = options.secret;
        this.version = options.version;
        this.schema = options.schema;
        this.now = options.now ?? (() => Date.now());
    }
    /** The token for these claims, which the schema parses first. `exp`, when the schema has it, is epoch seconds. */
    async sign(claims) {
        const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(this.schema.parse(claims))));
        const message = `${this.version}.${body}`;
        const webCrypto = await resolveWebCrypto();
        const mac = await webCrypto.subtle.sign("HMAC", await this.key(webCrypto), new TextEncoder().encode(message));
        return `${message}.${bytesToBase64Url(new Uint8Array(mac))}`;
    }
    /**
     * The claims, when the token is this version, signed under this secret,
     * well formed, accepted by the schema and not past its `exp`; null
     * otherwise, for every reason alike. `now`, in epoch milliseconds, is the
     * moment `exp` is judged against for this call; default: the clock's.
     */
    async verify(token, options = {}) {
        const parts = token.split(".");
        if (parts.length !== 3 || parts[0] !== this.version)
            return null;
        const [, body, mac] = parts;
        if (!isBase64Url(body) || !isBase64Url(mac))
            return null;
        // The last character of a MAC carries bits decoding ignores, so four
        // spellings decode to the same bytes. Only the one sign() writes is a
        // token: an app that keys anything on the token string (a list of
        // spent tokens, a rate limit) must not meet the same token again
        // under another spelling.
        const macBytes = base64UrlToBytes(mac);
        if (bytesToBase64Url(macBytes) !== mac)
            return null;
        const webCrypto = await resolveWebCrypto();
        const valid = await webCrypto.subtle.verify("HMAC", await this.key(webCrypto), macBytes, new TextEncoder().encode(`${this.version}.${body}`));
        if (!valid)
            return null;
        let claims;
        try {
            claims = this.schema.parse(JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))));
        }
        catch {
            return null;
        }
        const exp = claims.exp;
        if (typeof exp === "number" && exp * 1000 <= (options.now ?? this.now()))
            return null;
        return claims;
    }
    key(webCrypto) {
        this.keyPromise ??= importHmacKey(webCrypto, this.secret, ["sign", "verify"]);
        return this.keyPromise;
    }
}
/**
 * The keyed digest of a secret an app stores and later looks up or compares
 * by value: a device's secret, a code sent by email, a pairing code. Keyed
 * under the app's secret rather than a plain hash, so a copied table alone
 * cannot be attacked offline, and deterministic, so a lookup is one indexed
 * read. HMAC-SHA256 as 43 characters of base64url; compare two with
 * constantTimeEquals.
 */
export const keyedDigest = async (secret, value) => bytesToBase64Url(await hmacSha256Of(secret, value));
/**
 * A fresh secret from the runtime's cryptographic random source, as base64url
 * (43 characters for the default 32 bytes): the credential a paired device
 * keeps, the token in a link that must not be guessable. Synchronous, since
 * getRandomValues is, on every runtime with a WebCrypto global; a runtime
 * without one is told so.
 */
export const randomSecret = (bytes = 32) => {
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.getRandomValues !== "function") {
        throw new Error("Lambder needs crypto.getRandomValues in this runtime to mint a secret. Every browser provides it; Node 20+ provides it as globalThis.crypto.");
    }
    return bytesToBase64Url(webCrypto.getRandomValues(new Uint8Array(bytes)));
};
/** The most bytes one getRandomValues call fills. */
const MAX_RANDOM_BYTES_PER_CALL = 65536;
/**
 * The characters of an alphabet a code is drawn from, as code points, once
 * they are 2 to 256 distinct ones; anything else throws, naming `name`. One
 * character draws nothing random, a repeat weighs its character double, and
 * past 256 the one byte randomCode draws per character cannot reach every
 * character. Returns the characters so the check reads as an assignment.
 */
export const assertCodeAlphabet = (alphabet, name) => {
    const characters = typeof alphabet === "string" ? Array.from(alphabet) : [];
    const distinct = new Set(characters).size;
    if (characters.length < 2 || characters.length > 256 || distinct !== characters.length) {
        const found = typeof alphabet === "string" ? `${characters.length} characters, ${distinct} of them distinct` : typeof alphabet;
        throw new Error(`Lambder: ${name} must be 2 to 256 distinct characters, got ${found}.`);
    }
    return characters;
};
/**
 * A code of `length` characters drawn uniformly from `alphabet` with the
 * runtime's cryptographic random source: the digits emailed to an address,
 * the letters of a pairing code somebody types. One byte draws one
 * character, and a byte at or above the largest multiple of the alphabet's
 * size is discarded and drawn again, since `byte % alphabet.length` alone
 * favours the alphabet's first characters. The alphabet is 2 to 256 distinct
 * characters (code points) and `length` a positive integer; anything else
 * throws. Synchronous, as randomSecret is.
 */
export const randomCode = (alphabet, length) => {
    const characters = assertCodeAlphabet(alphabet, "randomCode alphabet");
    assertPositiveInteger(length, "randomCode length");
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.getRandomValues !== "function") {
        throw new Error("Lambder needs crypto.getRandomValues in this runtime to draw a code. Every browser provides it; Node 20+ provides it as globalThis.crypto.");
    }
    const ceiling = Math.floor(256 / characters.length) * characters.length;
    const drawn = [];
    // Twice the length lets one call cover the discarded bytes nearly
    // always; an alphabet that discards close to half of them may need
    // another, which the loop draws.
    const buffer = new Uint8Array(Math.min(length * 2, MAX_RANDOM_BYTES_PER_CALL));
    while (drawn.length < length) {
        webCrypto.getRandomValues(buffer);
        for (const byte of buffer) {
            if (byte >= ceiling)
                continue;
            drawn.push(characters[byte % characters.length]);
            if (drawn.length === length)
                break;
        }
    }
    return drawn.join("");
};

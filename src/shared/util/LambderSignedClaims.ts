import type { z } from "zod";
import { base64UrlToBytes, bytesToBase64Url, isBase64Url } from "./LambderBase64.js";
import { hmacSha256Of, importHmacKey, resolveWebCrypto } from "./LambderTextDigest.js";

/*
 * Signed claims: a bearer token that is its own record.
 *
 * Much of what a server hands out to be presented later needs no row: the
 * link in an email that names one recipient, the token a paired device shows
 * on every call, the grant a checkout page comes back with, the ticket a
 * realtime edge verifies before it opens a socket. Each is a few claims the
 * server wants back unchanged, and a signature is what makes "unchanged"
 * true. Nothing is stored, so nothing is worth stealing, and the same token
 * can be written into a reminder days later.
 *
 * The token is `<version>.<claims>.<mac>`: the version tells one kind of
 * token from another so a device token can never pass as a room ticket, the
 * claims are the JSON of what the schema accepted, base64url, and the mac is
 * HMAC-SHA256 over the first two under the app's secret. WebCrypto only, so
 * the same class signs in a Lambda and verifies in a browser-less edge
 * runtime. The secret is the server's: it never reaches a browser, as the
 * session salt never does.
 */

export type LambderSignedClaimsOptions<TClaims> = {
    /** The HMAC key. Server side, and every runtime that verifies; never a browser. */
    secret: string;
    /**
     * Names this kind of token, as the first segment of every one it signs;
     * a token of another version does not verify. Any text without a dot.
     */
    version: string;
    /** The claims' shape, parsed on the way out and on the way back, so a token never carries a shape the app did not declare. */
    schema: z.ZodType<TClaims>;
    /** The clock `exp` is judged against, in epoch milliseconds. Default: Date.now. */
    now?: () => number;
};

/**
 * Refuses a claims type whose `exp` is not a number, at the constructor: the
 * class would judge it as an expiry, find no number, and let the token live
 * for ever. The property name is the message.
 */
type LambderExpIsSeconds<TClaims> =
    TClaims extends { exp: infer E }
        ? ([E] extends [number] ? unknown : { readonly "lambder: the exp claim is an expiry in epoch seconds, so the schema must declare it as a number.": never })
        : unknown;

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
export class LambderSignedClaims<TClaims extends object> {
    private readonly secret: string;
    private readonly version: string;
    private readonly schema: z.ZodType<TClaims>;
    private readonly now: () => number;
    /** Imported on first use and kept: signing and verifying share one key object for the life of the instance. */
    private keyPromise: Promise<CryptoKey> | undefined;

    constructor(options: LambderSignedClaimsOptions<TClaims> & LambderExpIsSeconds<TClaims>){
        if(typeof options.secret !== "string" || options.secret.length === 0){
            throw new Error("Lambder: LambderSignedClaims needs a secret to sign with.");
        }
        if(typeof options.version !== "string" || options.version.length === 0 || options.version.includes(".")){
            throw new Error(`Lambder: LambderSignedClaims version must be text without a dot, got ${JSON.stringify(options.version)}: it is the first of the token's three dot-separated segments.`);
        }
        this.secret = options.secret;
        this.version = options.version;
        this.schema = options.schema;
        this.now = options.now ?? (() => Date.now());
    }

    /** The token for these claims, which the schema parses first. `exp`, when the schema has it, is epoch seconds. */
    async sign(claims: TClaims): Promise<string> {
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
    async verify(token: string, options: { now?: number } = {}): Promise<TClaims | null> {
        const parts = token.split(".");
        if(parts.length !== 3 || parts[0] !== this.version) return null;
        const [, body, mac] = parts as [string, string, string];
        if(!isBase64Url(body) || !isBase64Url(mac)) return null;
        // The last character of a MAC carries bits decoding ignores, so four
        // spellings decode to the same bytes. Only the one sign() writes is a
        // token: an app that keys anything on the token string (a list of
        // spent tokens, a rate limit) must not meet the same token again
        // under another spelling.
        const macBytes = base64UrlToBytes(mac);
        if(bytesToBase64Url(macBytes) !== mac) return null;
        const webCrypto = await resolveWebCrypto();
        const valid = await webCrypto.subtle.verify(
            "HMAC",
            await this.key(webCrypto),
            macBytes as Uint8Array<ArrayBuffer>,
            new TextEncoder().encode(`${this.version}.${body}`),
        );
        if(!valid) return null;
        let claims: TClaims;
        try {
            claims = this.schema.parse(JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))));
        } catch {
            return null;
        }
        const exp = (claims as { exp?: unknown }).exp;
        if(typeof exp === "number" && exp * 1000 <= (options.now ?? this.now())) return null;
        return claims;
    }

    private key(webCrypto: Crypto): Promise<CryptoKey> {
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
export const keyedDigest = async (secret: string, value: string): Promise<string> =>
    bytesToBase64Url(await hmacSha256Of(secret, value));

/**
 * A fresh secret from the runtime's cryptographic random source, as base64url
 * (43 characters for the default 32 bytes): the credential a paired device
 * keeps, the token in a link that must not be guessable. Synchronous, since
 * getRandomValues is, on every runtime with a WebCrypto global; a runtime
 * without one is told so.
 */
export const randomSecret = (bytes = 32): string => {
    const webCrypto = globalThis.crypto;
    if(typeof webCrypto?.getRandomValues !== "function"){
        throw new Error("Lambder needs crypto.getRandomValues in this runtime to mint a secret. Every browser provides it; Node 20+ provides it as globalThis.crypto.");
    }
    return bytesToBase64Url(webCrypto.getRandomValues(new Uint8Array(bytes)));
};

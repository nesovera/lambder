import type { z } from "zod";
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
type LambderExpIsSeconds<TClaims> = TClaims extends {
    exp: infer E;
} ? ([E] extends [number] ? unknown : {
    readonly "lambder: the exp claim is an expiry in epoch seconds, so the schema must declare it as a number.": never;
}) : unknown;
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
export declare class LambderSignedClaims<TClaims extends object> {
    private readonly secret;
    private readonly version;
    private readonly schema;
    private readonly now;
    /** Imported on first use and kept: signing and verifying share one key object for the life of the instance. */
    private keyPromise;
    constructor(options: LambderSignedClaimsOptions<TClaims> & LambderExpIsSeconds<TClaims>);
    /** The token for these claims, which the schema parses first. `exp`, when the schema has it, is epoch seconds. */
    sign(claims: TClaims): Promise<string>;
    /**
     * The claims, when the token is this version, signed under this secret,
     * well formed, accepted by the schema and not past its `exp`; null
     * otherwise, for every reason alike. `now`, in epoch milliseconds, is the
     * moment `exp` is judged against for this call; default: the clock's.
     */
    verify(token: string, options?: {
        now?: number;
    }): Promise<TClaims | null>;
    private key;
}
/**
 * The keyed digest of a secret an app stores and later looks up or compares
 * by value: a device's secret, a code sent by email, a pairing code. Keyed
 * under the app's secret rather than a plain hash, so a copied table alone
 * cannot be attacked offline, and deterministic, so a lookup is one indexed
 * read. HMAC-SHA256 as 43 characters of base64url; compare two with
 * constantTimeEquals.
 */
export declare const keyedDigest: (secret: string, value: string) => Promise<string>;
/**
 * A fresh secret from the runtime's cryptographic random source, as base64url
 * (43 characters for the default 32 bytes): the credential a paired device
 * keeps, the token in a link that must not be guessable. Synchronous, since
 * getRandomValues is, on every runtime with a WebCrypto global; a runtime
 * without one is told so.
 */
export declare const randomSecret: (bytes?: number) => string;
export {};

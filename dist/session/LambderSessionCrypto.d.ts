/**
 * The cryptography the session model runs on, behind an interface so the
 * manager itself has no Node dependency: the bearer secrets are hashed at
 * rest, compared in constant time, and minted from a cryptographic random
 * source, and the sessionKey is hashed under the salt as its key.
 *
 * LambderWebCrypto is the default and runs on Node 20+, every browser on a
 * secure context, and edge runtimes. LambderPlainSessionCrypto is the
 * stand-in the mock runtime picks on its own where crypto.subtle is missing
 * (a plain-http page during device testing on a LAN): its memory store is
 * not a table anybody can leak, so hashing there protects nothing.
 */
/**
 * Hashing, randomness and constant-time comparison, as the session manager
 * asks for them. Implement it to run sessions on a runtime's own primitives.
 */
export interface LambderSessionCrypto {
    /**
     * Whether this really hashes and really draws random bytes. The session
     * manager refuses a non-cryptographic implementation over a store that
     * outlives the process, because such a store would then hold usable
     * credentials rather than hashes of them.
     */
    readonly isCryptographic: boolean;
    sha256Hex(value: string): Promise<string>;
    /** HMAC-SHA256 of `value` under `key` (both UTF-8), as hex: the salted partition hash of a sessionKey. */
    hmacSha256Hex(key: string, value: string): Promise<string>;
    randomHex(bytes: number): Promise<string>;
    constantTimeEqual(a: string, b: string): boolean;
}
/** True when this runtime offers WebCrypto's subtle API (secure contexts in browsers; Node 20+). */
export declare const isWebCryptoAvailable: () => boolean;
/** sha256 and HMAC through crypto.subtle and randomness through getRandomValues: the default. */
export declare class LambderWebCrypto implements LambderSessionCrypto {
    readonly isCryptographic = true;
    private cryptoPromise;
    /**
     * Node's crypto where the runtime has it, kept for timingSafeEqual.
     * Warmed by ready(), because the comparison itself is synchronous and a
     * session is always hashed before anything is compared against it.
     */
    private nodeCrypto;
    /**
     * The runtime's WebCrypto, through the resolver every layer shares, with
     * Node's crypto warmed alongside it.
     *
     * Availability is checked here, before the shared resolver, so the error
     * can name this layer's own way out: a runtime with neither a global
     * crypto nor Node's webcrypto can still run sessions over
     * LambderPlainSessionCrypto and a memory store, which the shared
     * resolver's message cannot know about.
     */
    private ready;
    sha256Hex(value: string): Promise<string>;
    hmacSha256Hex(key: string, value: string): Promise<string>;
    randomHex(bytes: number): Promise<string>;
    constantTimeEqual(a: string, b: string): boolean;
}
/**
 * No hashing and no cryptographic randomness: values are hex-encoded as
 * they are and secrets come from Math.random. Only for an in-memory store
 * in a runtime without WebCrypto; never for anything at rest.
 */
export declare class LambderPlainSessionCrypto implements LambderSessionCrypto {
    readonly isCryptographic = false;
    sha256Hex(value: string): Promise<string>;
    /**
     * The key and the value hex-encoded as a JSON pair rather than run
     * together, so the pair stays unambiguous the way a keyed hash keeps it:
     * no key and value can pass for another split of the same text.
     */
    hmacSha256Hex(key: string, value: string): Promise<string>;
    randomHex(bytes: number): Promise<string>;
    constantTimeEqual(a: string, b: string): boolean;
}

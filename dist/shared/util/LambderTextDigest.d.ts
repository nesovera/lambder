/**
 * SHA-256 and HMAC-SHA256 through WebCrypto: the digests every layer shares.
 * The session crypto hashes bearer secrets with the first and partitions
 * session keys with the second, the policy engines digest the caller's
 * fields of their store keys, signed claims and keyed digests are HMACs
 * under an app's secret, so every key space is built from the same
 * primitives on every runtime (browsers on a secure context, Node 20+, edge
 * runtimes); an upload's checksum is the same digest over the file's bytes.
 */
/** Lowercase hex of a byte array, two characters per byte. */
export declare const bytesToHexString: (bytes: Uint8Array) => string;
/**
 * globalThis.crypto where the runtime has it, else Node's webcrypto (a Node
 * without the global). Resolved once per process; a runtime with neither
 * throws, naming what is missing.
 */
export declare const resolveWebCrypto: () => Promise<Crypto>;
/** The SHA-256 digest of `text` (UTF-8), as 64 lowercase hex characters. */
export declare const sha256HexOf: (text: string) => Promise<string>;
/** The SHA-256 digest of `bytes`, as base64: the form object storage checks an upload's checksum in. */
export declare const sha256Base64Of: (bytes: Uint8Array) => Promise<string>;
/** An HMAC-SHA256 key over `secret` (UTF-8), for `usages`; a holder that signs often keeps the key rather than importing it per call. */
export declare const importHmacKey: (webCrypto: Crypto, secret: string, usages?: KeyUsage[]) => Promise<CryptoKey>;
/** HMAC-SHA256 of `text` under `secret` (both UTF-8), as bytes. */
export declare const hmacSha256Of: (secret: string, text: string) => Promise<Uint8Array>;
/**
 * Length-aware, timing-neutral string comparison: no early exit on the first
 * differing character, so how long it takes says nothing about where two
 * digests part. For comparing a stored digest with the digest of a candidate;
 * a signature is verified by WebCrypto, which compares in constant time
 * itself.
 */
export declare const constantTimeEquals: (a: string, b: string) => boolean;

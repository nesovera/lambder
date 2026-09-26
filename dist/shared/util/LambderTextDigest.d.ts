/**
 * SHA-256 through WebCrypto: the one digest every layer shares. The session
 * crypto hashes bearer secrets with it and the rate-limit engine folds an
 * over-long tracker key with it, so both key spaces are built from the same
 * primitive on every runtime (browsers on a secure context, Node 20+, edge
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

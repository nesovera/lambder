export declare const brotliCompressText: (input: Buffer, quality: number) => Promise<Buffer>;
/**
 * Restores text stored as Brotli bytes beside its declared UTF-8 byte length.
 * The length bounds the decompression and the output must match it exactly,
 * so a truncated or tampered record fails instead of decoding to something
 * else.
 */
export declare const brotliRestoreText: (compressed: Uint8Array, declaredBytes: number) => Promise<string>;

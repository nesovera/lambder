/**
 * The compression option every store shares. `true` is on with the store's
 * defaults, `false` is off, an object overrides the defaults: `minBytes` is
 * the UTF-8 size from which a value is stored compressed (0: always),
 * `quality` is Brotli 0-11. Values below minBytes are stored plain, and a
 * store reads records of either shape, so the option can be switched on or
 * off on a live table: records written under the other setting keep
 * reading, and each is rewritten in the current shape on its next write.
 */
export type LambderCompressionConfig = {
    minBytes?: number;
    quality?: number;
};
export type LambderCompressionOption = boolean | LambderCompressionConfig;
export type LambderCompressionSettings = Required<LambderCompressionConfig>;
/** Resolves a store's compression option against its defaults: null when off. */
export declare const resolveCompressionOption: (option: LambderCompressionOption | undefined, defaults: LambderCompressionSettings) => LambderCompressionSettings | null;
export declare const brotliCompressText: (input: Buffer, quality: number) => Promise<Buffer>;
/**
 * Restores text stored as Brotli bytes beside its declared UTF-8 byte length.
 * The length bounds the decompression and the output must match it exactly,
 * so a truncated or tampered record fails instead of decoding to something
 * else.
 */
export declare const brotliRestoreText: (compressed: Uint8Array, declaredBytes: number) => Promise<string>;

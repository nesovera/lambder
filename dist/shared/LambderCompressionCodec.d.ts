/**
 * The one place Lambder compresses and decompresses bytes.
 *
 * Five things compress: sessions, LambderDdbCache and LambderDdbIdempotency
 * (Brotli at rest in DynamoDB), HTTP responses (Brotli or gzip, negotiated)
 * and request payloads (gzip, because the browser's CompressionStream
 * offers nothing else). They all compress text, so TEXT mode throughout,
 * and they all restore it the same way: the compressed bytes beside the
 * text's original UTF-8 byte length.
 *
 * That length is the safety mechanism, not bookkeeping. It bounds the
 * decompression, so a body that would expand without limit is cut off
 * rather than allocated, and the restored length must match it exactly, so
 * a truncated or tampered input fails instead of decoding to something
 * merely plausible. Every caller gets that guarantee from this one
 * implementation: a bug fixed here is fixed for records at rest and for
 * untrusted request bodies alike.
 *
 * zlib is loaded lazily through node-polyfills, so a module importing this
 * one can still sit in a frontend bundle's import graph via the package
 * root. The option that decides WHETHER to compress, and the encoding
 * vocabulary, live in LambderCompressionOption, which stays free of zlib
 * entirely so the browser entry can resolve it.
 */
import type { LambderEncoding } from "./LambderCompressionOption.js";
/** Why a bounded restore failed, for callers that answer rather than throw. */
export declare const LAMBDER_RESTORE_FAILURES: {
    /** The declared byte length is absent or not a positive integer. */
    readonly missingLength: "missing-length";
    /** zlib refused the bytes: not this algorithm, truncated, or over the bound. */
    readonly undecodable: "undecodable";
    /** It decompressed, but not to the length it declared. */
    readonly lengthMismatch: "length-mismatch";
};
export type LambderRestoreFailure = (typeof LAMBDER_RESTORE_FAILURES)[keyof typeof LAMBDER_RESTORE_FAILURES];
/**
 * A restore that could not be trusted. Stores let it propagate (any throw
 * means "unusable record"); the request pipeline catches it and turns
 * `reason` into a client-facing refusal.
 */
export declare class LambderCompressionError extends Error {
    readonly reason: LambderRestoreFailure;
    constructor(reason: LambderRestoreFailure, message: string, options?: ErrorOptions);
}
/**
 * Compresses text. `quality` is the Brotli quality (0-11) and is ignored by
 * gzip, which has no comparable knob worth exposing.
 */
export declare const compressText: (input: Buffer, encoding: LambderEncoding, quality: number) => Promise<Buffer>;
/**
 * Restores text from compressed bytes beside the declared UTF-8 byte length
 * of the original, bounded and verified by that length. Throws
 * LambderCompressionError on anything it cannot vouch for.
 */
export declare const restoreBoundedText: (compressed: Uint8Array, declaredBytes: number, encoding: LambderEncoding) => Promise<string>;

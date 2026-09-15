/**
 * The one place Lambder compresses and decompresses bytes.
 *
 * Five things compress: sessions, LambderDdbCache and LambderDdbIdempotencyStore
 * (Brotli at rest in DynamoDB), HTTP responses (Brotli or gzip, negotiated)
 * and request payloads (gzip from a browser, whose CompressionStream offers
 * nothing else; Brotli from a Node caller). They all compress text, so TEXT
 * mode throughout, and they all restore it the same way: the compressed
 * bytes beside the text's original UTF-8 byte length. The one restore
 * without a declared length is a compressed HTTP answer read by
 * LambderInvokeCaller, which passes a ceiling instead; both restores take
 * either bound. That answer is also the one restore whose bytes may not be
 * text at all, so the restore comes in two: restoreBytes returns the buffer
 * and restoreText decodes it.
 *
 * That length is the safety mechanism, not bookkeeping. It bounds the
 * decompression, so a body that would expand without limit is cut off
 * rather than allocated, and the restored length must match it exactly, so
 * a truncated or tampered input fails instead of decoding to something
 * merely plausible. Every caller gets that guarantee from this one
 * implementation: a bug fixed here is fixed for records at rest and for
 * untrusted request bodies alike.
 *
 * zlib is loaded lazily through LambderNodeModules, so a module importing this
 * one can still sit in a frontend bundle's import graph via the package
 * root. Compressing needs zlib and is server-side; restoring runs anywhere,
 * through zlib where it exists and through the web DecompressionStream
 * otherwise, so the API core can restore a gzipped request payload in a
 * browser (the mock runtime) under the same bound. The option that decides
 * WHETHER to compress, and the encoding vocabulary, live in
 * LambderCompressionOption, which stays free of zlib entirely so the browser
 * entry can resolve it.
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
 * What bounds a restore: the text's declared UTF-8 byte length, stored
 * beside the bytes (the decompression stops there and the result must match
 * it exactly), or a ceiling alone, for bytes whose sender recorded no length
 * (a compressed HTTP answer): the decompression stops there and nothing is
 * verified.
 */
export type LambderRestoreBound = {
    declaredBytes: number;
} | {
    maxBytes: number;
};
/**
 * Restores the original bytes from compressed bytes under a bound. With
 * `declaredBytes` (records at rest, request payloads) the length both bounds
 * the decompression and verifies it, so a body that would expand without
 * limit is cut off rather than allocated, and a truncated or tampered input
 * fails instead of decoding to something merely plausible. With `maxBytes`
 * only the ceiling holds; truncation and corruption are what zlib's
 * stream-end check and gzip's CRC catch. Throws LambderCompressionError on
 * anything it cannot vouch for. A nonsense ceiling is the caller's
 * configuration error and throws a plain Error.
 *
 * This is the restore for bytes that are not text: a compressed binary
 * answer (a wasm module, an image a route forced compression on) read by
 * LambderInvokeCaller. Text callers use restoreText, which is this plus the
 * UTF-8 decode; going through a string would replace every byte that is not
 * valid UTF-8 and hand back a body that is silently not what was sent.
 */
export declare const restoreBytes: (compressed: Uint8Array, encoding: LambderEncoding, bound: LambderRestoreBound) => Promise<Uint8Array>;
/**
 * Restores text: restoreBytes plus the UTF-8 decode. What every text caller
 * uses (sessions, the DynamoDB stores, request payloads). The declared byte
 * length a `declaredBytes` bound carries is the text's UTF-8 byte length,
 * which is the restored buffer's length, so the verification is the same one
 * either way.
 */
export declare const restoreText: (compressed: Uint8Array, encoding: LambderEncoding, bound: LambderRestoreBound) => Promise<string>;

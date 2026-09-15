/**
 * Request payload compression: the wire format both sides speak.
 *
 * When a LambderCaller call's payload clears the configured size, the caller
 * sends the payload's JSON as `payloadGz` (gzip bytes, base64) beside
 * `payloadBytes` (its UTF-8 byte length) in place of `payload`, and the
 * server restores it before anything reads the payload. A Node caller
 * (LambderInvokeCaller) sends `payloadBr` instead, Brotli under the same
 * rules; the server accepts either. Everything else in the envelope
 * (apiName, version, token, siteHost, guardInputs, idempotencyKey) stays
 * plain text, so routing, logging and request mocking are unaffected.
 *
 * Base64 inside the JSON envelope, rather than a binary body with
 * Content-Encoding: API Gateway hands a binary request body to Lambda
 * base64-encoded anyway, so binary saves nothing against Lambda's ~6MB
 * invoke payload cap while adding a content-type negotiation that gateways,
 * CDNs and mock servers each treat differently. Base64's 4/3 overhead
 * applies to bytes that already shrank several times over.
 *
 * gzip rather than Brotli because the browser's CompressionStream offers
 * gzip and deflate only; responses, compressed by Node, do prefer Brotli.
 *
 * `payloadBytes` is not bookkeeping: it bounds the server's decompression
 * and the restored length must match it exactly, the same guarantee
 * LambderCompressionCodec gives stored records, so a malicious or truncated
 * body fails instead of expanding without limit.
 */
import type { LambderCompressionOption, LambderCompressionSettings } from "./LambderCompressionOption.js";
/** Envelope field carrying the base64 gzip of the payload's JSON. */
export declare const COMPRESSED_PAYLOAD_GZ_FIELD = "payloadGz";
/**
 * Envelope field carrying the base64 Brotli of the payload's JSON: the same
 * pair as payloadGz for a caller that can produce Brotli (a Node caller,
 * LambderInvokeCaller). A request carries one of the two, never both.
 */
export declare const COMPRESSED_PAYLOAD_BR_FIELD = "payloadBr";
/** Envelope field carrying the UTF-8 byte length of that JSON before compression. */
export declare const COMPRESSED_PAYLOAD_BYTES_FIELD = "payloadBytes";
/** The pair a gzip-compressing call sends in place of `payload`. */
export type LambderCompressedGzipPayload = {
    [COMPRESSED_PAYLOAD_GZ_FIELD]: string;
    [COMPRESSED_PAYLOAD_BYTES_FIELD]: number;
};
/** The pair a Brotli-compressing call sends in place of `payload`. */
export type LambderCompressedBrotliPayload = {
    [COMPRESSED_PAYLOAD_BR_FIELD]: string;
    [COMPRESSED_PAYLOAD_BYTES_FIELD]: number;
};
/**
 * Caller-side settings. Only a threshold: the browser's CompressionStream
 * exposes no quality knob, so there is nothing else to tune.
 */
export type LambderRequestCompressionSettings = {
    minBytes: number;
};
export type LambderRequestCompressionOption = LambderCompressionOption<LambderRequestCompressionSettings>;
/**
 * Defaults, resolved through the shared resolveCompressionOption like every
 * other compression option. Below a few KB the gzip header, the base64
 * overhead and the round trip through CompressionStream cost more than the
 * bytes they save. The caller passes `option ?? false`, because unlike the
 * at-rest stores this one is off unless asked for.
 */
export declare const DEFAULT_REQUEST_COMPRESSION_SETTINGS: LambderRequestCompressionSettings;
/**
 * Default ceiling for a restored payload, a request's on the server
 * (maxRequestPayloadBytes) or an answer's on the invoke caller
 * (maxResponsePayloadBytes). Lambda's ~6MB invoke cap already bounds the
 * compressed bytes; this bounds what they may expand to, so a highly
 * compressible body cannot exhaust the function's memory.
 */
export declare const DEFAULT_MAX_RESTORED_PAYLOAD_BYTES = 20000000;
/**
 * The threshold one call is judged against, or null when its payload goes
 * plainly: the caller's configured setting unless the call overrode it, and
 * `compressRequest: true` means "whatever the size", which is a threshold of
 * zero rather than a separate path.
 *
 * Both callers decide this, and the three-line ternary they each wrote is the
 * one place a caller can get the override backwards, so it is written once
 * beside the compressors it feeds.
 */
export declare const resolveRequestCompressionMinBytes: (compressRequest: boolean | undefined, settings: {
    minBytes: number;
} | null | undefined) => number | null;
/** True when this runtime can compress request payloads (browsers, and Node 18+). */
export declare const isRequestCompressionAvailable: () => boolean;
/**
 * Gzip one payload's JSON for sending, or null when the plain JSON should go
 * instead (see compressPayloadWith for the two rules). The second null
 * matters for the payloads most likely to be large: a base64 image gzips to
 * nearly its own size, and base64 then inflates the result past the
 * original. Sending that would cost CPU on both ends for a request that got
 * bigger, so the compressed form is only ever sent when it is smaller.
 */
export declare const compressPayloadGzip: (json: string, minBytes: number) => Promise<LambderCompressedGzipPayload | null>;
/** Request Brotli when `requestCompression: true` on LambderInvokeCaller: the HTTP request threshold, at the quality every other Lambder site uses. */
export declare const DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS: LambderCompressionSettings;
/**
 * Brotli one payload's JSON for sending, or null when the plain JSON should
 * go instead: compressPayloadGzip with Brotli, for a caller where both ends
 * are Node (LambderInvokeCaller). The threshold and the only-when-smaller
 * rule are compressPayloadWith's, shared with the gzip side.
 *
 * Beside its gzip twin rather than inside the invoke caller, because the two
 * are one wire format with one set of rules and a reader comparing them
 * should not have to open two files. It needs Buffer and zlib, which the
 * codec loads lazily, so this module stays resolvable from the browser entry
 * and a bundle that never calls this drops it with the codec behind it.
 */
export declare const compressPayloadBrotli: (json: string, minBytes: number, quality: number) => Promise<LambderCompressedBrotliPayload | null>;

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
import type { LambderCompressionOption } from "./LambderCompressionOption.js";
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
 * The two rules every compressed payload follows, whichever algorithm made
 * the bytes: nothing below the threshold is compressed, and the compressed
 * form is only ever sent when its base64 is smaller than the JSON it
 * replaces. The threshold is measured on real UTF-8 bytes, not string
 * length, so a payload of multi-byte text is judged by what actually goes on
 * the wire. `compress` is the algorithm: the browser's CompressionStream for
 * gzip, zlib for Brotli (LambderInvokeCaller); both go through here so the
 * rules cannot drift between them.
 */
export declare const compressPayloadWith: <TField extends string>(json: string, minBytes: number, field: TField, compress: (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>) => Promise<({ [K in TField]: string; } & {
    [COMPRESSED_PAYLOAD_BYTES_FIELD]: number;
}) | null>;
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
/**
 * Restores a payload the caller compressed, for request mocking
 * (LambderMSW), so a mock handler receives the same payload the server
 * would. The server does NOT use this: it decompresses through zlib, whose
 * bounded output is what makes an untrusted body safe to expand.
 */
export declare const decompressPayloadGzip: (payloadGz: string) => Promise<unknown>;

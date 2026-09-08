/**
 * Request payload compression: the wire format both sides speak.
 *
 * When a LambderCaller call's payload clears the configured size, the caller
 * sends the payload's JSON as `payloadGz` (gzip bytes, base64) beside
 * `payloadBytes` (its UTF-8 byte length) in place of `payload`, and the
 * server restores it before anything reads the payload. Everything else in
 * the envelope (apiName, version, token, siteHost, guardInputs,
 * idempotencyKey) stays plain text, so routing, logging and request mocking
 * are unaffected.
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
/** Envelope field carrying the base64 gzip of the payload's JSON. */
export const COMPRESSED_PAYLOAD_FIELD = "payloadGz";
/** Envelope field carrying the UTF-8 byte length of that JSON before compression. */
export const COMPRESSED_PAYLOAD_BYTES_FIELD = "payloadBytes";
/**
 * Defaults, resolved through the shared resolveCompressionOption like every
 * other compression option. Below a few KB the gzip header, the base64
 * overhead and the round trip through CompressionStream cost more than the
 * bytes they save. The caller passes `option ?? false`, because unlike the
 * at-rest stores this one is off unless asked for.
 */
export const DEFAULT_REQUEST_COMPRESSION_SETTINGS = { minBytes: 4096 };
/**
 * Default ceiling for a restored payload. Lambda's ~6MB invoke cap already
 * bounds the compressed bytes; this bounds what they may expand to, so a
 * highly compressible body cannot exhaust the function's memory.
 */
export const DEFAULT_MAX_REQUEST_PAYLOAD_BYTES = 20_000_000;
/** Chunked so a large payload cannot overflow the argument list of String.fromCharCode. */
const bytesToBase64 = (bytes) => {
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
};
/** True when this runtime can compress request payloads (browsers, and Node 18+). */
export const isRequestCompressionAvailable = () => typeof CompressionStream !== "undefined" && typeof btoa !== "undefined";
/**
 * Gzip one payload's JSON for sending, or null when the plain JSON should go
 * instead: below the threshold, or when compressing did not make it smaller.
 * The threshold is measured on real UTF-8 bytes, not string length, so a
 * payload of multi-byte text is judged by what actually goes on the wire.
 *
 * The second null matters for the payloads most likely to be large: a
 * base64 image gzips to nearly its own size, and base64 then inflates the
 * result past the original. Sending that would cost CPU on both ends for a
 * request that got bigger, so the compressed form is only ever sent when it
 * is smaller than the JSON it replaces.
 */
export const compressPayloadJson = async (json, minBytes) => {
    const encoded = new TextEncoder().encode(json);
    if (encoded.length < minBytes)
        return null;
    const stream = new Blob([encoded]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    const base64 = bytesToBase64(compressed);
    if (base64.length >= encoded.length)
        return null;
    return {
        [COMPRESSED_PAYLOAD_FIELD]: base64,
        [COMPRESSED_PAYLOAD_BYTES_FIELD]: encoded.length,
    };
};
/**
 * Restores a payload the caller compressed, for request mocking
 * (LambderMSW), so a mock handler receives the same payload the server
 * would. The server does NOT use this: it decompresses through zlib, whose
 * bounded output is what makes an untrusted body safe to expand.
 */
export const decompressPayloadJson = async (payloadGz) => {
    const binary = atob(payloadGz);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
};

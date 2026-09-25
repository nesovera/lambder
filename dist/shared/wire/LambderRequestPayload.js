import { bytesToBase64 } from "../util/LambderBase64.js";
import { compressText } from "./LambderCompressionCodec.js";
/** Envelope field carrying the base64 gzip of the payload's JSON. */
export const COMPRESSED_PAYLOAD_GZ_FIELD = "payloadGz";
/**
 * Envelope field carrying the base64 Brotli of the payload's JSON: the same
 * pair as payloadGz for a caller that can produce Brotli (a Node caller,
 * LambderInvokeCaller). A request carries one of the two, never both.
 */
export const COMPRESSED_PAYLOAD_BR_FIELD = "payloadBr";
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
 * Default ceiling for a restored payload, a request's on the server
 * (maxRequestPayloadBytes) or an answer's on the invoke caller
 * (maxResponsePayloadBytes). Lambda's ~6MB invoke cap already bounds the
 * compressed bytes; this bounds what they may expand to, so a highly
 * compressible body cannot exhaust the function's memory.
 */
export const DEFAULT_MAX_RESTORED_PAYLOAD_BYTES = 20_000_000;
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
const compressPayloadWith = async (json, minBytes, field, compress) => {
    const encoded = new TextEncoder().encode(json);
    if (encoded.length < minBytes)
        return null;
    const base64 = bytesToBase64(await compress(encoded));
    if (base64.length >= encoded.length)
        return null;
    return { [field]: base64, [COMPRESSED_PAYLOAD_BYTES_FIELD]: encoded.length };
};
/**
 * The threshold one call is judged against, or null when its payload goes
 * plainly: the caller's configured setting unless the call overrode it, and
 * `compressRequest: true` means "whatever the size", which is a threshold of
 * zero rather than a separate path.
 *
 * Both callers decide this, and the override is easy to get backwards, so it
 * is written once, beside the compressors it feeds.
 */
export const resolveRequestCompressionMinBytes = (compressRequest, settings) => compressRequest === true ? 0
    : compressRequest === false ? null
        : settings?.minBytes ?? null;
/** True when this runtime can compress request payloads (browsers, and Node 18+). */
export const isRequestCompressionAvailable = () => typeof CompressionStream !== "undefined" && typeof btoa !== "undefined";
/**
 * Gzip one payload's JSON for sending, or null when the plain JSON should go
 * instead (see compressPayloadWith for the two rules). The second rule
 * matters for the payloads most likely to be large: a base64 image gzips to
 * nearly its own size, and base64 then inflates the result past the
 * original, so sending it would cost CPU on both ends for a bigger request.
 */
export const compressPayloadGzip = (json, minBytes) => compressPayloadWith(json, minBytes, COMPRESSED_PAYLOAD_GZ_FIELD, async (bytes) => {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
});
/** Request Brotli when `requestCompression: true` on LambderInvokeCaller: the HTTP request threshold, at the quality every other Lambder site uses. */
export const DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS = { minBytes: 4096, quality: 5 };
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
export const compressPayloadBrotli = (json, minBytes, quality) => compressPayloadWith(json, minBytes, COMPRESSED_PAYLOAD_BR_FIELD, (bytes) => compressText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), "br", quality));

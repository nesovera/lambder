/**
 * The one place Lambder compresses and decompresses bytes.
 *
 * Five things compress: sessions, LambderDdbCache and LambderDdbIdempotency
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
 * zlib is loaded lazily through node-polyfills, so a module importing this
 * one can still sit in a frontend bundle's import graph via the package
 * root. The option that decides WHETHER to compress, and the encoding
 * vocabulary, live in LambderCompressionOption, which stays free of zlib
 * entirely so the browser entry can resolve it.
 */
import { getZlib } from "./node-polyfills.js";
/** Why a bounded restore failed, for callers that answer rather than throw. */
export const LAMBDER_RESTORE_FAILURES = {
    /** The declared byte length is absent or not a positive integer. */
    missingLength: "missing-length",
    /** zlib refused the bytes: not this algorithm, truncated, or over the bound. */
    undecodable: "undecodable",
    /** It decompressed, but not to the length it declared. */
    lengthMismatch: "length-mismatch",
};
/**
 * A restore that could not be trusted. Stores let it propagate (any throw
 * means "unusable record"); the request pipeline catches it and turns
 * `reason` into a client-facing refusal.
 */
export class LambderCompressionError extends Error {
    reason;
    constructor(reason, message, options) {
        super(message, options);
        this.name = "LambderCompressionError";
        this.reason = reason;
    }
}
// Not a LambderCompressionError: nothing was wrong with the bytes, so there
// is no restore `reason` to report. Callers that map reasons fall through to
// their generic failure, which is the honest answer here.
const requireZlib = async () => {
    const zlib = await getZlib();
    if (!zlib)
        throw new Error("Lambder compression requires a Node.js environment.");
    return zlib;
};
/**
 * Compresses text. `quality` is the Brotli quality (0-11) and is ignored by
 * gzip, which has no comparable knob worth exposing.
 */
export const compressText = async (input, encoding, quality) => {
    const zlib = await requireZlib();
    return await new Promise((resolve, reject) => {
        const done = (error, output) => { if (error)
            reject(error);
        else
            resolve(output); };
        if (encoding === "br") {
            zlib.brotliCompress(input, {
                params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
                    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                },
            }, done);
        }
        else {
            zlib.gzip(input, done);
        }
    });
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
export const restoreBytes = async (compressed, encoding, bound) => {
    const verified = "declaredBytes" in bound;
    const limit = verified ? bound.declaredBytes : bound.maxBytes;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
        if (verified) {
            throw new LambderCompressionError(LAMBDER_RESTORE_FAILURES.missingLength, "compressed value is missing its byte length");
        }
        throw new Error("restoreBytes: maxBytes must be a positive integer");
    }
    const zlib = await requireZlib();
    let output;
    try {
        // zlib reads any Uint8Array in place; a request-sized body is not copied first.
        output = await new Promise((resolve, reject) => {
            const done = (error, result) => { if (error)
                reject(error);
            else
                resolve(result); };
            // maxOutputLength is the bound: zlib stops rather than allocating past it.
            if (encoding === "br")
                zlib.brotliDecompress(compressed, { maxOutputLength: limit }, done);
            else
                zlib.gunzip(compressed, { maxOutputLength: limit }, done);
        });
    }
    catch (err) {
        throw new LambderCompressionError(LAMBDER_RESTORE_FAILURES.undecodable, "compressed value could not be decompressed", { cause: err });
    }
    if (verified && output.length !== limit) {
        throw new LambderCompressionError(LAMBDER_RESTORE_FAILURES.lengthMismatch, "decompressed length does not match the declared length");
    }
    return output;
};
/**
 * Restores text: restoreBytes plus the UTF-8 decode. What every text caller
 * uses (sessions, the DynamoDB stores, request payloads). The declared byte
 * length a `declaredBytes` bound carries is the text's UTF-8 byte length,
 * which is the restored buffer's length, so the verification is the same one
 * either way.
 */
export const restoreText = async (compressed, encoding, bound) => (await restoreBytes(compressed, encoding, bound)).toString("utf8");

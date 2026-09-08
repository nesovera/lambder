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
 * Restores text from compressed bytes beside the declared UTF-8 byte length
 * of the original, bounded and verified by that length. Throws
 * LambderCompressionError on anything it cannot vouch for.
 */
export const restoreBoundedText = async (compressed, declaredBytes, encoding) => {
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) {
        throw new LambderCompressionError(LAMBDER_RESTORE_FAILURES.missingLength, "compressed value is missing its byte length");
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
                zlib.brotliDecompress(compressed, { maxOutputLength: declaredBytes }, done);
            else
                zlib.gunzip(compressed, { maxOutputLength: declaredBytes }, done);
        });
    }
    catch (err) {
        throw new LambderCompressionError(LAMBDER_RESTORE_FAILURES.undecodable, "compressed value could not be decompressed", { cause: err });
    }
    if (output.length !== declaredBytes) {
        throw new LambderCompressionError(LAMBDER_RESTORE_FAILURES.lengthMismatch, "decompressed length does not match the declared length");
    }
    return output.toString("utf8");
};

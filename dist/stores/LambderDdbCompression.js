import { getZlib } from "../shared/node-polyfills.js";
/** Resolves a store's compression option against its defaults: null when off. */
export const resolveCompressionOption = (option, defaults) => {
    if (option === false)
        return null;
    const config = option === true || option === undefined ? {} : option;
    const settings = { minBytes: config.minBytes ?? defaults.minBytes, quality: config.quality ?? defaults.quality };
    if (!Number.isSafeInteger(settings.minBytes) || settings.minBytes < 0) {
        throw new Error("compression.minBytes must be a non-negative integer");
    }
    if (!Number.isInteger(settings.quality) || settings.quality < 0 || settings.quality > 11) {
        throw new Error("compression.quality must be an integer from 0 to 11");
    }
    return settings;
};
const requireZlib = async () => {
    const zlib = await getZlib();
    if (!zlib)
        throw new Error("Lambder DDB stores require a Node.js environment.");
    return zlib;
};
export const brotliCompressText = async (input, quality) => {
    const zlib = await requireZlib();
    return new Promise((resolve, reject) => {
        zlib.brotliCompress(input, {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
                [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            },
        }, (error, output) => {
            if (error)
                reject(error);
            else
                resolve(output);
        });
    });
};
/**
 * Restores text stored as Brotli bytes beside its declared UTF-8 byte length.
 * The length bounds the decompression and the output must match it exactly,
 * so a truncated or tampered record fails instead of decoding to something
 * else.
 */
export const brotliRestoreText = async (compressed, declaredBytes) => {
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) {
        throw new Error("compressed record is missing its byte length");
    }
    const zlib = await requireZlib();
    const output = await new Promise((resolve, reject) => {
        zlib.brotliDecompress(Buffer.from(compressed), { maxOutputLength: declaredBytes }, (error, result) => {
            if (error)
                reject(error);
            else
                resolve(result);
        });
    });
    if (output.length !== declaredBytes) {
        throw new Error("decompressed length does not match the record");
    }
    return output.toString("utf8");
};

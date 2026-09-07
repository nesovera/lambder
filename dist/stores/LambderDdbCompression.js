import { getZlib } from "../shared/node-polyfills.js";
// Brotli compression shared by the DynamoDB-backed stores (LambderDdbCache,
// LambderDdbIdempotency, LambderSessionManager). Values they persist are text
// (JSON), so TEXT mode, and they all store it the same way: the Brotli bytes
// beside the text's original UTF-8 byte length, which bounds the decompression
// (a corrupt record cannot balloon memory) and verifies it. zlib is loaded
// lazily through node-polyfills so these modules can sit in a frontend
// bundle's import graph (via the package root) without breaking.
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

import { getZlib } from "../shared/node-polyfills.js";
// Brotli compression shared by the DynamoDB-backed stores (LambderDdbCache,
// LambderDdbIdempotency). Values they persist are text (JSON), so TEXT mode;
// zlib is loaded lazily through node-polyfills so these modules can sit in a
// frontend bundle's import graph (via the package root) without breaking.
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
/** maxOutputLength bounds decompression so a corrupt record cannot balloon memory. */
export const brotliDecompressText = async (input, maxOutputLength) => {
    const zlib = await requireZlib();
    return new Promise((resolve, reject) => {
        zlib.brotliDecompress(input, { maxOutputLength }, (error, output) => {
            if (error)
                reject(error);
            else
                resolve(output);
        });
    });
};

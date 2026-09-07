import { getZlib } from "../shared/node-polyfills.js";

// Brotli compression shared by the DynamoDB-backed stores (LambderDdbCache,
// LambderDdbIdempotency, LambderSessionManager). Values they persist are text
// (JSON), so TEXT mode, and they all store it the same way: the Brotli bytes
// beside the text's original UTF-8 byte length, which bounds the decompression
// (a corrupt record cannot balloon memory) and verifies it. zlib is loaded
// lazily through node-polyfills so these modules can sit in a frontend
// bundle's import graph (via the package root) without breaking.

/**
 * The compression option every store shares. `true` is on with the store's
 * defaults, `false` is off, an object overrides the defaults: `minBytes` is
 * the UTF-8 size from which a value is stored compressed (0: always),
 * `quality` is Brotli 0-11. Values below minBytes are stored plain, and a
 * store reads records of either shape, so the option can be switched on or
 * off on a live table: records written under the other setting keep
 * reading, and each is rewritten in the current shape on its next write.
 */
export type LambderCompressionConfig = { minBytes?: number; quality?: number };
export type LambderCompressionOption = boolean | LambderCompressionConfig;
export type LambderCompressionSettings = Required<LambderCompressionConfig>;

/** Resolves a store's compression option against its defaults: null when off. */
export const resolveCompressionOption = (
    option: LambderCompressionOption | undefined,
    defaults: LambderCompressionSettings,
): LambderCompressionSettings | null => {
    if (option === false) return null;
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
    if (!zlib) throw new Error("Lambder DDB stores require a Node.js environment.");
    return zlib;
};

export const brotliCompressText = async (input: Buffer, quality: number): Promise<Buffer> => {
    const zlib = await requireZlib();
    return new Promise((resolve, reject) => {
        zlib.brotliCompress(
            input,
            {
                params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
                    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                },
            },
            (error, output) => {
                if (error) reject(error);
                else resolve(output);
            },
        );
    });
};

/**
 * Restores text stored as Brotli bytes beside its declared UTF-8 byte length.
 * The length bounds the decompression and the output must match it exactly,
 * so a truncated or tampered record fails instead of decoding to something
 * else.
 */
export const brotliRestoreText = async (compressed: Uint8Array, declaredBytes: number): Promise<string> => {
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) {
        throw new Error("compressed record is missing its byte length");
    }
    const zlib = await requireZlib();
    const output = await new Promise<Buffer>((resolve, reject) => {
        zlib.brotliDecompress(Buffer.from(compressed), { maxOutputLength: declaredBytes }, (error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
    if (output.length !== declaredBytes) {
        throw new Error("decompressed length does not match the record");
    }
    return output.toString("utf8");
};

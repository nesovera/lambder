import { compressText, restoreText } from "../shared/wire/LambderCompressionCodec.js";
/**
 * The text's UTF-8 bytes as the store keeps them, under its compression
 * settings (null: compression off). The plain form is the bytes handed in,
 * not a copy.
 */
export const storedTextOf = async (utf8, compression) => {
    const textBytes = utf8.byteLength;
    if (compression && textBytes > 0 && textBytes >= compression.minBytes) {
        return { encoding: "br", stored: await compressText(utf8, "br", compression.quality), textBytes };
    }
    return { encoding: "identity", stored: utf8, textBytes };
};
/**
 * The text a compressed record holds, restored under the length it declares,
 * or a throw: a plain Error naming the store when the declared length is over
 * its ceiling, and the codec's LambderCompressionError when the length is
 * missing or the bytes do not restore to exactly that length.
 */
export const restoreStoredText = async (compressed, declaredBytes, ceiling) => {
    if (declaredBytes > ceiling.maxTextBytes) {
        throw new Error(`${ceiling.user}: a stored record declares ${declaredBytes} bytes of text, over the ${ceiling.maxTextBytes}-byte limit it restores, so the record is unusable.`);
    }
    return await restoreText(compressed, "br", { declaredBytes });
};

import { compressText, restoreText } from "../shared/wire/LambderCompressionCodec.js";
import type { LambderCompressionSettings } from "../shared/wire/LambderCompressionOption.js";

/*
 * Text a DynamoDB store keeps at rest, Brotli-compressed or plain: one scheme
 * for every store that keeps text (the session store's data, the idempotency
 * store's response bodies, the cache's values).
 *
 * Writing, the text's UTF-8 bytes are compressed when the store's compression
 * is on and they reach its minBytes, and kept as they are otherwise. The
 * compressed form is stored beside the text's UTF-8 byte length, the declared
 * length that both bounds and verifies the restore (see
 * LambderCompressionCodec). An empty text is never compressed, whatever
 * minBytes says: its declared length would be zero, a length the codec
 * refuses on the way back, so the record would be unreadable for its whole
 * TTL.
 *
 * Reading, the declared length comes off the table, so it is checked against
 * the store's ceiling before anything is decompressed. A record declaring
 * more than the store ever writes is not its own, and trusting the number
 * would let a few hundred kilobytes of Brotli expand until the function dies.
 * Each store refuses to write text past the same ceiling, so every record it
 * writes reads back.
 *
 * Each store keeps its own attribute names and its own plain form (a string,
 * a binary, a map), so the items they write are what they were; only the
 * decision and the restore are here.
 */

/** Text as a store keeps it: `stored` is the Brotli bytes ("br") or the UTF-8 bytes themselves ("identity"). */
export interface LambderStoredText {
    encoding: "br" | "identity";
    stored: Buffer;
    /** The text's UTF-8 byte length: the declared length a compressed text is restored under. */
    textBytes: number;
}

/** What a store restores stored text under: the most it ever writes, and its own name for the refusal. */
export interface LambderStoredTextCeiling {
    user: string;
    maxTextBytes: number;
}

/**
 * The text's UTF-8 bytes as the store keeps them, under its compression
 * settings (null: compression off). The plain form is the bytes handed in,
 * not a copy.
 */
export const storedTextOf = async (utf8: Buffer, compression: LambderCompressionSettings | null): Promise<LambderStoredText> => {
    const textBytes = utf8.byteLength;
    if(compression && textBytes > 0 && textBytes >= compression.minBytes){
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
export const restoreStoredText = async (compressed: Uint8Array, declaredBytes: number, ceiling: LambderStoredTextCeiling): Promise<string> => {
    if(declaredBytes > ceiling.maxTextBytes){
        throw new Error(`${ceiling.user}: a stored record declares ${declaredBytes} bytes of text, over the ${ceiling.maxTextBytes}-byte limit it restores, so the record is unusable.`);
    }
    return await restoreText(compressed, "br", { declaredBytes });
};

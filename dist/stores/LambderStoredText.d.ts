import type { LambderCompressionSettings } from "../shared/wire/LambderCompressionOption.js";
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
export declare const storedTextOf: (utf8: Buffer, compression: LambderCompressionSettings | null) => Promise<LambderStoredText>;
/**
 * The text a compressed record holds, restored under the length it declares,
 * or a throw: a plain Error naming the store when the declared length is over
 * its ceiling, and the codec's LambderCompressionError when the length is
 * missing or the bytes do not restore to exactly that length.
 */
export declare const restoreStoredText: (compressed: Uint8Array, declaredBytes: number, ceiling: LambderStoredTextCeiling) => Promise<string>;

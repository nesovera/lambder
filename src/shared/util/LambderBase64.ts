/**
 * Base64 in both directions where Buffer may not exist (the browser caller,
 * the mock runtime in a page). Buffer where there is one, since it is much
 * faster; otherwise the platform's atob/btoa, chunked on the way in so a
 * large payload cannot overflow the argument list of String.fromCharCode.
 */

export const bytesToBase64 = (bytes: Uint8Array): string => {
    if(typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    const chunkSize = 0x8000;
    let binary = "";
    for(let i = 0; i < bytes.length; i += chunkSize){
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
};

export const base64ToBytes = (base64: string): Uint8Array => {
    if(typeof Buffer !== "undefined") return Buffer.from(base64, "base64");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for(let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

/** The base64 of UTF-8 text back to the text. */
export const base64ToText = (base64: string): string => new TextDecoder().decode(base64ToBytes(base64));

/**
 * The base64url alphabet (RFC 4648 section 5) without padding: what a token
 * or a digest carries where "+", "/" and "=" would need escaping, in a URL, a
 * header or a database column.
 */
export const bytesToBase64Url = (bytes: Uint8Array): string =>
    bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Whether `text` is base64url and nothing else, so decoding it decodes rather
 * than guesses; Buffer decodes anything. A length that leaves a remainder of
 * one past a multiple of four is no encoding of any bytes, and the platform's
 * atob throws on it where Buffer shrugs, so it is refused here on both.
 */
export const isBase64Url = (text: string): boolean => text.length % 4 !== 1 && /^[A-Za-z0-9_-]*$/.test(text);

export const base64UrlToBytes = (base64Url: string): Uint8Array => {
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    return base64ToBytes(base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "="));
};

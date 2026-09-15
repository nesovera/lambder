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

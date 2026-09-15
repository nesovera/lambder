/**
 * Base64 in both directions where Buffer may not exist (the browser caller,
 * the mock runtime in a page). Buffer where there is one, since it is much
 * faster; otherwise the platform's atob/btoa, chunked on the way in so a
 * large payload cannot overflow the argument list of String.fromCharCode.
 */
export declare const bytesToBase64: (bytes: Uint8Array) => string;
export declare const base64ToBytes: (base64: string) => Uint8Array;
/** The base64 of UTF-8 text back to the text. */
export declare const base64ToText: (base64: string) => string;

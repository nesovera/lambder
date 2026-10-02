import { bytesToBase64 } from "./LambderBase64.js";
import { getCrypto } from "./LambderNodeModules.js";
/**
 * SHA-256 and HMAC-SHA256 through WebCrypto: the digests every layer shares.
 * The session crypto hashes bearer secrets with the first and partitions
 * session keys with the second, the policy engines digest the caller's
 * fields of their store keys, signed claims and keyed digests are HMACs
 * under an app's secret, so every key space is built from the same
 * primitives on every runtime (browsers on a secure context, Node 20+, edge
 * runtimes); an upload's checksum is the same digest over the file's bytes.
 */
/** Lowercase hex of a byte array, two characters per byte. */
export const bytesToHexString = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
let webCryptoPromise;
/**
 * globalThis.crypto where the runtime has it, else Node's webcrypto (a Node
 * without the global). Resolved once per process; a runtime with neither
 * throws, naming what is missing.
 */
export const resolveWebCrypto = () => {
    webCryptoPromise ??= (async () => {
        if (typeof globalThis.crypto?.subtle?.digest === "function")
            return globalThis.crypto;
        const nodeCrypto = await getCrypto();
        const webCrypto = nodeCrypto?.webcrypto;
        if (webCrypto?.subtle)
            return webCrypto;
        throw new Error("Lambder needs WebCrypto (crypto.subtle) in this runtime. A browser provides it on a secure context (https or localhost); Node 20+ provides it as globalThis.crypto.");
    })();
    return webCryptoPromise;
};
/** The SHA-256 digest of `text` (UTF-8), as 64 lowercase hex characters. */
export const sha256HexOf = async (text) => {
    const webCrypto = await resolveWebCrypto();
    const digest = await webCrypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return bytesToHexString(new Uint8Array(digest));
};
/** The SHA-256 digest of `bytes`, as base64: the form object storage checks an upload's checksum in. */
export const sha256Base64Of = async (bytes) => {
    const webCrypto = await resolveWebCrypto();
    return bytesToBase64(new Uint8Array(await webCrypto.subtle.digest("SHA-256", bytes)));
};
/** An HMAC-SHA256 key over `secret` (UTF-8), for `usages`; a holder that signs often keeps the key rather than importing it per call. */
export const importHmacKey = async (webCrypto, secret, usages = ["sign"]) => await webCrypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
/** HMAC-SHA256 of `text` under `secret` (both UTF-8), as bytes. */
export const hmacSha256Of = async (secret, text) => {
    const webCrypto = await resolveWebCrypto();
    const key = await importHmacKey(webCrypto, secret);
    return new Uint8Array(await webCrypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
};
/**
 * Length-aware, timing-neutral string comparison: no early exit on the first
 * differing character, so how long it takes says nothing about where two
 * digests part. For comparing a stored digest with the digest of a candidate;
 * a signature is verified by WebCrypto, which compares in constant time
 * itself.
 */
export const constantTimeEquals = (a, b) => {
    if (a.length !== b.length)
        return false;
    let difference = 0;
    for (let i = 0; i < a.length; i += 1)
        difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
};

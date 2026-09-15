import { getCrypto } from "./LambderNodeModules.js";

/**
 * SHA-256 over text through WebCrypto, as hex: the one digest every layer
 * shares. The session crypto hashes bearer secrets with it and the
 * rate-limit engine folds an over-long tracker key with it, so both key
 * spaces are built from the same primitive on every runtime (browsers on a
 * secure context, Node 20+, edge runtimes).
 */

/** Lowercase hex of a byte array, two characters per byte. */
export const bytesToHexString = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

let webCryptoPromise: Promise<Crypto> | undefined;

/**
 * globalThis.crypto where the runtime has it, else Node's webcrypto (a Node
 * without the global). Resolved once per process; a runtime with neither
 * throws, naming what is missing.
 */
export const resolveWebCrypto = (): Promise<Crypto> => {
    webCryptoPromise ??= (async () => {
        if(typeof globalThis.crypto?.subtle?.digest === "function") return globalThis.crypto;
        const nodeCrypto = await getCrypto();
        const webCrypto = nodeCrypto?.webcrypto as unknown as Crypto | undefined;
        if(webCrypto?.subtle) return webCrypto;
        throw new Error("Lambder needs WebCrypto (crypto.subtle) in this runtime. A browser provides it on a secure context (https or localhost); Node 20+ provides it as globalThis.crypto.");
    })();
    return webCryptoPromise;
};

/** The SHA-256 digest of `text` (UTF-8), as 64 lowercase hex characters. */
export const sha256HexOf = async (text: string): Promise<string> => {
    const webCrypto = await resolveWebCrypto();
    const digest = await webCrypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return bytesToHexString(new Uint8Array(digest));
};

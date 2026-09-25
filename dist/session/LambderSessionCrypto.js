/**
 * The cryptography the session model runs on, behind an interface so the
 * manager itself has no Node dependency: the bearer secrets are hashed at
 * rest, compared in constant time, and minted from a cryptographic random
 * source, and the sessionKey is hashed under the salt as its key.
 *
 * LambderWebCrypto is the default and runs on Node 20+, every browser on a
 * secure context, and edge runtimes. LambderPlainSessionCrypto is the
 * stand-in the mock runtime picks on its own where crypto.subtle is missing
 * (a plain-http page during device testing on a LAN): its memory store is
 * not a table anybody can leak, so hashing there protects nothing.
 */
import { getCrypto } from "../shared/util/LambderNodeModules.js";
import { bytesToHexString, resolveWebCrypto, sha256HexOf } from "../shared/util/LambderTextDigest.js";
/** Length-aware, timing-neutral string comparison: no early exit on the first differing character. */
const constantTimeEqual = (a, b) => {
    if (a.length !== b.length)
        return false;
    let difference = 0;
    for (let i = 0; i < a.length; i += 1)
        difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
};
/** True when this runtime offers WebCrypto's subtle API (secure contexts in browsers; Node 20+). */
export const isWebCryptoAvailable = () => typeof globalThis.crypto?.subtle?.digest === "function" && typeof globalThis.crypto.getRandomValues === "function";
/** sha256 and HMAC through crypto.subtle and randomness through getRandomValues: the default. */
export class LambderWebCrypto {
    isCryptographic = true;
    cryptoPromise;
    /**
     * Node's crypto where the runtime has it, kept for timingSafeEqual.
     * Warmed by ready(), because the comparison itself is synchronous and a
     * session is always hashed before anything is compared against it.
     */
    nodeCrypto = null;
    /**
     * The runtime's WebCrypto, through the resolver every layer shares, with
     * Node's crypto warmed alongside it.
     *
     * Availability is checked here, before the shared resolver, so the error
     * can name this layer's own way out: a runtime with neither a global
     * crypto nor Node's webcrypto can still run sessions over
     * LambderPlainSessionCrypto and a memory store, which the shared
     * resolver's message cannot know about.
     */
    ready() {
        this.cryptoPromise ??= (async () => {
            const nodeCrypto = await getCrypto();
            this.nodeCrypto = nodeCrypto;
            const nodeWebCrypto = nodeCrypto?.webcrypto;
            if (!isWebCryptoAvailable() && !nodeWebCrypto?.subtle) {
                throw new Error("Lambder sessions need WebCrypto (crypto.subtle). In a browser that means a secure context (https or localhost); pass `crypto: new LambderPlainSessionCrypto()` where none is available and the store holds nothing worth hashing.");
            }
            return await resolveWebCrypto();
        })();
        return this.cryptoPromise;
    }
    async sha256Hex(value) {
        // ready() first, for its error message and the warmed Node crypto;
        // the digest itself is the one every layer shares.
        await this.ready();
        return await sha256HexOf(value);
    }
    async hmacSha256Hex(key, value) {
        const webCrypto = await this.ready();
        const encoder = new TextEncoder();
        const hmacKey = await webCrypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        return bytesToHexString(new Uint8Array(await webCrypto.subtle.sign("HMAC", hmacKey, encoder.encode(value))));
    }
    async randomHex(bytes) {
        const webCrypto = await this.ready();
        return bytesToHexString(webCrypto.getRandomValues(new Uint8Array(bytes)));
    }
    constantTimeEqual(a, b) {
        // Node's timingSafeEqual where the runtime has it: a primitive built
        // for this beats a JS loop the engine is free to optimize. Browsers
        // fall back to the loop.
        const nodeCrypto = this.nodeCrypto;
        if (nodeCrypto && a.length === b.length) {
            const left = Buffer.from(a, "utf8");
            const right = Buffer.from(b, "utf8");
            if (left.length === right.length)
                return nodeCrypto.timingSafeEqual(left, right);
        }
        return constantTimeEqual(a, b);
    }
}
/**
 * No hashing and no cryptographic randomness: values are hex-encoded as
 * they are and secrets come from Math.random. Only for an in-memory store
 * in a runtime without WebCrypto; never for anything at rest.
 */
export class LambderPlainSessionCrypto {
    isCryptographic = false;
    async sha256Hex(value) {
        return bytesToHexString(new TextEncoder().encode(value));
    }
    /**
     * The key and the value hex-encoded as a JSON pair rather than run
     * together, so the pair stays unambiguous the way a keyed hash keeps it:
     * no key and value can pass for another split of the same text.
     */
    async hmacSha256Hex(key, value) {
        return bytesToHexString(new TextEncoder().encode(JSON.stringify([key, value])));
    }
    async randomHex(bytes) {
        const random = new Uint8Array(bytes);
        for (let i = 0; i < bytes; i += 1)
            random[i] = Math.floor(Math.random() * 256);
        return bytesToHexString(random);
    }
    constantTimeEqual(a, b) {
        return constantTimeEqual(a, b);
    }
}

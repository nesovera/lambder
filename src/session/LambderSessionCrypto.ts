/**
 * The cryptography the session model runs on, behind an interface so the
 * manager itself has no Node dependency: the bearer secrets are hashed at
 * rest, compared in constant time, and minted from a cryptographic random
 * source.
 *
 * LambderWebCrypto is the default and runs on Node 20+, every browser on a
 * secure context, and edge runtimes. LambderPlainSessionCrypto is the
 * stand-in the mock runtime picks on its own where crypto.subtle is missing
 * (a plain-http page during device testing on a LAN): its memory store is
 * not a table anybody can leak, so hashing there protects nothing.
 */

import { getCrypto } from "../shared/util/LambderNodeModules.js";
import { bytesToHexString, resolveWebCrypto, sha256HexOf } from "../shared/util/LambderTextDigest.js";

/**
 * Hashing, randomness and constant-time comparison, as the session manager
 * asks for them. Implement it to run sessions on a runtime's own primitives.
 */
export interface LambderSessionCrypto {
    /**
     * Whether this really hashes and really draws random bytes. The session
     * manager refuses a non-cryptographic implementation over a store that
     * outlives the process, because such a store would then hold usable
     * credentials rather than hashes of them.
     */
    readonly isCryptographic: boolean;
    sha256Hex(value: string): Promise<string>;
    randomHex(bytes: number): Promise<string>;
    constantTimeEqual(a: string, b: string): boolean;
}

/** Length-aware, timing-neutral string comparison: no early exit on the first differing character. */
const constantTimeEqual = (a: string, b: string): boolean => {
    if(a.length !== b.length) return false;
    let difference = 0;
    for(let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
};

/** True when this runtime offers WebCrypto's subtle API (secure contexts in browsers; Node 20+). */
export const isWebCryptoAvailable = (): boolean =>
    typeof globalThis.crypto?.subtle?.digest === "function" && typeof globalThis.crypto.getRandomValues === "function";

/** sha256 through crypto.subtle and randomness through getRandomValues: the default. */
export class LambderWebCrypto implements LambderSessionCrypto {
    readonly isCryptographic = true;

    private cryptoPromise: Promise<Crypto> | undefined;
    /**
     * Node's crypto where the runtime has it, kept for timingSafeEqual.
     * Warmed by ready(), because the comparison itself is synchronous and a
     * session is always hashed before anything is compared against it.
     */
    private nodeCrypto: typeof import("crypto") | null = null;

    /**
     * The runtime's WebCrypto, through the resolver every layer shares, with
     * Node's crypto warmed alongside it.
     *
     * The availability question is asked here, before the shared resolver,
     * only because of the answer a session has to it: a runtime with neither
     * a global crypto nor Node's webcrypto can still run sessions over
     * LambderPlainSessionCrypto and a memory store, which is this layer's own
     * way out and not something the shared message can know about.
     */
    private ready(): Promise<Crypto> {
        this.cryptoPromise ??= (async () => {
            const nodeCrypto = await getCrypto();
            this.nodeCrypto = nodeCrypto;
            const nodeWebCrypto = nodeCrypto?.webcrypto as unknown as Crypto | undefined;
            if(!isWebCryptoAvailable() && !nodeWebCrypto?.subtle){
                throw new Error("Lambder sessions need WebCrypto (crypto.subtle). In a browser that means a secure context (https or localhost); pass `crypto: new LambderPlainSessionCrypto()` where none is available and the store holds nothing worth hashing.");
            }
            return await resolveWebCrypto();
        })();
        return this.cryptoPromise;
    }

    async sha256Hex(value: string): Promise<string> {
        // ready() first, for the message above and for the warmed Node
        // crypto; the digest itself is the one every layer shares.
        await this.ready();
        return await sha256HexOf(value);
    }

    async randomHex(bytes: number): Promise<string> {
        const webCrypto = await this.ready();
        return bytesToHexString(webCrypto.getRandomValues(new Uint8Array(bytes)));
    }

    constantTimeEqual(a: string, b: string): boolean {
        // node's timingSafeEqual where the runtime has it: a primitive built
        // for this beats a JS loop the engine is free to optimize. The loop is
        // the fallback everywhere else, which is every browser.
        const nodeCrypto = this.nodeCrypto;
        if(nodeCrypto && a.length === b.length){
            const left = Buffer.from(a, "utf8");
            const right = Buffer.from(b, "utf8");
            if(left.length === right.length) return nodeCrypto.timingSafeEqual(left, right);
        }
        return constantTimeEqual(a, b);
    }
}

/**
 * No hashing and no cryptographic randomness: values are hex-encoded as
 * they are and secrets come from Math.random. Only for an in-memory store
 * in a runtime without WebCrypto; never for anything at rest.
 */
export class LambderPlainSessionCrypto implements LambderSessionCrypto {
    readonly isCryptographic = false;

    async sha256Hex(value: string): Promise<string> {
        return bytesToHexString(new TextEncoder().encode(value));
    }

    async randomHex(bytes: number): Promise<string> {
        const random = new Uint8Array(bytes);
        for(let i = 0; i < bytes; i += 1) random[i] = Math.floor(Math.random() * 256);
        return bytesToHexString(random);
    }

    constantTimeEqual(a: string, b: string): boolean {
        return constantTimeEqual(a, b);
    }
}

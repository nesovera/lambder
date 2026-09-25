/**
 * Build entry point (`import ... from "lambder/build"`).
 *
 * What a generator script runs at build time over the app's own instance to
 * write the signature file both sides ship. Node-only and imported by nothing
 * else in the package, so no deployment or bundle carries it.
 */

export { writeApiSignatures } from "./build/writeApiSignatures.js";
export type {
    LambderApiSignatureSource,
    LambderApiSignatureFileOptions,
    LambderApiSignatureFileResult,
} from "./build/writeApiSignatures.js";

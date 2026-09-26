/**
 * Build entry point (`import ... from "lambder/build"`).
 *
 * What a generator script runs at build time to write the files a deployment
 * ships: the signature file both sides read, from the app's own instance, and
 * the contract a client compiles against, from the server's sources. Node-only
 * and imported by nothing else in the package, so no deployment or bundle
 * carries it.
 */
export { writeApiSignatures } from "./build/writeApiSignatures.js";
export { writeApiContract } from "./build/writeApiContract.js";

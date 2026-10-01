/**
 * Build entry point (`import ... from "lambder/build"`).
 *
 * What a generator script runs at build time to write the files a deployment
 * ships: the signature file both sides read, the declared options as plain
 * data, and one guard's parameters as the least a browser needs of them, all
 * from the app's own instance; and the contract a client compiles against,
 * from the server's sources; generateApiFiles, every one of them for
 * every app a script names, in one call; and checkApiRefusals, every
 * refusal a handler can reach held to the codes it may send. Node-only and imported by nothing else
 * in the package, so no deployment or bundle carries it.
 */
export { writeApiSignatures } from "./build/writeApiSignatures.js";
export { writeApiContract } from "./build/writeApiContract.js";
export { writeApiOptions } from "./build/writeApiOptions.js";
export { writeApiGuardParams } from "./build/writeApiGuardParams.js";
export { checkApiRefusals } from "./build/checkApiRefusals.js";
export { generateApiFiles } from "./build/generateApiFiles.js";

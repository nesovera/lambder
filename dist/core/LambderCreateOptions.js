import { assertRefusalCodesDeclared, readRefusalVocabulary } from "../api/LambderApiRefusals.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
// ---------------------------------------------------------------------------
// Named maps: the guards and the rate-limit policies, each declared in one
// map or in a list of maps (one per part of an app), merged in order.
// ---------------------------------------------------------------------------
// The named-maps option (one map, or a list of them) lives with the shared
// utilities, since the refusal vocabulary takes it too; re-exported here,
// where its users import it.
export { mergeNamedMaps } from "../shared/util/LambderNamedMaps.js";
/**
 * Everything create() refuses before an instance exists, in one place: a
 * value that cannot work is a startup error naming the option, not a 404 on
 * every API call (an apiPath with no leading slash) or a 500 on every
 * response (maxResponseBytes: 0) that an app discovers in production.
 */
export const assertCreateOptions = (options) => {
    // The path is compared to ctx.path, which always starts with a slash, so
    // apiPath: "api" would make every API call a 404 with no reason given.
    if (options.apiPath !== undefined && (options.apiPath === "" || !options.apiPath.startsWith("/"))) {
        throw new Error(`Lambder: apiPath must be a path starting with "/", got ${JSON.stringify(options.apiPath)}.`);
    }
    // 0 or a negative ceiling would turn every response into the size guard's own 500.
    if (options.maxResponseBytes !== undefined)
        assertPositiveInteger(options.maxResponseBytes, "maxResponseBytes");
    // 0 or a negative bound would give up on every report before it started.
    if (options.crashes?.reportTimeoutMs !== undefined)
        assertPositiveInteger(options.crashes.reportTimeoutMs, "crashes.reportTimeoutMs");
    // Credentials with every origin allowed would echo whatever Origin asked,
    // so any website could read a signed-in user's session routes. The usual
    // reason to turn credentials on (SameSite=None cookies) is exactly the
    // setting in which that is reachable.
    const cors = options.cors;
    if (typeof cors === "object" && cors.credentials && (cors.origins === undefined || cors.origins === "*")) {
        throw new Error('Lambder: cors.credentials needs cors.origins to be an allowlist or a predicate. With every origin allowed, any website could make credentialed calls and read the answers.');
    }
    // The vocabulary, and every code a guard names against it: a guard built
    // by the standalone lambderGuard() meets the vocabulary here first.
    const vocabulary = readRefusalVocabulary(options.refusals);
    for (const [name, guard] of Object.entries(options.guards ?? {})) {
        assertRefusalCodesDeclared(`guard "${name}"`, (guard?.refusals ?? []), vocabulary);
    }
    if (options.requireRefusalCodes && !vocabulary) {
        throw new Error("Lambder: requireRefusalCodes needs a refusals vocabulary to name codes from; declare one with initLambder().declareRefusals().");
    }
    if (options.requireApiGuards && !options.guards) {
        throw new Error("Lambder: requireApiGuards needs a guards map at creation for APIs to declare from.");
    }
    if (options.originProof !== undefined)
        assertOriginProof(options);
    if (options.callSummary !== undefined && options.callSummary !== false && typeof options.callSummary !== "function") {
        throw new Error("Lambder: callSummary is false, or a function that receives each call's summary.");
    }
};
/** Shortest secret an origin proof takes: one a sender could guess is no proof. 32 characters of hex or base64 is 128 bits or more. */
export const MIN_ORIGIN_PROOF_SECRET_LENGTH = 32;
/** A header name as a proxy writes one. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
/**
 * An origin proof that proves something: a header name, secrets long enough
 * not to guess, and proxy headers that are header names. It needs no
 * trusted header to guard: ctx.arrivedVia is worth having on its own.
 */
const assertOriginProof = (options) => {
    const proof = options.originProof;
    if (typeof proof?.header !== "string" || !HEADER_NAME_PATTERN.test(proof.header)) {
        throw new Error("Lambder: originProof.header must be a header name, such as \"x-origin-proof\".");
    }
    if (!Array.isArray(proof.secrets) || proof.secrets.length === 0) {
        throw new Error("Lambder: originProof.secrets must list the secret the proxy sets, with the previous one beside it during a rotation.");
    }
    for (const secret of proof.secrets) {
        if (typeof secret !== "string" || secret.length < MIN_ORIGIN_PROOF_SECRET_LENGTH) {
            throw new Error(`Lambder: every originProof secret must be a string of at least ${MIN_ORIGIN_PROOF_SECRET_LENGTH} characters; a shorter one could be guessed, and a guessed proof proves nothing.`);
        }
    }
    const proxyHeaders = proof.proxyHeaders ?? [];
    if (!Array.isArray(proxyHeaders) || proxyHeaders.some((name) => typeof name !== "string" || !HEADER_NAME_PATTERN.test(name))) {
        throw new Error("Lambder: originProof.proxyHeaders must list header names the proxy writes, such as [\"cf-ipcountry\"].");
    }
    const proxyWritten = [...(options.trustedClientIpHeaders ?? []), ...(options.trustedHostHeaders ?? []), ...proxyHeaders];
    if (proxyWritten.some((name) => name.toLowerCase() === proof.header.toLowerCase())) {
        throw new Error(`Lambder: originProof.header "${proof.header}" is also a trusted or proxy header; the proof is its own header, which the app never reads.`);
    }
};

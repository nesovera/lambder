import { sha256HexOf } from "../util/LambderTextDigest.js";
/**
 * How many hex characters a key and a signature keep. This is change
 * detection, not authentication: 64 bits cannot collide by accident across
 * the shapes one endpoint takes over its life, and the map stays small.
 */
export const API_SIGNATURE_HEX_LENGTH = 16;
/** Domain-separated, so a name's key can never equal a signature computed over a description that happens to read the same. */
const API_NAME_KEY_PREFIX = "lambder-api-name:";
/** Memoized per name: a caller hashes each endpoint it calls once per process. */
const nameKeys = new Map();
/** The key an endpoint's signature is stored under: SHA-256 over the prefixed name, cut to API_SIGNATURE_HEX_LENGTH hex characters. */
export const apiNameKeyOf = (apiName) => {
    let pending = nameKeys.get(apiName);
    if (!pending) {
        pending = sha256HexOf(API_NAME_KEY_PREFIX + apiName).then((hex) => hex.slice(0, API_SIGNATURE_HEX_LENGTH));
        nameKeys.set(apiName, pending);
        // A failed digest (no WebCrypto) is not kept, so a later call in a
        // context that has it succeeds instead of replaying the rejection.
        pending.catch(() => nameKeys.delete(apiName));
    }
    return pending;
};
/** The map's signature for one endpoint, or null when the map holds none for it. */
export const lookupApiSignature = async (signatures, apiName) => {
    const key = await apiNameKeyOf(apiName);
    // Own properties only: the map is a plain object, and a key that happened
    // to spell a prototype member would otherwise read a function.
    const signature = Object.prototype.hasOwnProperty.call(signatures, key) ? signatures[key] : undefined;
    return typeof signature === "string" ? signature : null;
};
/**
 * The signature a caller sends for one endpoint. A name the map does not
 * hold throws: the map was generated from a server that did not have this
 * endpoint, so the file is stale, and a call sent without a signature would
 * run instead of saying so.
 */
export const readApiSignature = async (signatures, apiName) => {
    const signature = await lookupApiSignature(signatures, apiName);
    if (signature === null) {
        throw new Error(`Lambder: apiSignatures holds no signature for API "${apiName}". The map predates this endpoint; regenerate it from the server's apiSignatures().`);
    }
    return signature;
};

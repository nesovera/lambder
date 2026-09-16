import { sha256HexOf } from "../util/LambderTextDigest.js";
/**
 * How many hex characters a key and a signature keep. This is change
 * detection, not authentication: 64 bits cannot collide by accident across
 * the shapes one endpoint takes over its life, and the map stays small.
 */
export const API_SIGNATURE_HEX_LENGTH = 16;
/** Domain-separated, so a name's key can never equal a signature computed over a description that happens to read the same. */
const API_NAME_KEY_PREFIX = "lambder-api-name:";
/**
 * The key an endpoint's signature is stored under: SHA-256 over the prefixed
 * name, cut to API_SIGNATURE_HEX_LENGTH hex characters. Async because
 * WebCrypto's digest is, and it is the only SHA-256 a browser has.
 *
 * Computed on the spot, every time, and nothing is kept. The digest that
 * actually describes an endpoint is the generator's, computed once at build
 * time; what is left here is one hash of a short name against a map already
 * in memory, which is nothing beside the request it belongs to. A cache of
 * it would have to be keyed by name, and on the server the name comes off
 * the wire before anything has checked that it is an endpoint at all, so it
 * would grow by an entry for every name a request cared to invent and never
 * shrink.
 */
export const apiNameKeyOf = async (apiName) => (await sha256HexOf(API_NAME_KEY_PREFIX + apiName)).slice(0, API_SIGNATURE_HEX_LENGTH);
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

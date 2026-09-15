import { sha256HexOf } from "../util/LambderTextDigest.js";

/**
 * The per-endpoint signatures a client carries, generated from the server's
 * own registrations (Lambder.apiSignatures()) and shipped with the client
 * build. The key is the endpoint's name hashed (apiNameKeyOf); the value is
 * the digest of its client-facing shape (apiSignatureOf, computed on the
 * server side). A caller given the map sends the value with every call, and
 * the server answers versionExpired when it differs from the digest of what
 * it serves now. So a client built against an endpoint that has since
 * changed reloads, while one whose endpoint is unchanged keeps working
 * across deploys.
 *
 * Keys are hashed so the map lists no endpoint names: the names a client
 * calls are in its own code already, and the rest of the surface stays out
 * of the bundle.
 */
export type LambderApiSignatureMap = Record<string, string>;

/**
 * How many hex characters a key and a signature keep. This is change
 * detection, not authentication: 64 bits cannot collide by accident across
 * the shapes one endpoint takes over its life, and the map stays small.
 */
export const API_SIGNATURE_HEX_LENGTH = 16;

/** Domain-separated, so a name's key can never equal a signature computed over a description that happens to read the same. */
const API_NAME_KEY_PREFIX = "lambder-api-name:";

/** Memoized per name: a caller hashes each endpoint it calls once per process. */
const nameKeys = new Map<string, Promise<string>>();

/** The key an endpoint's signature is stored under: SHA-256 over the prefixed name, cut to API_SIGNATURE_HEX_LENGTH hex characters. */
export const apiNameKeyOf = (apiName: string): Promise<string> => {
    let pending = nameKeys.get(apiName);
    if(!pending){
        pending = sha256HexOf(API_NAME_KEY_PREFIX + apiName).then((hex) => hex.slice(0, API_SIGNATURE_HEX_LENGTH));
        nameKeys.set(apiName, pending);
        // A failed digest (no WebCrypto) is not kept, so a later call in a
        // context that has it succeeds instead of replaying the rejection.
        pending.catch(() => nameKeys.delete(apiName));
    }
    return pending;
};

/** The map's signature for one endpoint, or null when the map holds none for it. */
export const lookupApiSignature = async (signatures: LambderApiSignatureMap, apiName: string): Promise<string | null> => {
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
export const readApiSignature = async (signatures: LambderApiSignatureMap, apiName: string): Promise<string> => {
    const signature = await lookupApiSignature(signatures, apiName);
    if(signature === null){
        throw new Error(`Lambder: apiSignatures holds no signature for API "${apiName}". The map predates this endpoint; regenerate it from the server's apiSignatures().`);
    }
    return signature;
};

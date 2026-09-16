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
export declare const API_SIGNATURE_HEX_LENGTH = 16;
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
export declare const apiNameKeyOf: (apiName: string) => Promise<string>;
/** The map's signature for one endpoint, or null when the map holds none for it. */
export declare const lookupApiSignature: (signatures: LambderApiSignatureMap, apiName: string) => Promise<string | null>;
/**
 * The signature a caller sends for one endpoint. A name the map does not
 * hold throws: the map was generated from a server that did not have this
 * endpoint, so the file is stale, and a call sent without a signature would
 * run instead of saying so.
 */
export declare const readApiSignature: (signatures: LambderApiSignatureMap, apiName: string) => Promise<string>;

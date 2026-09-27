import type { z } from "zod";
import { sha256HexOf } from "../util/LambderTextDigest.js";

/**
 * The per-endpoint signatures a client carries, generated from the server's
 * own registrations (Lambder.apiSignatures()) and shipped with the client
 * build. The key is the endpoint's name hashed (apiNameKeyOf); the value is
 * the digest of its client-facing shape (apiSignatureOf, computed on the
 * server side). A caller given the map sends the value with every call, and
 * the server answers versionExpired when it differs from the digest of what
 * it serves, so a client reloads only when an endpoint it calls has changed
 * and otherwise keeps working across deploys.
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

/**
 * The key an endpoint's signature is stored under: SHA-256 over the prefixed
 * name, cut to API_SIGNATURE_HEX_LENGTH hex characters. Async because
 * WebCrypto's digest is, and it is the only SHA-256 a browser has.
 *
 * Computed on the spot every time, with nothing kept. The digest that
 * describes an endpoint is the generator's, computed once at build time;
 * this is one hash of a short name, nothing beside the request it belongs
 * to. A cache would be keyed by name, and on the server the name comes off
 * the wire before anything checks that it is an endpoint, so the cache would
 * gain an entry for every name a request cared to invent and never shrink.
 */
export const apiNameKeyOf = async (apiName: string): Promise<string> =>
    (await sha256HexOf(API_NAME_KEY_PREFIX + apiName)).slice(0, API_SIGNATURE_HEX_LENGTH);

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

/**
 * The metadata key extensibleEnum() sets and the digest reads. Namespaced,
 * because zod writes metadata into the JSON Schema it emits, so the key shows
 * up in any schema an app converts for itself, where OpenAPI's own
 * `x-extensible-enum` means something else (the values, in place of `enum`).
 */
export const EXTENSIBLE_ENUM_META_KEY = "x-lambder-extensible-enum";

/**
 * Marks an enum whose clients tolerate a value they were not built with, so
 * its list of values stays out of the signature of every endpoint that
 * returns it. Adding a role, a status or a locale to a list that rides in a
 * widely returned payload (a session, a profile) then reloads only the
 * clients that send the list back, not every client that reads it.
 *
 * Where the enum is input its values still count: an older client may still
 * send a value dropped from the list, which the server would refuse, so that
 * endpoint's clients must reload. Everything else about the schema is
 * untouched: its type, its validation on both sides, and what it is outside
 * the digest.
 *
 * The mark is a promise the schema makes for its readers, and nothing checks
 * it. A client that switches over every value with no fallback, or indexes a
 * map by one, renders an unknown value as nothing, or throws. Mark only a
 * list whose every reader handles an unknown value on purpose.
 *
 * It is zod metadata (`.meta()`), which zod keeps in one registry on
 * globalThis, so an enum marked in a shared package is read by the digest
 * even when the server resolves another copy of zod. A schema rebuilt from a
 * marked enum (`z.enum(marked.options)`, `.exclude()`) carries no mark and
 * counts in full, which costs a reload, never a missed one.
 *
 * @example
 * export const RoleSchema = extensibleEnum(z.enum(["admin", "member"]));
 */
export const extensibleEnum = <TSchema extends z.ZodEnum>(schema: TSchema): TSchema =>
    schema.meta({ [EXTENSIBLE_ENUM_META_KEY]: true });

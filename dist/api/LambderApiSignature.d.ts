import type { LambderApiDefinition } from "./LambderApiDefinition.js";
import { type LambderApiGuard } from "./LambderApiGuards.js";
/**
 * One endpoint as the generator sees it: the map key, the signature, and the
 * name both were computed from. The shipped map deliberately omits the name,
 * so this build-time view is the only place a generated map can be diffed by
 * endpoint rather than by opaque key.
 */
export type LambderApiSignatureEntry = {
    name: string;
    /** The map key: apiNameKeyOf(name). */
    key: string;
    signature: string;
};
/**
 * The digest of an endpoint's client-facing shape: its name and mode, its
 * input and output schemas as JSON Schema, every guard it declares with the
 * schema that guard validates (the guardInput the client sends separately,
 * or the apiInput slice of the payload), whether it demands an idempotency
 * key, and every refusal code it may send with its data's schema, its status
 * and its flags. Anything else (rate limits, a guard's parameter, the
 * handler) changes nothing for a client and is left out, so changing it
 * never forces a reload.
 *
 * The refusal codes count in full: a client's refusal type lists exactly the
 * codes the endpoint declares, so one built before a code was added would be
 * handed a code its types say cannot arrive. Adding a code, or changing a
 * code's data, reloads that endpoint's clients. A code's data is received,
 * so it is digested in the output position, where an extensibleEnum's values
 * leave the digest. Its status and flags count too: a caller reads the one
 * and routes on the others.
 *
 * Schemas are hashed as built, descriptions and titles included, so a client
 * built against a different one reloads once. The exception is an output
 * extensibleEnum()'s values (see keepShapeOnly). Schemas must be built from
 * static values: one that reads the clock, a random source or the
 * environment at construction digests differently in the generator's process
 * and on the server.
 */
export declare const apiSignatureOf: (definition: LambderApiDefinition, guards: Record<string, LambderApiGuard<any, any, any>> | undefined) => Promise<string>;

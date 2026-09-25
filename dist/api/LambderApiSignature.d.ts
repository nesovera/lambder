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
 * or the apiInput slice of the payload), and whether it demands an
 * idempotency key. Anything else (rate limits, a guard's parameter, the
 * handler) changes nothing for a client and is left out, so changing it never
 * forces a reload.
 *
 * Schemas are hashed as built, descriptions and titles included, so a client
 * built against a different one reloads once. The exception is an output
 * extensibleEnum()'s values (see keepShapeOnly). Schemas must be built from
 * static values: one that reads the clock, a random source or the
 * environment at construction digests differently in the generator's process
 * and on the server.
 */
export declare const apiSignatureOf: (definition: LambderApiDefinition, guards: Record<string, LambderApiGuard<any, any, any>> | undefined) => Promise<string>;

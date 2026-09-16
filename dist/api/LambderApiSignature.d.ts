import type { LambderApiDefinition } from "./LambderApiDefinition.js";
import { type LambderApiGuard } from "./LambderApiGuards.js";
/**
 * The digest of an endpoint's client-facing shape: its name and mode, its
 * input and output schemas as JSON Schema, every guard it declares with the
 * schema that guard validates (the guardInput the client sends separately,
 * or the apiInput slice of the payload), and whether it demands an
 * idempotency key. Anything else about the endpoint (its rate limits, a
 * guard's parameter, the handler) changes nothing for a client and is left
 * out, so changing it never forces a reload.
 *
 * The description is hashed as built, descriptions and titles included: a
 * schema is what the server says it is, and a client built against a
 * different one reloads once. What must hold for the digest to mean anything
 * is that a schema is built from static values: one that reads the clock, a
 * random source or the environment at construction digests differently in
 * the generator's process and on the server.
 */
export declare const apiSignatureOf: (definition: LambderApiDefinition, guards: Record<string, LambderApiGuard<any, any, any>> | undefined) => Promise<string>;

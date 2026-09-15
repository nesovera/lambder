import type { LambderApiDefinition } from "./LambderApiDefinition.js";
import { type LambderApiGuard } from "./LambderApiGuards.js";
/**
 * Where the pipeline asks what signature a request should carry. Null for
 * an endpoint the source does not know, so a signed call for a name the
 * server does not have is answered versionExpired rather than apiNotFound:
 * the client was built against a contract that had it. The server answers
 * from its own schemas (LambderApiSignatureDigests); the mock runtime, which
 * holds no server schema, answers from the generated map when given one.
 */
export type LambderApiSignatureSource = {
    expectedSignatureOf(apiName: string, definition: LambderApiDefinition | null): Promise<string | null>;
};
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
 * different one reloads once.
 */
export declare const apiSignatureOf: (definition: LambderApiDefinition, guards: Record<string, LambderApiGuard<any, any, any>> | undefined) => Promise<string>;
/**
 * The server's signature source: every registered endpoint digested from
 * its own schemas, once per endpoint per container, on first use. What
 * Lambder.apiSignatures() reads to build the client's map, and what the
 * pipeline compares a request's signature against.
 */
export declare class LambderApiSignatureDigests implements LambderApiSignatureSource {
    private readonly guards;
    private readonly digests;
    constructor(guards: Record<string, LambderApiGuard<any, any, any>> | undefined);
    /** The endpoint's signature, computed on the first ask and kept. A digest that failed is not kept, so the next call tries again rather than failing forever. */
    signatureOf(definition: LambderApiDefinition): Promise<string>;
    expectedSignatureOf(apiName: string, definition: LambderApiDefinition | null): Promise<string | null>;
}

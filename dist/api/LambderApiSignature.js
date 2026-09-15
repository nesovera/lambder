import { z } from "zod";
import { toGuardEntries } from "./LambderApiGuards.js";
import { API_SIGNATURE_HEX_LENGTH } from "../shared/wire/LambderApiSignature.js";
import { sha256HexOf } from "../shared/util/LambderTextDigest.js";
/**
 * JSON with object keys sorted at every level, so two descriptions of the
 * same shape hash the same whatever order they were built in. Arrays keep
 * their order: a tuple's positions and an enum's values are part of the
 * shape. Undefined entries are dropped, as JSON.stringify would drop them.
 */
const canonicalJson = (value) => JSON.stringify(sortKeys(value));
const sortKeys = (value) => {
    if (Array.isArray(value))
        return value.map(sortKeys);
    if (value === null || typeof value !== "object")
        return value;
    const source = value;
    const sorted = {};
    for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined)
            sorted[key] = sortKeys(source[key]);
    }
    return sorted;
};
/**
 * A schema as JSON Schema, exactly as zod emits it. A type JSON Schema
 * cannot express (a transform's output, a custom check) becomes `{}` rather
 * than throwing, because a digest has to exist for every endpoint; what the
 * digest cannot see is documented with it.
 */
const jsonSchemaOf = (schema, io) => schema ? z.toJSONSchema(schema, { io, unrepresentable: "any" }) : null;
const ownGuard = (guards, name) => guards !== undefined && Object.prototype.hasOwnProperty.call(guards, name) ? guards[name] : undefined;
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
export const apiSignatureOf = async (definition, guards) => {
    const guardShapes = toGuardEntries(definition.guards).map(({ name }) => {
        const guard = ownGuard(guards, name);
        return [name, {
                apiInput: jsonSchemaOf(guard?.apiInput, "input"),
                guardInput: jsonSchemaOf(guard?.guardInput, "input"),
            }];
    });
    guardShapes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const description = {
        name: definition.name,
        mode: definition.mode,
        input: jsonSchemaOf(definition.input, "input"),
        output: jsonSchemaOf(definition.output, "output"),
        guards: guardShapes,
        idempotency: definition.idempotency !== undefined && definition.idempotency !== false,
    };
    const hex = await sha256HexOf(canonicalJson(description));
    return hex.slice(0, API_SIGNATURE_HEX_LENGTH);
};
/**
 * The server's signature source: every registered endpoint digested from
 * its own schemas, once per endpoint per container, on first use. What
 * Lambder.apiSignatures() reads to build the client's map, and what the
 * pipeline compares a request's signature against.
 */
export class LambderApiSignatureDigests {
    guards;
    digests = new Map();
    constructor(guards) {
        this.guards = guards;
    }
    /** The endpoint's signature, computed on the first ask and kept. A digest that failed is not kept, so the next call tries again rather than failing forever. */
    signatureOf(definition) {
        let pending = this.digests.get(definition.name);
        if (!pending) {
            pending = apiSignatureOf(definition, this.guards);
            this.digests.set(definition.name, pending);
            pending.catch(() => this.digests.delete(definition.name));
        }
        return pending;
    }
    async expectedSignatureOf(apiName, definition) {
        return definition ? await this.signatureOf(definition) : null;
    }
}

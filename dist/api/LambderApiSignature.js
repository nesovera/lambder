import { z } from "zod";
import { toGuardEntries } from "./LambderApiGuards.js";
import { API_SIGNATURE_HEX_LENGTH, EXTENSIBLE_ENUM_META_KEY } from "../shared/wire/LambderApiSignature.js";
import { sha256HexOf } from "../shared/util/LambderTextDigest.js";
/*
 * The digest of an endpoint's client-facing shape, computed once, by the
 * generator, through Lambder.apiSignatures(). Nothing digests at request
 * time: the server and the client both carry the generated map and the
 * pipeline compares entries, so the one computation has nothing to agree
 * with but itself. See LambderApiSignatureMap.
 */
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
 * Three edits to every node zod emits, before it is hashed.
 *
 * The `default` keyword goes. Its value is server behaviour, not shape: a
 * client never sends it, and its compiled types do not carry it. And for a
 * function default (`.default(() => new Date())`, `.prefault`, `.catch`)
 * zod writes whatever the function returned at conversion time, a clock
 * reading or a random value, which would give the endpoint a different
 * digest on every computation and a generated map that never matches the
 * server. Nothing distinguishes such a default from a constant one once zod
 * has evaluated it, so every default goes, and the one thing about a default
 * a client can see, that the field may be omitted, stays through `required`.
 *
 * `required` is sorted. It is a set, and the order fields are declared in is
 * not shape either; left as emitted, reordering two fields forced a reload.
 *
 * An enum marked with extensibleEnum() loses its values in an output. Its
 * clients tolerate a value they do not know, so a response carrying one they
 * were not built with, or no longer carrying one they were, changes nothing
 * they can see; the node still says it holds a string. In an input the values
 * stay, since a value dropped from the list is a request an older client may
 * still send and the server now refuses. The mark itself goes in both, so
 * marking an enum changes no input's digest.
 */
const keepShapeOnly = (node, io) => {
    delete node.default;
    if (Array.isArray(node.required))
        node.required.sort();
    if (node[EXTENSIBLE_ENUM_META_KEY] === true) {
        delete node[EXTENSIBLE_ENUM_META_KEY];
        if (io === "output")
            delete node.enum;
    }
};
/**
 * A schema as JSON Schema, as zod emits it minus what keepShapeOnly removes.
 * A type JSON Schema cannot express (a transform's output, a custom check)
 * becomes `{}` rather than throwing, because a digest has to exist for every
 * endpoint; what the digest cannot see is documented with it.
 */
const jsonSchemaOf = (schema, io) => schema ? z.toJSONSchema(schema, { io, unrepresentable: "any", override: ({ jsonSchema }) => keepShapeOnly(jsonSchema, io) }) : null;
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
 * different one reloads once, with one exception the schema declares itself:
 * the values of an extensibleEnum() in an output (see keepShapeOnly). What
 * must hold for the digest to mean anything is that a schema is built from
 * static values: one that reads the clock, a random source or the environment
 * at construction digests differently in the generator's process and on the
 * server.
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

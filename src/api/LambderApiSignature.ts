import { z } from "zod";
import type { LambderApiDefinition } from "./LambderApiDefinition.js";
import { toGuardEntries, type LambderApiGuard } from "./LambderApiGuards.js";
import { API_SIGNATURE_HEX_LENGTH, EXTENSIBLE_ENUM_META_KEY } from "../shared/wire/LambderApiSignature.js";
import { sha256HexOf } from "../shared/util/LambderTextDigest.js";
import { canonicalJson } from "../shared/util/canonicalJson.js";

/*
 * The digest of an endpoint's client-facing shape, computed once, by the
 * generator, through Lambder.apiSignatures(). Nothing digests at request
 * time: server and client both carry the generated map and the pipeline
 * compares entries, so there is no second computation to disagree with.
 * See LambderApiSignatureMap.
 */

/**
 * Three edits to every node zod emits, before it is hashed.
 *
 * The `default` keyword goes. Its value is server behaviour, not shape: a
 * client never sends it. For a function default (`.default(() => new
 * Date())`, `.prefault`, `.catch`) zod writes whatever the function returned
 * at conversion time, a clock reading or a random value, so the digest would
 * differ on every computation and the generated map would never match the
 * server. Once evaluated, such a default looks like a constant one, so every
 * default goes; what a client can see of it, that the field may be omitted,
 * stays through `required`.
 *
 * `required` is sorted: it is a set, and declaration order is not shape.
 * Left as emitted, reordering two fields would force a reload.
 *
 * An enum marked with extensibleEnum() loses its values in an output: its
 * clients tolerate unknown values, so adding or removing one changes nothing
 * they can see, and the node still says it holds a string. In an input the
 * values stay, since a value dropped from the list is one an older client
 * may still send and the server would refuse. The mark itself goes in both,
 * so marking an enum changes no input's digest.
 */
const keepShapeOnly = (
    node: { default?: unknown; required?: string[]; enum?: unknown[]; [EXTENSIBLE_ENUM_META_KEY]?: unknown },
    io: "input" | "output",
): void => {
    delete node.default;
    if(Array.isArray(node.required)) node.required.sort();
    if(node[EXTENSIBLE_ENUM_META_KEY] === true){
        delete node[EXTENSIBLE_ENUM_META_KEY];
        if(io === "output") delete node.enum;
    }
};

/**
 * A schema as JSON Schema, as zod emits it minus what keepShapeOnly removes.
 * A type JSON Schema cannot express (a transform's output, a custom check)
 * becomes `{}` rather than throwing, because a digest has to exist for every
 * endpoint; what the digest cannot see is documented with it.
 */
const jsonSchemaOf = (schema: z.ZodType | undefined, io: "input" | "output"): unknown =>
    schema ? z.toJSONSchema(schema, { io, unrepresentable: "any", override: ({ jsonSchema }) => keepShapeOnly(jsonSchema, io) }) : null;

const ownGuard = (guards: Record<string, LambderApiGuard<any, any, any>> | undefined, name: string): LambderApiGuard<any, any, any> | undefined =>
    guards !== undefined && Object.prototype.hasOwnProperty.call(guards, name) ? guards[name] : undefined;

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
export const apiSignatureOf = async (
    definition: LambderApiDefinition,
    guards: Record<string, LambderApiGuard<any, any, any>> | undefined,
): Promise<string> => {
    const guardShapes: [string, unknown][] = toGuardEntries(definition.guards).map(({ name }) => {
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

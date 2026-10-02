import { z } from "zod";
import { LambderApiOutputValidationError } from "../api/LambderApiOutputValidationError.js";
import { LAMBDER_STRIP_UNKNOWN_KEYS, type LambderApiSchemaEntries, type LambderJsonSchema } from "../shared/wire/LambderApiSchemaEntries.js";

/*
 * The server's schemas as the mock runs them: the generated module's JSON
 * Schema (writeApiSchemas) rebuilt into zod with z.fromJSONSchema, each on
 * the first call that needs it and once, so a mock of a few hundred endpoints
 * rebuilds only what a session reaches.
 *
 * z.fromJSONSchema keeps every key an object does not declare, as JSON Schema
 * allows them and has no word for dropping one, where the server's z.object
 * drops them. The writer marks each object that drops them
 * (LAMBDER_STRIP_UNKNOWN_KEYS), and the rebuilt schema is walked once to make
 * each marked object drop them too. So a handler reads, and a caller
 * receives, exactly the keys the server's parse leaves; a strict object still
 * refuses other keys and a loose one still keeps them.
 */

/** The fields of a zod definition the walk reads: those of every container z.fromJSONSchema builds. */
type WalkedDef = {
    type: string;
    shape?: Record<string, z.ZodType>;
    catchall?: z.ZodType;
    element?: z.ZodType;
    items?: readonly z.ZodType[];
    rest?: z.ZodType | null;
    options?: readonly z.ZodType[];
    left?: z.ZodType;
    right?: z.ZodType;
    keyType?: z.ZodType;
    valueType?: z.ZodType;
    in?: z.ZodType;
    out?: z.ZodType;
    innerType?: z.ZodType;
    getter?: () => z.ZodType;
};

/** The schemas z.fromJSONSchema builds that hold no other schema: nothing in them to walk. */
const LEAF_TYPES = new Set(["string", "number", "boolean", "null", "any", "unknown", "never", "literal", "enum", "transform"]);

/**
 * The schema with its definition changed, built the way zod builds a copy
 * (clone). The definition is copied with its accessors, so what zod computes
 * on each read (a default's value, copied fresh for every parse) is still
 * computed on each read.
 */
const cloneWith = (schema: z.ZodType, changes: Partial<WalkedDef>): z.ZodType => {
    const def = Object.defineProperties({}, Object.getOwnPropertyDescriptors(schema._zod.def));
    for(const [key, value] of Object.entries(changes)){
        Object.defineProperty(def, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return schema.clone(def as never);
};

/**
 * A schema z.fromJSONSchema built, with every object the writer marked made
 * to drop the keys it does not declare. `marks` is the registry the build
 * recorded the marks in: fromJSONSchema files a keyword it does not read as
 * metadata of the schema it built for that node, which for an object with a
 * default, a readOnly or key rules is the wrapper around the object, so the
 * mark is carried down to the object inside.
 */
const withStrippedObjects = (built: z.ZodType, marks: z.core.$ZodRegistry<Record<string, unknown>>): z.ZodType => {
    const walked = new Map<z.ZodType, z.ZodType>();
    const walk = (schema: z.ZodType, stripFromWrapper = false): z.ZodType => {
        const strip = stripFromWrapper || marks.get(schema)?.[LAMBDER_STRIP_UNKNOWN_KEYS] === true;
        // A schema met again (a $ref, a recursive one through z.lazy) is the
        // same walked schema; one the mark reached from its wrapper is met
        // only through that wrapper.
        const known = stripFromWrapper ? undefined : walked.get(schema);
        if(known) return known;
        const def = schema._zod.def as unknown as WalkedDef;
        let result: z.ZodType;
        switch(def.type){
            case "object": {
                const shape = Object.fromEntries(Object.entries(def.shape!).map(([key, field]) => [key, walk(field)]));
                result = cloneWith(schema, { shape, catchall: strip ? undefined : def.catchall && walk(def.catchall) });
                break;
            }
            case "default":
            case "readonly":
                result = cloneWith(schema, { innerType: walk(def.innerType!, strip) });
                break;
            case "pipe":
                // Key rules (propertyNames, min and max properties) run on
                // the raw object ahead of the object itself.
                result = cloneWith(schema, { in: walk(def.in!), out: walk(def.out!, strip) });
                break;
            default:
                if(strip) throw new Error(`LambderMockApp: a "${def.type}" schema is marked to drop unknown keys, which only an object can. The apiSchemas table was not written by writeApiSchemas: regenerate it.`);
                result = walkContainer(schema, def);
        }
        if(!stripFromWrapper) walked.set(schema, result);
        return result;
    };
    const walkContainer = (schema: z.ZodType, def: WalkedDef): z.ZodType => {
        switch(def.type){
            case "array": return cloneWith(schema, { element: walk(def.element!) });
            case "tuple": return cloneWith(schema, { items: def.items!.map((item) => walk(item)), rest: def.rest ? walk(def.rest) : def.rest });
            case "union": return cloneWith(schema, { options: def.options!.map((option) => walk(option)) });
            case "intersection": return cloneWith(schema, { left: walk(def.left!), right: walk(def.right!) });
            case "record": return cloneWith(schema, { keyType: walk(def.keyType!), valueType: walk(def.valueType!) });
            case "optional":
            case "nullable": return cloneWith(schema, { innerType: walk(def.innerType!) });
            case "lazy": return z.lazy(() => walk(def.getter!()));
            default:
                if(LEAF_TYPES.has(def.type)) return schema;
                throw new Error(`LambderMockApp: z.fromJSONSchema built a "${def.type}" schema, which the mock cannot carry the server's unknown-key handling through. The installed zod builds what this version of lambder does not know.`);
        }
    };
    return walk(built);
};

/** One written schema as zod: rebuilt, then made to drop unknown keys where the server's does. */
const rebuildSchema = (written: LambderJsonSchema): z.ZodType => {
    // A registry of its own, so the marks never reach zod's global registry,
    // which the app's own z.toJSONSchema calls read.
    const marks = z.registry<Record<string, unknown>>();
    const built = z.fromJSONSchema(written as z.core.JSONSchema.JSONSchema, { defaultTarget: "draft-2020-12", registry: marks });
    return withStrippedObjects(built, marks);
};

/**
 * The generated `apiSchemas` table, as the schemas the mock validates every
 * call's input with and parses every answer through.
 */
export class LambderMockApiSchemas {
    private readonly rebuilt = new Map<string, z.ZodType>();

    constructor(private readonly table: LambderApiSchemaEntries){}

    /**
     * The schema an entry's input is validated with, as the pipeline takes it
     * at registration: lazy, so it is rebuilt on the first call that reaches
     * it. A name the table does not hold throws here, when the entry is
     * registered, rather than on its first call.
     */
    inputOf(apiName: string): z.ZodType {
        this.assertHeld(apiName);
        return z.lazy(() => this.rebuiltSchema(apiName, "input"));
    }

    /**
     * An answer a handler returned, parsed through the server's output schema
     * as the server parses its own: what the schema does not declare dropped,
     * its defaults filled. What it rejects, or a parse that throws, is the
     * handler breaking its contract, the error the server crashes with.
     */
    parseOutput(apiName: string, returned: unknown): unknown {
        const output = this.rebuiltSchema(apiName, "output");
        let parsed: z.ZodSafeParseResult<unknown>;
        try {
            parsed = output.safeParse(returned);
        } catch(thrown) {
            throw new LambderApiOutputValidationError(apiName, { thrown });
        }
        if(!parsed.success) throw new LambderApiOutputValidationError(apiName, { zodError: parsed.error });
        return parsed.data;
    }

    private assertHeld(apiName: string): void {
        if(!Object.prototype.hasOwnProperty.call(this.table, apiName)){
            throw new Error(`LambderMockApp: "${apiName}" has no entry in the apiSchemas table given to create(). The table predates this endpoint: regenerate it with writeApiSchemas.`);
        }
    }

    /** One of an API's schemas, rebuilt the first time it is asked for and kept. */
    private rebuiltSchema(apiName: string, direction: "input" | "output"): z.ZodType {
        const key = `${direction} ${apiName}`;
        const known = this.rebuilt.get(key);
        if(known) return known;
        this.assertHeld(apiName);
        let schema: z.ZodType;
        try {
            schema = rebuildSchema(this.table[apiName]![direction]);
        } catch(err) {
            throw new Error(`LambderMockApp: the ${direction} schema of "${apiName}" in the apiSchemas table could not be rebuilt.`, { cause: err });
        }
        this.rebuilt.set(key, schema);
        return schema;
    }
}

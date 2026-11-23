import { assertPlainData } from "../shared/util/assertPlainData.js";
/** The facts of an endpoint that states none, on an app that declares none. */
export const NO_API_FACTS = Object.freeze(Object.create(null));
const isPlainObject = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};
/**
 * A facts vocabulary, checked: an object schema declaring at least one fact,
 * none of which could be absent (see LambderApiFactsSchemaCheck). Read for
 * what it is used as rather than by class, so a schema from a second copy of
 * zod in the bundle still counts. `where` names the call that took it, for
 * the error.
 */
export const readApiFactsSchema = (schema, where) => {
    const candidate = schema;
    if (typeof candidate?.safeParse !== "function" || !isPlainObject(candidate.shape)) {
        throw new Error(`Lambder: ${where} takes the API facts as an object schema, one key per fact: z.object({ ... }).`);
    }
    if (Object.keys(candidate.shape).length === 0) {
        throw new Error(`Lambder: ${where} was given an object schema with no keys, which declares no fact. Name the facts endpoints state, or leave it out.`);
    }
    for (const [name, fact] of Object.entries(candidate.shape)) {
        let absent;
        try {
            absent = fact.safeParse(undefined);
        }
        catch {
            // Not a schema this can ask (an async check, say): an endpoint's
            // own facts meet it at registration, which says so by name.
            continue;
        }
        if (absent.success && absent.data === undefined) {
            throw new Error(`Lambder: ${where} declares the fact "${name}", which could be absent: an endpoint that says nothing would state no value for it. Give it a default, or make it nullable with a default of null, so every call reads a value.`);
        }
    }
    return schema;
};
/** The facts a vocabulary declares, by name; none for no vocabulary. */
export const apiFactNamesOf = (schema) => schema ? Object.keys(schema.shape) : [];
/** Frozen all the way down: one object answers every call of its endpoint, so nothing a handler does to it may reach the next call. */
const deepFreeze = (value) => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const member of Object.values(value))
            deepFreeze(member);
    }
    return value;
};
/** One vocabulary's facts out of what an endpoint wrote, parsed: defaults filled in, a missing or mistyped fact refused by name. */
const parseFacts = (apiName, schema, given) => {
    const slice = {};
    for (const name of Object.keys(schema.shape)) {
        if (Object.prototype.hasOwnProperty.call(given, name))
            slice[name] = given[name];
    }
    let parsed;
    try {
        parsed = schema.safeParse(slice);
    }
    catch (thrown) {
        // An async refinement makes a synchronous parse throw. Facts are read
        // at registration, which is synchronous, and are data, not lookups.
        throw new Error(`Lambder: the facts of API "${apiName}" could not be parsed synchronously (${thrown instanceof Error ? thrown.message : String(thrown)}). A facts schema holds plain values and no async check.`);
    }
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "facts"}: ${issue.message}`).join("; ");
        throw new Error(`Lambder: API "${apiName}" states facts its vocabulary refuses (${issues}).`);
    }
    return parsed.data;
};
/**
 * One endpoint's facts as every call of it reads them: what it wrote, held
 * to the app's vocabulary and its module's own, defaults filled in, frozen.
 * Refused, by endpoint and fact name: a fact neither vocabulary declares, a
 * fact stated where no vocabulary exists, a value its schema refuses, a fact
 * without a default left out, and a value that is not plain data, since the
 * facts are written into the generated options as the data they are.
 */
export const resolveApiFacts = (apiName, given, instanceSchema, moduleSchema) => {
    if (given !== undefined && !isPlainObject(given)) {
        throw new Error(`Lambder: API "${apiName}" has a facts option that is not an object of facts by name.`);
    }
    if (!instanceSchema && !moduleSchema) {
        if (given !== undefined) {
            throw new Error(`Lambder: API "${apiName}" states facts, and no API facts were declared. Declare the app's on the init with declareApiFacts(), or a module's own with defineApiModule().`);
        }
        return NO_API_FACTS;
    }
    const written = given ?? {};
    const declared = new Set([...apiFactNamesOf(instanceSchema), ...apiFactNamesOf(moduleSchema)]);
    const unknown = Object.keys(written).filter((name) => !declared.has(name));
    if (unknown.length) {
        throw new Error(`Lambder: API "${apiName}" states ${unknown.map((name) => `"${name}"`).join(", ")}, which no API facts vocabulary it is declared under holds. A fact is declared before it is stated.`);
    }
    const resolved = Object.create(null);
    for (const schema of [instanceSchema, moduleSchema]) {
        if (schema)
            Object.assign(resolved, parseFacts(apiName, schema, written));
    }
    assertPlainData({ ...resolved }, `the facts of API "${apiName}"`);
    return deepFreeze(resolved);
};

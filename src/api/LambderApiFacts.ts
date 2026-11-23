import type { z } from "zod";

import { assertPlainData } from "../shared/util/assertPlainData.js";

// -----------------------------------------------------------------------------
// API facts: what an endpoint states about itself beside what it takes and
// answers, in a vocabulary the app declares once. A fact is plain data (a
// flag, a label, a list), written where the endpoint is declared and read by
// whatever decides something with it: a guard, off the call's context; a
// test, a mock or a client, off the generated options. The framework gives
// no fact a meaning of its own.
//
// The vocabulary is an object schema. An app declares it on its init
// (declareApiFacts), so the guards built from that init read the facts typed
// before any instance exists; a module declares facts of its own for its own
// endpoints (defineApiModule). A fact whose schema has a default may be left
// out, and one without has to be stated by every endpoint; either way every
// call reads every fact, so a vocabulary may not hold one that could be
// absent (an optional with no default).
// -----------------------------------------------------------------------------

/** A vocabulary of API facts: an object schema, each key one fact. */
export type LambderApiFactsSchema = z.ZodObject;

/**
 * The facts an app's endpoints state, as its types carry them: `given` is
 * what an endpoint writes (a fact with a default may be left out), `resolved`
 * what the call's context holds (every fact, defaults filled in).
 */
export type LambderApiFactsTypes = { given: object; resolved: object };

/** The facts of an app that declares none. */
export type LambderNoApiFacts = { given: {}; resolved: {} };

/** The facts one schema declares; none for an init that declared no schema. */
export type LambderApiFactsOf<TSchema> =
    TSchema extends z.ZodType ? { given: z.input<TSchema>; resolved: z.output<TSchema> } : LambderNoApiFacts;

/** An app's facts with a module's own beside them; the app's alone for a module that declares none. */
export type LambderApiFactsWith<TFacts extends LambderApiFactsTypes, TSchema> =
    TSchema extends z.ZodType
        ? { given: TFacts["given"] & z.input<TSchema>; resolved: TFacts["resolved"] & z.output<TSchema> }
        : TFacts;

/**
 * A facts vocabulary held to every fact being present on every call:
 * intersected onto what declareApiFacts() and a module's apiFacts take. A
 * fact that could be absent (an optional with no default) would read as
 * undefined on an endpoint that said nothing, and a guard deciding by it
 * would decide by a value nobody stated. The property name is the message
 * and its value the facts at fault.
 */
export type LambderApiFactsSchemaCheck<TSchema> =
    TSchema extends z.ZodType
        ? { [TName in keyof z.output<TSchema>]-?: undefined extends z.output<TSchema>[TName] ? TName : never }[keyof z.output<TSchema>] extends infer TAbsent
            ? ([TAbsent] extends [never]
                ? unknown
                : { readonly "lambder: these API facts could be absent. Give each a default, or make it nullable with a default of null, so every call reads a value.": TAbsent })
            : never
        : unknown;

/** What the `facts` field asks for on an instance that declares none: the property name is the message. */
type LambderNoApiFactsDeclared = {
    readonly "lambder: this app declares no API facts. Declare them on the init with declareApiFacts(), or a module's own with defineApiModule().": never;
};

/**
 * The `facts` field of an endpoint's options: refused where the app declares
 * no facts, optional where every declared fact has a default, and required
 * where one does not, so a fact every endpoint has to state cannot be
 * forgotten.
 */
export type LambderApiFactsField<TFacts extends LambderApiFactsTypes> =
    [keyof TFacts["given"]] extends [never] ? {
        /** This app declares no API facts, so an endpoint states none. */
        facts?: LambderNoApiFactsDeclared;
    }
    : {} extends TFacts["given"] ? {
        /** What this endpoint states about itself, in the vocabulary the app declared (declareApiFacts) and its module's own: plain data, parsed once at registration, read as `ctx.apiFacts` and written into the generated options. A fact left out takes its default. */
        facts?: TFacts["given"];
    }
    : {
        /** What this endpoint states about itself, in the vocabulary the app declared (declareApiFacts) and its module's own: plain data, parsed once at registration, read as `ctx.apiFacts` and written into the generated options. Required here: a declared fact has no default, so every endpoint states it. */
        facts: TFacts["given"];
    };

/**
 * What a context typed to an app's facts adds to the call's context: the
 * facts of the endpoint being called, every one present. Intersected onto
 * the context a guard built from a facts-bound init is handed, and onto an
 * endpoint handler's.
 */
export type LambderApiFactsContext<TResolved> = { readonly apiFacts: Readonly<TResolved> };

/** The facts of an endpoint that states none, on an app that declares none. */
export const NO_API_FACTS: Readonly<Record<string, unknown>> = Object.freeze(Object.create(null) as Record<string, unknown>);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if(value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

/**
 * A facts vocabulary, checked: an object schema declaring at least one fact,
 * none of which could be absent (see LambderApiFactsSchemaCheck). Read for
 * what it is used as rather than by class, so a schema from a second copy of
 * zod in the bundle still counts. `where` names the call that took it, for
 * the error.
 */
export const readApiFactsSchema = (schema: unknown, where: string): LambderApiFactsSchema => {
    const candidate = schema as { safeParse?: unknown; shape?: unknown } | null | undefined;
    if(typeof candidate?.safeParse !== "function" || !isPlainObject(candidate.shape)){
        throw new Error(`Lambder: ${where} takes the API facts as an object schema, one key per fact: z.object({ ... }).`);
    }
    if(Object.keys(candidate.shape).length === 0){
        throw new Error(`Lambder: ${where} was given an object schema with no keys, which declares no fact. Name the facts endpoints state, or leave it out.`);
    }
    for(const [name, fact] of Object.entries(candidate.shape as Record<string, { safeParse?: (value: unknown) => { success: boolean; data?: unknown } }>)){
        let absent: { success: boolean; data?: unknown };
        try {
            absent = fact.safeParse!(undefined);
        } catch {
            // Not a schema this can ask (an async check, say): an endpoint's
            // own facts meet it at registration, which says so by name.
            continue;
        }
        if(absent.success && absent.data === undefined){
            throw new Error(`Lambder: ${where} declares the fact "${name}", which could be absent: an endpoint that says nothing would state no value for it. Give it a default, or make it nullable with a default of null, so every call reads a value.`);
        }
    }
    return schema as LambderApiFactsSchema;
};

/** The facts a vocabulary declares, by name; none for no vocabulary. */
export const apiFactNamesOf = (schema: LambderApiFactsSchema | null | undefined): string[] =>
    schema ? Object.keys(schema.shape) : [];

/** Frozen all the way down: one object answers every call of its endpoint, so nothing a handler does to it may reach the next call. */
const deepFreeze = <TValue>(value: TValue): TValue => {
    if(value !== null && typeof value === "object" && !Object.isFrozen(value)){
        Object.freeze(value);
        for(const member of Object.values(value)) deepFreeze(member);
    }
    return value;
};

/** One vocabulary's facts out of what an endpoint wrote, parsed: defaults filled in, a missing or mistyped fact refused by name. */
const parseFacts = (apiName: string, schema: LambderApiFactsSchema, given: Record<string, unknown>): Record<string, unknown> => {
    const slice: Record<string, unknown> = {};
    for(const name of Object.keys(schema.shape)){
        if(Object.prototype.hasOwnProperty.call(given, name)) slice[name] = given[name];
    }
    let parsed: z.ZodSafeParseResult<Record<string, unknown>>;
    try {
        parsed = schema.safeParse(slice);
    } catch(thrown){
        // An async refinement makes a synchronous parse throw. Facts are read
        // at registration, which is synchronous, and are data, not lookups.
        throw new Error(`Lambder: the facts of API "${apiName}" could not be parsed synchronously (${thrown instanceof Error ? thrown.message : String(thrown)}). A facts schema holds plain values and no async check.`);
    }
    if(!parsed.success){
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
export const resolveApiFacts = (
    apiName: string,
    given: unknown,
    instanceSchema: LambderApiFactsSchema | null,
    moduleSchema: LambderApiFactsSchema | null,
): Readonly<Record<string, unknown>> => {
    if(given !== undefined && !isPlainObject(given)){
        throw new Error(`Lambder: API "${apiName}" has a facts option that is not an object of facts by name.`);
    }
    if(!instanceSchema && !moduleSchema){
        if(given !== undefined){
            throw new Error(`Lambder: API "${apiName}" states facts, and no API facts were declared. Declare the app's on the init with declareApiFacts(), or a module's own with defineApiModule().`);
        }
        return NO_API_FACTS;
    }
    const written = given ?? {};
    const declared = new Set([...apiFactNamesOf(instanceSchema), ...apiFactNamesOf(moduleSchema)]);
    const unknown = Object.keys(written).filter((name) => !declared.has(name));
    if(unknown.length){
        throw new Error(`Lambder: API "${apiName}" states ${unknown.map((name) => `"${name}"`).join(", ")}, which no API facts vocabulary it is declared under holds. A fact is declared before it is stated.`);
    }
    const resolved: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for(const schema of [instanceSchema, moduleSchema]){
        if(schema) Object.assign(resolved, parseFacts(apiName, schema, written));
    }
    assertPlainData({ ...resolved }, `the facts of API "${apiName}"`);
    return deepFreeze(resolved);
};

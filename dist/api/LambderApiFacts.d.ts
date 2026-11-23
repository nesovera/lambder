import type { z } from "zod";
/** A vocabulary of API facts: an object schema, each key one fact. */
export type LambderApiFactsSchema = z.ZodObject;
/**
 * The facts an app's endpoints state, as its types carry them: `given` is
 * what an endpoint writes (a fact with a default may be left out), `resolved`
 * what the call's context holds (every fact, defaults filled in).
 */
export type LambderApiFactsTypes = {
    given: object;
    resolved: object;
};
/** The facts of an app that declares none. */
export type LambderNoApiFacts = {
    given: {};
    resolved: {};
};
/** The facts one schema declares; none for an init that declared no schema. */
export type LambderApiFactsOf<TSchema> = TSchema extends z.ZodType ? {
    given: z.input<TSchema>;
    resolved: z.output<TSchema>;
} : LambderNoApiFacts;
/** An app's facts with a module's own beside them; the app's alone for a module that declares none. */
export type LambderApiFactsWith<TFacts extends LambderApiFactsTypes, TSchema> = TSchema extends z.ZodType ? {
    given: TFacts["given"] & z.input<TSchema>;
    resolved: TFacts["resolved"] & z.output<TSchema>;
} : TFacts;
/**
 * A facts vocabulary held to every fact being present on every call:
 * intersected onto what declareApiFacts() and a module's apiFacts take. A
 * fact that could be absent (an optional with no default) would read as
 * undefined on an endpoint that said nothing, and a guard deciding by it
 * would decide by a value nobody stated. The property name is the message
 * and its value the facts at fault.
 */
export type LambderApiFactsSchemaCheck<TSchema> = TSchema extends z.ZodType ? {
    [TName in keyof z.output<TSchema>]-?: undefined extends z.output<TSchema>[TName] ? TName : never;
}[keyof z.output<TSchema>] extends infer TAbsent ? ([TAbsent] extends [never] ? unknown : {
    readonly "lambder: these API facts could be absent. Give each a default, or make it nullable with a default of null, so every call reads a value.": TAbsent;
}) : never : unknown;
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
export type LambderApiFactsField<TFacts extends LambderApiFactsTypes> = [
    keyof TFacts["given"]
] extends [never] ? {
    /** This app declares no API facts, so an endpoint states none. */
    facts?: LambderNoApiFactsDeclared;
} : {} extends TFacts["given"] ? {
    /** What this endpoint states about itself, in the vocabulary the app declared (declareApiFacts) and its module's own: plain data, parsed once at registration, read as `ctx.apiFacts` and written into the generated options. A fact left out takes its default. */
    facts?: TFacts["given"];
} : {
    /** What this endpoint states about itself, in the vocabulary the app declared (declareApiFacts) and its module's own: plain data, parsed once at registration, read as `ctx.apiFacts` and written into the generated options. Required here: a declared fact has no default, so every endpoint states it. */
    facts: TFacts["given"];
};
/**
 * What a context typed to an app's facts adds to the call's context: the
 * facts of the endpoint being called, every one present. Intersected onto
 * the context a guard built from a facts-bound init is handed, and onto an
 * endpoint handler's.
 */
export type LambderApiFactsContext<TResolved> = {
    readonly apiFacts: Readonly<TResolved>;
};
/** The facts of an endpoint that states none, on an app that declares none. */
export declare const NO_API_FACTS: Readonly<Record<string, unknown>>;
/**
 * A facts vocabulary, checked: an object schema declaring at least one fact,
 * none of which could be absent (see LambderApiFactsSchemaCheck). Read for
 * what it is used as rather than by class, so a schema from a second copy of
 * zod in the bundle still counts. `where` names the call that took it, for
 * the error.
 */
export declare const readApiFactsSchema: (schema: unknown, where: string) => LambderApiFactsSchema;
/** The facts a vocabulary declares, by name; none for no vocabulary. */
export declare const apiFactNamesOf: (schema: LambderApiFactsSchema | null | undefined) => string[];
/**
 * One endpoint's facts as every call of it reads them: what it wrote, held
 * to the app's vocabulary and its module's own, defaults filled in, frozen.
 * Refused, by endpoint and fact name: a fact neither vocabulary declares, a
 * fact stated where no vocabulary exists, a value its schema refuses, a fact
 * without a default left out, and a value that is not plain data, since the
 * facts are written into the generated options as the data they are.
 */
export declare const resolveApiFacts: (apiName: string, given: unknown, instanceSchema: LambderApiFactsSchema | null, moduleSchema: LambderApiFactsSchema | null) => Readonly<Record<string, unknown>>;
export {};

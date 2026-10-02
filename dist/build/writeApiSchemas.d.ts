import { z } from "zod";
import { type LambderModuleLocation } from "./moduleLocation.js";
import { type LambderNameChanges } from "./generatedTables.js";
/** The zod schemas of one API, as a source reports them. */
type LambderApiSchemaPair = {
    input: z.ZodType;
    output: z.ZodType;
};
/** What writeApiSchemas reads the schemas from: a Lambder instance, or anything else that reports them the same way. */
export type LambderApiSchemasSource = {
    /** Every API's input and output schemas by name. Asynchronous, since a Lambder instance loads its lazy groups before it can report every endpoint. */
    apiSchemaEntries(): Promise<Record<string, LambderApiSchemaPair>> | Record<string, LambderApiSchemaPair>;
};
/**
 * One place where an API's schema does something its written JSON Schema
 * cannot hold, so the mock does not do it either:
 *
 * - `refinement`: a `.refine()`, `.superRefine()` or `.check()` check, or a
 *   `z.custom()` schema (written as one that takes anything). The mock does
 *   not run it, so it lets through what the refinement refuses.
 * - `transform`: a `.transform()` (in the output form written as a schema
 *   that takes anything), a `z.preprocess()`, a codec, a rewrite such as
 *   `.trim()` or `.toLowerCase()`, a `z.coerce` schema, a `.catch()`. The mock
 *   does not apply it: its handler reads the value as posted, and a coerced or
 *   caught input the server takes, the mock refuses.
 * - `pipe`: the second schema of a `.pipe()`. The input form carries the
 *   first, so the mock does not check the second.
 * - `default`: a default a function computes on each parse, which the file
 *   cannot hold, so it is left out and the mock fills nothing there.
 * - `check`: a string check JSON Schema cannot state as zod runs it: a regex
 *   with flags (`/i`, `/u`), whose pattern means something else without
 *   them, or a URL's `protocol` or `hostname` rule (`z.httpUrl()` among
 *   them). The mock does not run it, so it lets through what the check
 *   refuses.
 */
export type LambderApiSchemaLoss = {
    /** The API whose schema it is. */
    api: string;
    /** Which of its schemas: the input a client posts, or the output it receives. */
    direction: "input" | "output";
    /** Where, as a JSON pointer into the written schema: `#/properties/name`, or `#` for the whole schema. */
    path: string;
    kind: "refinement" | "transform" | "pipe" | "default" | "check";
};
export type LambderApiSchemasFileOptions = {
    /**
     * The module that exports the instance, usually the server's entry: a
     * path relative to the working directory, or a file URL. It is imported
     * in this process, so a TypeScript module needs the process's loader
     * (`tsx`, `node --import tsx`), as the generator script itself does.
     */
    module: LambderModuleLocation;
    /** The export that holds the instance. Default: "default", the module's default export. */
    exportName?: string;
    /** The TypeScript module to write, exporting `apiSchemas`. Relative to the working directory. */
    file: string;
    /** Write nothing, and answer whether the file on disk holds what the instance reports now. Default: false. */
    check?: boolean;
    /** The comment the file opens with, one `//` line per line. It should name what generates the file and say it is for development only. Default: a note naming writeApiSchemas(). */
    header?: string;
    /** End the generated statement with a semicolon. Default: true. The table itself is JSON, double quotes included, whatever the project's style: that is what lets a check read it back. */
    semicolons?: boolean;
};
export type LambderApiSchemasFileResult = {
    /** False when a check found the file stale or unreadable. Losses do not make it false: they are what the file cannot hold, however current it is. */
    ok: boolean;
    /** The absolute path. */
    file: string;
    /** True when the file was (re)written; a file that already holds this table is left untouched, however it is formatted. */
    written: boolean;
    /** How many APIs the table holds. */
    count: number;
    /** Which APIs moved against the file that was on disk. */
    changes: LambderNameChanges;
    /** Every place a schema does what its written form cannot hold, sorted by API, direction and place. */
    losses: LambderApiSchemaLoss[];
    /** What happened, as lines to print: a summary, one line per API that moved, then one line per loss. */
    lines: string[];
};
/**
 * Writes every API's input and output schemas as JSON Schema to a module of
 * plain data, or checks the one on disk, and says which APIs moved and what
 * their schemas do that the file cannot hold.
 *
 * Call it from a generator script beside writeApiOptions, writing to where
 * the mock's setup reads it:
 *
 * ```ts
 * import { writeApiSchemas } from "lambder/build";
 *
 * const result = await writeApiSchemas({
 *     module: "server/src/index.ts",   // export const lambder = initLambder()...
 *     exportName: "lambder",
 *     file: "web/src/mock/apiSchemas.generated.ts",
 *     check: process.argv.includes("--check"),
 * });
 * console.log(result.lines.join("\n"));
 * process.exit(result.ok ? 0 : 1);
 * ```
 *
 * The table is compared as the data the file holds, so a checkout that
 * rewrote its line endings or a formatter that re-indented it is neither
 * stale nor rewritten. The same instance writes the same file on every run.
 * A module that does not load, an export that is not an instance, or a
 * schema holding what JSON Schema cannot represent (other than a refinement
 * or a transform, which are listed) throws.
 */
export declare const writeApiSchemas: (options: LambderApiSchemasFileOptions) => Promise<LambderApiSchemasFileResult>;
export {};

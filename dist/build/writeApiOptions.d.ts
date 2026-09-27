import type { LambderApiOptionEntries } from "../shared/wire/LambderApiOptionEntries.js";
import type { LambderModuleLocation } from "./moduleLocation.js";
import { type LambderNameChanges } from "./generatedTables.js";
type TableKey = keyof LambderApiOptionEntries;
export type LambderApiOptionsFileOptions = {
    /**
     * The module that exports the instance, usually the server's entry: a
     * path relative to the working directory, or a file URL. It is imported
     * in this process, so a TypeScript module needs the process's loader
     * (`tsx`, `node --import tsx`), as the generator script itself does.
     */
    module: LambderModuleLocation;
    /** The export that holds the instance. Default: "default", the module's default export. */
    exportName?: string;
    /** The TypeScript module to write, exporting `apiOptions`, `rateLimitPolicies` and `guardDeclarations`. Relative to the working directory. */
    file: string;
    /** Write nothing, and answer whether the file on disk holds what the instance reports now. Default: false. */
    check?: boolean;
    /** The comment the file opens with, one `//` line per line. It should name what generates the file. Default: a note naming writeApiOptions(). */
    header?: string;
    /** End the generated statements with semicolons. Default: true. The tables themselves are JSON, double quotes included, whatever the project's style: that is what lets a check read them back. */
    semicolons?: boolean;
};
export type LambderApiOptionsFileResult = {
    /** False when a check found the file stale or unreadable. */
    ok: boolean;
    /** The absolute path. */
    file: string;
    /** True when the file was (re)written; a file that already holds these tables is left untouched, however it is formatted. */
    written: boolean;
    /** How many APIs, policies and guards the tables hold. */
    counts: Record<TableKey, number>;
    /** What moved, per table, against the file that was on disk. */
    changes: Record<TableKey, LambderNameChanges>;
    /** What happened, as lines to print: a summary, then one line per name that moved. */
    lines: string[];
};
/** The tables a generated file holds, read back as data, or null for a file that does not hold all three as written (never written, or rewritten by hand). */
export declare const readOptionTables: (contents: string) => LambderApiOptionEntries | null;
/**
 * Writes the declared options of an app's APIs as a module of plain data, or
 * checks the one on disk, and says which APIs, policies and guards moved.
 *
 * Call it from a generator script beside writeApiSignatures, naming the
 * module that exports the app's instance:
 *
 * ```ts
 * import { writeApiOptions } from "lambder/build";
 *
 * const result = await writeApiOptions({
 *     module: "server/src/index.ts",   // export const lambder = initLambder()...
 *     exportName: "lambder",
 *     file: "shared/generated/apiOptions.generated.ts",
 *     check: process.argv.includes("--check"),
 * });
 * console.log(result.lines.join("\n"));
 * process.exit(result.ok ? 0 : 1);
 * ```
 *
 * The tables are compared as the data the file holds, so a checkout that
 * rewrote its line endings or a formatter that re-indented it is neither
 * stale nor rewritten, and a file whose data is current is left as it is.
 * There is no fresh-process check: nothing here is digested, so nothing can
 * differ per process. A module that does not load, an export that is not an
 * instance, or a guard parameter that is not plain data throws.
 */
export declare const writeApiOptions: (options: LambderApiOptionsFileOptions) => Promise<LambderApiOptionsFileResult>;
export {};

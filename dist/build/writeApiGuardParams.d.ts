import type { LambderModuleLocation } from "./moduleLocation.js";
import { type LambderNameChanges } from "./generatedTables.js";
export type LambderApiGuardParamsFileOptions = {
    /**
     * The module that exports the instance, usually the server's entry: a
     * path relative to the working directory, or a file URL. It is imported
     * in this process, so a TypeScript module needs the process's loader
     * (`tsx`, `node --import tsx`), as the generator script itself does.
     */
    module: LambderModuleLocation;
    /** The export that holds the instance. Default: "default", the module's default export. */
    exportName?: string;
    /** The guard whose parameters the file holds, as the server declares it. A name the server declares no guard under throws. */
    guard: string;
    /** The TypeScript module to write, one export per API that declares the guard. Relative to the working directory. */
    file: string;
    /** Write nothing, and answer whether the file on disk holds what the instance reports now. Default: false. */
    check?: boolean;
    /** The comment the file opens with, one `//` line per line. It should name what generates the file. Default: a note naming writeApiGuardParams() and the guard. */
    header?: string;
    /** End each generated statement with a semicolon. Default: true. The values are JSON, double quotes included, whatever the project's style: that is what lets a check read them back. */
    semicolons?: boolean;
};
export type LambderApiGuardParamsFileResult = {
    /** False when a check found the file stale or unreadable. */
    ok: boolean;
    /** The absolute path. */
    file: string;
    /** True when the file was (re)written; a file that already holds these parameters is left untouched, however it is formatted. */
    written: boolean;
    /** How many APIs declare the guard. */
    count: number;
    /** Which APIs moved against the file that was on disk. */
    changes: LambderNameChanges;
    /** What happened, as lines to print: a summary, then one line per name that moved. */
    lines: string[];
};
/**
 * Writes one guard's parameters as a module of one export per API, or checks
 * the one on disk, and says which APIs moved.
 *
 * ```ts
 * import { writeApiGuardParams } from "lambder/build";
 *
 * const result = await writeApiGuardParams({
 *     module: "server/src/index.ts",
 *     exportName: "lambder",
 *     guard: "store",
 *     file: "web/src/generated/storeGuardParams.generated.ts",
 *     check: process.argv.includes("--check"),
 * });
 * ```
 *
 * API `orders.list` exports `ordersListGuardParam`: the literal it declared,
 * `true` for a guard named without a parameter (the string and list forms),
 * typed LambderApiGuardParam<"orders.list", "store", literal>. Two APIs whose
 * names export under one identifier fail the write, and so does a parameter
 * that is not plain data, as it does for writeApiOptions, or that is null,
 * which no tag can carry.
 */
export declare const writeApiGuardParams: (options: LambderApiGuardParamsFileOptions) => Promise<LambderApiGuardParamsFileResult>;

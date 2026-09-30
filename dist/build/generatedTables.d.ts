import type { LambderApiOptionEntries } from "../shared/wire/LambderApiOptionEntries.js";
import { type LambderModuleLocation } from "./moduleLocation.js";
/** What the generators read the options from: a Lambder instance, or anything else that reports them the same way. */
export type LambderApiOptionsSource = {
    /** Asynchronous, since a Lambder instance loads its lazy groups before it can report every endpoint. */
    apiOptionEntries(): Promise<LambderApiOptionEntries> | LambderApiOptionEntries;
};
/** Which names of one table moved: entries that changed, entries the file did not have, entries the file had and the instance no longer reports. */
export type LambderNameChanges = {
    changed: string[];
    added: string[];
    removed: string[];
};
/** Imports the module, finds the instance under its export, and answers what it reports. `generator` names the caller in the errors. */
export declare const loadApiOptionEntries: (location: {
    module: LambderModuleLocation;
    exportName?: string;
}, generator: string) => Promise<LambderApiOptionEntries>;
/** One table of a generated file, read back as data, or null for a file that does not hold it as written. */
export declare const readGeneratedTable: (contents: string, exportName: string) => Record<string, unknown> | null;
/** How one table's entries differ from the ones a file held, by name, compared as canonical JSON so key order is not a change. */
export declare const nameChangesOf: (current: Record<string, unknown>, previous: Record<string, unknown>) => LambderNameChanges;
/** The opening comment of a generated file, one `//` line per line of the header. */
export declare const headerLinesOf: (header: string) => string[];
/**
 * One table as a statement: its doc comment, the `// prettier-ignore` that
 * keeps a formatter off the JSON a check reads back, and the table itself,
 * `as const` with whatever `satisfies` clause the caller gives.
 */
export declare const tableStatementLines: (table: {
    name: string;
    doc: string;
    value: unknown;
    satisfies?: string;
    semicolon: string;
}) => string[];
/**
 * The end of a generator's run. With `check`, it answers whether the file
 * holds what the instance reports and writes nothing. Otherwise it writes
 * the file unless it already holds these tables, however it is formatted, so
 * a watcher or an incremental build sees no change where there is none (a
 * change of header or semicolons shows the next time a table changes).
 * Either way the lines say what moved.
 */
export declare const settleGeneratedFile: (run: {
    /** The file as the caller named it, for the lines. */
    name: string;
    /** The absolute path. */
    file: string;
    check: boolean | undefined;
    /** The file's text before this run, or null when there was none. */
    previousText: string | null;
    /** Whether that text held the tables as written; false for a file rewritten by hand. */
    readBack: boolean;
    /** Each table the file holds, under its exported name: how many entries it has now, and which of them moved. */
    tables: readonly {
        name: string;
        count: number;
        changes: LambderNameChanges;
    }[];
    /** What the tables hold, for the lines: "6 APIs, 4 policies, 5 guards". */
    held: string;
    /** What the file holds when it is as written, for the line when it is not: "the three tables". */
    tablesNoun: string;
    /** The line when nothing moved: "no options changed". */
    unmovedLine: string;
    /** The file's contents, rendered only when it is written. */
    render: () => string;
}) => {
    ok: boolean;
    written: boolean;
    lines: string[];
};

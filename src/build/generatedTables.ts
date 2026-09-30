import type { LambderApiOptionEntries } from "../shared/wire/LambderApiOptionEntries.js";
import { canonicalJson } from "../shared/util/canonicalJson.js";
import { moduleUrlOf, type LambderModuleLocation } from "./moduleLocation.js";
import { writeFileAtomically } from "./writeFileAtomically.js";

/*
 * What the two generators of option tables share (writeApiOptions, the whole
 * declarations; writeApiGuardParams, one guard's parameters): loading the
 * instance that reports the options, reading a table back out of a file
 * already written, saying which names of a table moved, and the end of a run,
 * checking or writing the file.
 *
 * A table is written as `export const <name> = <JSON> as const ...`, so it
 * is read back as the JSON between its `=` and its `as const`: re-indentation
 * and line endings change nothing, and a formatter that swaps the quotes
 * makes the file unreadable here, and so stale, which the `// prettier-ignore`
 * line above each table exists to prevent.
 */

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
export const loadApiOptionEntries = async (location: { module: LambderModuleLocation; exportName?: string }, generator: string): Promise<LambderApiOptionEntries> => {
    const moduleUrl = moduleUrlOf(location.module);
    const exportName = location.exportName ?? "default";
    let namespace: Record<string, unknown>;
    try {
        namespace = await import(moduleUrl) as Record<string, unknown>;
    } catch(err) {
        throw new Error(`${generator} could not load ${moduleUrl}`, { cause: err });
    }
    const source = namespace[exportName] as Partial<LambderApiOptionsSource> | null | undefined;
    if(typeof source?.apiOptionEntries !== "function"){
        throw new Error(`${moduleUrl} has no export "${exportName}" that reports API options: name the export holding the instance in exportName`);
    }
    return await source.apiOptionEntries();
};

/** One table of a generated file, read back as data, or null for a file that does not hold it as written. */
export const readGeneratedTable = (contents: string, exportName: string): Record<string, unknown> | null => {
    const match = new RegExp(`export const ${exportName}\\s*=\\s*([\\s\\S]*?)\\s+as const\\b`).exec(contents);
    if(!match) return null;
    try {
        const table: unknown = JSON.parse(match[1]!);
        return table !== null && typeof table === "object" && !Array.isArray(table) ? table as Record<string, unknown> : null;
    } catch {
        return null;
    }
};

/** How one table's entries differ from the ones a file held, by name, compared as canonical JSON so key order is not a change. */
export const nameChangesOf = (current: Record<string, unknown>, previous: Record<string, unknown>): LambderNameChanges => {
    const same = (name: string) => canonicalJson(current[name]) === canonicalJson(previous[name]);
    return {
        changed: Object.keys(current).filter((name) => name in previous && !same(name)).sort(),
        added: Object.keys(current).filter((name) => !(name in previous)).sort(),
        removed: Object.keys(previous).filter((name) => !(name in current)).sort(),
    };
};

/** One line per name that moved, marked `~` changed, `+` added or `-` removed, under the table's name. */
const movedLinesOf = (tableName: string, changes: LambderNameChanges): string[] => [
    ...changes.changed.map((name) => `  ~ ${tableName} ${name}`),
    ...changes.added.map((name) => `  + ${tableName} ${name}`),
    ...changes.removed.map((name) => `  - ${tableName} ${name}`),
];

/** The opening comment of a generated file, one `//` line per line of the header. */
export const headerLinesOf = (header: string): string[] => header.split("\n").map((line) => line ? `// ${line}` : "//");

/**
 * One table as a statement: its doc comment, the `// prettier-ignore` that
 * keeps a formatter off the JSON a check reads back, and the table itself,
 * `as const` with whatever `satisfies` clause the caller gives.
 */
export const tableStatementLines = (table: { name: string; doc: string; value: unknown; satisfies?: string; semicolon: string }): string[] => [
    `/** ${table.doc} */`,
    "// prettier-ignore",
    `export const ${table.name} = ${JSON.stringify(table.value, null, 4)} as const${table.satisfies ? ` satisfies ${table.satisfies}` : ""}${table.semicolon}`,
];

/**
 * The end of a generator's run. With `check`, it answers whether the file
 * holds what the instance reports and writes nothing. Otherwise it writes
 * the file unless it already holds these tables, however it is formatted, so
 * a watcher or an incremental build sees no change where there is none (a
 * change of header or semicolons shows the next time a table changes).
 * Either way the lines say what moved.
 */
export const settleGeneratedFile = (run: {
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
    tables: readonly { name: string; count: number; changes: LambderNameChanges }[];
    /** What the tables hold, for the lines: "6 APIs, 4 policies, 5 guards". */
    held: string;
    /** What the file holds when it is as written, for the line when it is not: "the three tables". */
    tablesNoun: string;
    /** The line when nothing moved: "no options changed". */
    unmovedLine: string;
    /** The file's contents, rendered only when it is written. */
    render: () => string;
}): { ok: boolean; written: boolean; lines: string[] } => {
    const movedLines = run.tables.flatMap((table) => movedLinesOf(table.name, table.changes));
    const summary = run.tables.map(({ name, count, changes }) =>
        `${name}: ${changes.changed.length} changed, ${changes.added.length} added, ${changes.removed.length} removed (${count - changes.changed.length - changes.added.length} unchanged)`,
    ).join("; ");
    const unchanged = run.readBack && movedLines.length === 0;
    if(run.check){
        if(unchanged) return { ok: true, written: false, lines: [`✓ ${run.name} matches the ${run.held}`] };
        return {
            ok: false,
            written: false,
            lines: [
                run.previousText !== null && !run.readBack
                    ? `✗ ${run.name} does not hold ${run.tablesNoun} as written: regenerate it`
                    : `✗ ${run.name} is stale: regenerate it`,
                `  ${summary}`,
                ...movedLines,
            ],
        };
    }
    const written = !unchanged;
    if(written) writeFileAtomically(run.file, run.render(), run.previousText !== null);
    return {
        ok: true,
        written,
        lines: [
            written ? `✓ Wrote ${run.name} (${run.held})` : `✓ ${run.name} is up to date (${run.held})`,
            ...(movedLines.length ? [`  ${summary}`, ...movedLines] : [`  ${run.unmovedLine}`]),
        ],
    };
};

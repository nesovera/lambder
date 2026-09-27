import { canonicalJson } from "../shared/util/canonicalJson.js";
import { moduleUrlOf } from "./moduleLocation.js";
import { writeFileAtomically } from "./writeFileAtomically.js";
/** Imports the module, finds the instance under its export, and answers what it reports. `generator` names the caller in the errors. */
export const loadApiOptionEntries = async (location, generator) => {
    const moduleUrl = moduleUrlOf(location.module);
    const exportName = location.exportName ?? "default";
    let namespace;
    try {
        namespace = await import(moduleUrl);
    }
    catch (err) {
        throw new Error(`${generator} could not load ${moduleUrl}`, { cause: err });
    }
    const source = namespace[exportName];
    if (typeof source?.apiOptionEntries !== "function") {
        throw new Error(`${moduleUrl} has no export "${exportName}" that reports API options: name the export holding the instance in exportName`);
    }
    return source.apiOptionEntries();
};
/** One table of a generated file, read back as data, or null for a file that does not hold it as written. */
export const readGeneratedTable = (contents, exportName) => {
    const match = new RegExp(`export const ${exportName}\\s*=\\s*([\\s\\S]*?)\\s+as const\\b`).exec(contents);
    if (!match)
        return null;
    try {
        const table = JSON.parse(match[1]);
        return table !== null && typeof table === "object" && !Array.isArray(table) ? table : null;
    }
    catch {
        return null;
    }
};
/** How one table's entries differ from the ones a file held, by name, compared as canonical JSON so key order is not a change. */
export const nameChangesOf = (current, previous) => {
    const same = (name) => canonicalJson(current[name]) === canonicalJson(previous[name]);
    return {
        changed: Object.keys(current).filter((name) => name in previous && !same(name)).sort(),
        added: Object.keys(current).filter((name) => !(name in previous)).sort(),
        removed: Object.keys(previous).filter((name) => !(name in current)).sort(),
    };
};
/** One line per name that moved, marked `~` changed, `+` added or `-` removed, under the table's name. */
const movedLinesOf = (tableName, changes) => [
    ...changes.changed.map((name) => `  ~ ${tableName} ${name}`),
    ...changes.added.map((name) => `  + ${tableName} ${name}`),
    ...changes.removed.map((name) => `  - ${tableName} ${name}`),
];
/** The opening comment of a generated file, one `//` line per line of the header. */
export const headerLinesOf = (header) => header.split("\n").map((line) => line ? `// ${line}` : "//");
/**
 * One table as a statement: its doc comment, the `// prettier-ignore` that
 * keeps a formatter off the JSON a check reads back, and the table itself,
 * `as const` with whatever `satisfies` clause the caller gives.
 */
export const tableStatementLines = (table) => [
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
export const settleGeneratedFile = (run) => {
    const movedLines = run.tables.flatMap((table) => movedLinesOf(table.name, table.changes));
    const summary = run.tables.map(({ name, count, changes }) => `${name}: ${changes.changed.length} changed, ${changes.added.length} added, ${changes.removed.length} removed (${count - changes.changed.length - changes.added.length} unchanged)`).join("; ");
    const unchanged = run.readBack && movedLines.length === 0;
    if (run.check) {
        if (unchanged)
            return { ok: true, written: false, lines: [`✓ ${run.name} matches the ${run.held}`] };
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
    if (written)
        writeFileAtomically(run.file, run.render(), run.previousText !== null);
    return {
        ok: true,
        written,
        lines: [
            written ? `✓ Wrote ${run.name} (${run.held})` : `✓ ${run.name} is up to date (${run.held})`,
            ...(movedLines.length ? [`  ${summary}`, ...movedLines] : [`  ${run.unmovedLine}`]),
        ],
    };
};

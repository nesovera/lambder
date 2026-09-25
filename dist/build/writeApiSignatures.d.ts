import type { LambderApiSignatureEntry } from "../api/LambderApiSignature.js";
/**
 * How the fresh process reports its comparison: one line on stdout starting
 * with this, then the verdict as JSON. The line, not the exit status, is the
 * answer: the app's module prints what it likes while it loads, and a
 * process that fails before the line never compared anything.
 */
export declare const VERIFY_REPORT_PREFIX = "lambder-api-signatures-verified:";
/** This process's execArgv, less the flags only it may run with (see PARENT_ONLY_FLAG). */
export declare const freshProcessNodeFlags: (execArgv: readonly string[]) => string[];
/** What writeApiSignatures reads the signatures from: a Lambder instance, or anything else that lists them the same way. */
export type LambderApiSignatureSource = {
    apiSignatureEntries(): Promise<LambderApiSignatureEntry[]>;
};
export type LambderApiSignatureFileOptions = {
    /** The TypeScript module to write, exporting `apiSignatures`. Relative to the working directory. */
    file: string;
    /** Write nothing, and answer whether the file on disk is what the registrations produce now. Default: false. */
    check?: boolean;
    /** The comment the file opens with, one `//` line per line. It should name what generates the file. Default: a note naming writeApiSignatures(). */
    header?: string;
    /** Quotes in the generated module. Default: "double". */
    quotes?: "single" | "double";
    /** End the generated statements with semicolons. Default: true. */
    semicolons?: boolean;
    /**
     * After writing, or after a check that found the file current, load the
     * module that holds the instance in a fresh Node process and check the
     * file against what it digests there. A schema built from the clock or a
     * random source digests differently in every process; this catches it by
     * endpoint name instead of letting signatures change on every build. Only
     * that module is loaded, never the calling script, so nothing the script
     * does runs twice; the module's own top-level code does run again. The
     * fresh process gets this process's Node flags (`--import`, `--require`,
     * `--loader`, `--conditions`) less the inspector, watch mode, the test
     * runner and the eval flags (`-e`, `-p`, `--input-type`), so a TypeScript
     * module loads there as it did here when its loader is on the command
     * line or in NODE_OPTIONS. Default: not verified.
     */
    verifyInFreshProcess?: {
        /**
         * The module that exports the instance: a path relative to the
         * working directory, or a file URL, as a URL such as
         * `new URL("../backend/index.js", import.meta.url)` beside the
         * generator's own import of it, or as the string
         * `import.meta.resolve()` answers.
         */
        module: string | URL;
        /** The export that holds the instance. Default: "default", the module's default export. */
        exportName?: string;
    };
};
export type LambderApiSignatureFileResult = {
    /** False when a check found the file stale, or a fresh process digested different signatures or never compared them. */
    ok: boolean;
    /** The absolute path. */
    file: string;
    /** How many APIs the file holds. */
    count: number;
    /** True when the file was (re)written; a file that already holds these signatures is left untouched, however it is formatted. */
    written: boolean;
    /** Endpoints whose signature differs from the file that was on disk, by name. */
    changed: string[];
    added: string[];
    /** Endpoints the file held and the registrations no longer have. Named by key only: a key is a one-way hash of a name that is gone. */
    removedKeys: string[];
    /** What happened, as lines to print: a summary, then one line per endpoint that moved. */
    lines: string[];
};
/**
 * The map a generated file holds, read back by its hex pairs. Either quote
 * style parses, and so does a key without quotes: a formatter that quotes
 * properties only as needed (Prettier's default, Biome's, ESLint's
 * quote-props) unquotes every key that starts with a letter.
 */
export declare const readSignatureMap: (contents: string) => Record<string, string>;
/** How the registrations differ from a map read off a file, by endpoint, as the lines both this process and a fresh one print. */
export declare const describeSignatureChanges: (entries: LambderApiSignatureEntry[], previousMap: Record<string, string>) => {
    changed: string[];
    added: string[];
    removedKeys: string[];
    movedLines: string[];
    summary: string;
};
/**
 * Writes the signature map both sides ship (see Lambder.apiSignatures()) to
 * a TypeScript module, or checks the one on disk, and says which endpoints
 * moved: every changed signature is a forced reload for the tabs calling
 * that endpoint, so this is the line that says how wide a deploy's reload
 * will be.
 *
 * Call it from a generator script that imports the app's instance:
 *
 * ```ts
 * import { writeApiSignatures } from "lambder/build";
 * import { lambder } from "../server/src/index.js";
 *
 * const result = await writeApiSignatures(lambder, { file: "shared/generated/apiSignatures.generated.ts", check: process.argv.includes("--check") });
 * console.log(result.lines.join("\n"));
 * process.exit(result.ok ? 0 : 1);
 * ```
 *
 * Signatures are compared as the map the file holds, so a checkout that
 * rewrote its line endings or a formatter that re-indented it or unquoted
 * its keys is neither stale nor rewritten. `verifyInFreshProcess` also
 * checks the file, written or found current, against the instance's module
 * loaded in a fresh process.
 */
export declare const writeApiSignatures: (source: LambderApiSignatureSource, options: LambderApiSignatureFileOptions) => Promise<LambderApiSignatureFileResult>;

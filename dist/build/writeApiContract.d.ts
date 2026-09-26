import { type LambderModuleLocation } from "./moduleLocation.js";
export type LambderApiContractFileOptions = {
    /** The module that exports the Lambder instance, usually the server's entry: a path relative to the working directory, or a file URL. */
    module: LambderModuleLocation;
    /** The export that holds the instance, whose ApiContract is written out. Default: "default", the module's default export. */
    exportName?: string;
    /** The name the written module exports the contract type under. Default: "ApiContractType". */
    typeName?: string;
    /** The tsconfig.json the module compiles under, whose compiler options and path aliases resolve its imports. Relative to the working directory. Default: the nearest tsconfig.json at or above the module's directory. */
    tsconfig?: string;
    /** The TypeScript module to write. Relative to the working directory. */
    file: string;
    /** Write nothing, and answer whether the file on disk is what the contract prints now. Default: false. */
    check?: boolean;
    /** The comment the file opens with, one `//` line per line. It should name what generates the file. Default: a note naming writeApiContract(). */
    header?: string;
    /** Quotes in the generated module. Default: "double". */
    quotes?: "single" | "double";
    /** End the generated declarations and members with semicolons. Default: true. */
    semicolons?: boolean;
};
export type LambderApiContractFileResult = {
    /** False when the contract could not be read or printed, a check found the file stale, or the printed type was not the contract's. */
    ok: boolean;
    /** The absolute path. */
    file: string;
    /** How many APIs the contract holds (0 when it could not be read). */
    count: number;
    /** True when the file was (re)written; a file that already holds this text is left untouched. */
    written: boolean;
    /** APIs whose printed types differ from the file that was on disk, by name, counting the declarations each refers to. */
    changed: string[];
    added: string[];
    removed: string[];
    /** What happened, as lines to print: a summary, then one line per API that moved or per member that could not be printed. */
    lines: string[];
};
/**
 * Writes an app's API contract type to a TypeScript module as plain types,
 * or checks the one on disk, and names the APIs whose types moved.
 *
 * The contract is the ApiContract property of the instance the module
 * exports, read through the TypeScript compiler under the server's own
 * tsconfig; nothing of the server runs. Every type in it is printed as the
 * structure it resolves to: zod's inferences, mapped and conditional types and
 * the server's own types become plain object types, unions and literals. The
 * written module imports nothing, not even lambder, and exports one type
 * alias, `typeName`. Only the default library's interfaces (Date) are printed
 * by name. A non-generic named type is printed once, as a declaration of its
 * own that the entries refer to; two that want one name are numbered by where
 * each is declared, never by the order the APIs were registered in.
 *
 * Anything with no plain form fails the call and names where it sits: a
 * function, a symbol-keyed property, an enum, a class's private member, or a
 * type parameter the contract leaves open. Property `readonly` modifiers are
 * not carried over (they never decide assignability); readonly arrays and
 * tuples are.
 *
 * ```ts
 * import { writeApiContract } from "lambder/build";
 *
 * const result = await writeApiContract({
 *     module: "server/src/index.ts",   // export const lambder = initLambder()...
 *     exportName: "lambder",
 *     file: "shared/generated/apiContract.generated.ts",
 *     check: process.argv.includes("--check"),
 * });
 * console.log(result.lines.join("\n"));
 * process.exit(result.ok ? 0 : 1);
 * ```
 *
 * A check compares the text, so the file should be left out of formatters;
 * each declaration carries a `// prettier-ignore` line for Prettier. A write
 * that changes the file first compiles the new text beside the server's
 * sources and checks every entry against the contract both ways, and writes
 * nothing when one differs. The file is written to a temporary file renamed
 * over the old one, so a build reading it meanwhile never sees half of it.
 */
export declare const writeApiContract: (options: LambderApiContractFileOptions) => Promise<LambderApiContractFileResult>;

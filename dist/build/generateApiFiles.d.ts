import type { LambderModuleLocation } from "./moduleLocation.js";
import { type LambderApiContractFileOptions } from "./writeApiContract.js";
import { type LambderApiSignatureFileOptions } from "./writeApiSignatures.js";
import { type LambderApiOptionsFileOptions } from "./writeApiOptions.js";
import { type LambderApiGuardParamsFileOptions } from "./writeApiGuardParams.js";
/** What a file's writer takes beyond where the instance is, which the app gives once for all its files. */
type LambderAppFile<TOptions> = Omit<TOptions, "module" | "exportName" | "tsconfig" | "check">;
/** One app: where its instance is, and which files it is written to. Each file is optional. */
export type LambderApiFilesApp = {
    /** The module that exports the instance, usually the server's entry: a path relative to the working directory, or a file URL. */
    module: LambderModuleLocation;
    /** The export that holds the instance. Default: "default". */
    exportName?: string;
    /** The tsconfig.json the module compiles under, which the contract is read through. Default: the nearest one at or above the module. */
    tsconfig?: string;
    /** The contract a client compiles against, as plain types (writeApiContract). */
    contract?: LambderAppFile<LambderApiContractFileOptions>;
    /** The signature file both sides ship (writeApiSignatures). */
    signatures?: LambderAppFile<LambderApiSignatureFileOptions>;
    /** The declared options as plain data, for a mock and tests (writeApiOptions). */
    options?: LambderAppFile<LambderApiOptionsFileOptions>;
    /** One file per guard whose parameters a browser needs (writeApiGuardParams). */
    guardParams?: readonly LambderAppFile<LambderApiGuardParamsFileOptions>[];
};
/** The files generateApiFiles writes: every app's, by a name the output lines use. */
export type LambderApiFilesConfig = {
    apps: Record<string, LambderApiFilesApp>;
};
export type LambderApiFilesResult = {
    /** False when a check found a file stale, or a writer failed. */
    ok: boolean;
    /** What happened, per app and file, as lines to print. */
    lines: string[];
};
/**
 * Writes every file the config names, or with `check` writes nothing and
 * answers whether each one on disk is current. Paths are relative to the
 * working directory, as each writer takes them.
 *
 * ```ts
 * import { generateApiFiles } from "lambder/build";
 *
 * const result = await generateApiFiles({
 *     apps: {
 *         server: {
 *             module: "backend/index.ts",
 *             exportName: "lambder",
 *             contract: { file: "shared/generated/apiContract.generated.ts" },
 *             signatures: { file: "shared/generated/apiSignatures.generated.ts" },
 *         },
 *     },
 * }, { check: process.argv.includes("--check") });
 * console.log(result.lines.join("\n"));
 * process.exit(result.ok ? 0 : 1);
 * ```
 */
export declare const generateApiFiles: (config: LambderApiFilesConfig, options?: {
    check?: boolean;
}) => Promise<LambderApiFilesResult>;
export {};

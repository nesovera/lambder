import type { LambderModuleLocation } from "./moduleLocation.js";
import type { LambderApiContractFileOptions } from "./writeApiContract.js";
import { type LambderApiSignatureFileOptions } from "./writeApiSignatures.js";
import { type LambderApiOptionsFileOptions } from "./writeApiOptions.js";
import { type LambderApiGuardParamsFileOptions } from "./writeApiGuardParams.js";
import { type LambderApiSchemasFileOptions } from "./writeApiSchemas.js";
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
    /** The input and output schemas as JSON Schema, for a mock to validate against in development (writeApiSchemas). */
    schemas?: LambderAppFile<LambderApiSchemasFileOptions>;
};
/** The files generateApiFiles writes: every app's, by a name the output lines use. */
export type LambderApiFilesConfig = {
    apps: Record<string, LambderApiFilesApp>;
};
/** How generateApiFiles runs. */
export type LambderApiFilesOptions = {
    /** Write nothing, and answer whether each file on disk is what its writer produces now. Default: false. */
    check?: boolean;
    /**
     * The heap, in megabytes, of the Node process each contract is printed
     * in (its --max-old-space-size). Reading a contract compiles the server,
     * twice for a write that changes the file, which in a large app takes
     * gigabytes; the process is started for that alone, so the heap is the
     * printing's whatever the script's own is. Default: 8192.
     */
    contractHeapMegabytes?: number;
};
export type LambderApiFilesResult = {
    /** False when a check found a file stale, or a writer failed. */
    ok: boolean;
    /** What happened, per app and file, as lines to print. */
    lines: string[];
};
/**
 * How the contract printing process reports: one line on stdout starting
 * with this, then its report as JSON. The line, not the exit status, is the
 * answer: a process that dies before it (out of heap, say) answered nothing.
 */
export declare const CONTRACT_REPORT_PREFIX = "lambder-api-contract-printed:";
/**
 * Writes every file the config names, or with `check` writes nothing and
 * answers whether each one on disk is current. Paths are relative to the
 * working directory, as each writer takes them. Each contract is printed in
 * a Node process of its own, with a heap of `contractHeapMegabytes`.
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
export declare const generateApiFiles: (config: LambderApiFilesConfig, options?: LambderApiFilesOptions) => Promise<LambderApiFilesResult>;
export {};

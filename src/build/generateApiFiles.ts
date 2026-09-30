import type { LambderModuleLocation } from "./moduleLocation.js";
import { writeApiContract, type LambderApiContractFileOptions } from "./writeApiContract.js";
import { writeApiSignatures, type LambderApiSignatureFileOptions } from "./writeApiSignatures.js";
import { writeApiOptions, type LambderApiOptionsFileOptions } from "./writeApiOptions.js";
import { writeApiGuardParams, type LambderApiGuardParamsFileOptions } from "./writeApiGuardParams.js";

/*
 * Every file an app's Lambder instances are written to, in one call a
 * generator script makes with the files it owns: each instance's module
 * named once for all of them.
 *
 * The contracts are read first, through the compiler alone; then each app's
 * module is imported once, and its signatures, options and guard parameters
 * are written from the one instance. A writer that fails does not stop the
 * others, so one run names everything that is stale or broken.
 */

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

const APP_KEYS = ["module", "exportName", "tsconfig", "contract", "signatures", "options", "guardParams"] as const;
const FILE_KINDS = ["contract", "signatures", "options", "guardParams"] as const;

/** A config that names apps, each with its module and at least one file, and no key the generator does not read. */
function assertConfig(config: unknown): asserts config is LambderApiFilesConfig {
    const apps = (config as { apps?: unknown } | null)?.apps;
    if(apps === null || typeof apps !== "object" || Array.isArray(apps) || Object.keys(apps).length === 0){
        throw new Error("generateApiFiles: the config names no apps. Give `apps`, one entry per Lambder instance: { module, exportName, and the files it is written to }.");
    }
    for(const [name, app] of Object.entries(apps as Record<string, unknown>)){
        if(app === null || typeof app !== "object") throw new Error(`generateApiFiles: the app "${name}" is not an object.`);
        const unknownKeys = Object.keys(app).filter((key) => !(APP_KEYS as readonly string[]).includes(key));
        if(unknownKeys.length) throw new Error(`generateApiFiles: the app "${name}" has ${unknownKeys.map((key) => `"${key}"`).join(", ")}, which the generator does not read (it reads ${APP_KEYS.join(", ")}).`);
        if(!(app as { module?: unknown }).module) throw new Error(`generateApiFiles: the app "${name}" names no module to read its instance from.`);
        if(!FILE_KINDS.some((kind) => (app as Record<string, unknown>)[kind] !== undefined)){
            throw new Error(`generateApiFiles: the app "${name}" is written to no file; give it a contract, signatures, options or guardParams.`);
        }
    }
}

/** A writer's run as lines: its own on success or a stale check, the reason when it threw. */
const settle = async (label: string, write: () => Promise<{ ok: boolean; lines: string[] }>): Promise<{ ok: boolean; lines: string[] }> => {
    try {
        return await write();
    } catch(err) {
        const reasons: string[] = [];
        for(let cause: unknown = err; cause instanceof Error && reasons.length < 4; cause = cause.cause) reasons.push(cause.message);
        return { ok: false, lines: [`✗ ${label} failed: ${reasons.join(": ") || String(err)}`] };
    }
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
export const generateApiFiles = async (config: LambderApiFilesConfig, options: { check?: boolean } = {}): Promise<LambderApiFilesResult> => {
    assertConfig(config);
    const check = options.check ?? false;
    const apps = Object.entries(config.apps);
    const runs: { ok: boolean; lines: string[] }[] = [];

    // The contracts first: they compile the app's sources and run none of
    // them, so a module that fails to load still gets its contract checked.
    for(const [name, app] of apps){
        if(!app.contract) continue;
        runs.push(await settle(`${name}: the contract`, () =>
            writeApiContract({ ...app.contract!, module: app.module, exportName: app.exportName, tsconfig: app.tsconfig, check })));
    }
    // Then what is read off the instance itself, which importing the module
    // builds once for all three.
    for(const [name, app] of apps){
        const instance = { module: app.module, exportName: app.exportName, check };
        if(app.signatures) runs.push(await settle(`${name}: the signatures`, () => writeApiSignatures({ ...app.signatures!, ...instance })));
        if(app.options) runs.push(await settle(`${name}: the options`, () => writeApiOptions({ ...app.options!, ...instance })));
        for(const guardFile of app.guardParams ?? []){
            runs.push(await settle(`${name}: the "${guardFile.guard}" guard parameters`, () => writeApiGuardParams({ ...guardFile, ...instance })));
        }
    }
    return { ok: runs.every((run) => run.ok), lines: runs.flatMap((run) => run.lines) };
};

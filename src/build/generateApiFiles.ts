import { spawn } from "child_process";
import { fileURLToPath } from "url";
import type { ContractPrinterReport, ContractPrinterRequest } from "./contractPrinterProcess.js";
import type { LambderModuleLocation } from "./moduleLocation.js";
import type { LambderApiContractFileOptions } from "./writeApiContract.js";
import { writeApiSignatures, type LambderApiSignatureFileOptions } from "./writeApiSignatures.js";
import { writeApiOptions, type LambderApiOptionsFileOptions } from "./writeApiOptions.js";
import { writeApiGuardParams, type LambderApiGuardParamsFileOptions } from "./writeApiGuardParams.js";
import { writeApiSchemas, type LambderApiSchemasFileOptions } from "./writeApiSchemas.js";

/*
 * Every file an app's Lambder instances are written to, in one call a
 * generator script makes with the files it owns: each instance's module
 * named once for all of them.
 *
 * The contracts are read first, through the compiler alone, each in a Node
 * process of its own (contractPrinterProcess) with a heap sized for it; then
 * each app's module is imported once, here, and its signatures, options,
 * guard parameters and schemas are written from the one instance. A writer that fails
 * does not stop the others, so one run names everything that is stale or
 * broken.
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

const APP_KEYS = ["module", "exportName", "tsconfig", "contract", "signatures", "options", "guardParams", "schemas"] as const;
const FILE_KINDS = ["contract", "signatures", "options", "guardParams", "schemas"] as const;

const DEFAULT_CONTRACT_HEAP_MEGABYTES = 8192;

/**
 * How the contract printing process reports: one line on stdout starting
 * with this, then its report as JSON. The line, not the exit status, is the
 * answer: a process that dies before it (out of heap, say) answered nothing.
 */
export const CONTRACT_REPORT_PREFIX = "lambder-api-contract-printed:";

/** The contract printing process's entry, beside this module in the build. */
const CONTRACT_PRINTER_ENTRY = new URL("./contractPrinterProcess.js", import.meta.url);

/** How much of a process's error output a failure repeats. */
const STDERR_TAIL_LINES = 20;

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
            throw new Error(`generateApiFiles: the app "${name}" is written to no file; give it a contract, signatures, options, guardParams or schemas.`);
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
 * writeApiContract in a Node process of its own, started with the heap given
 * and none of this process's flags: the compiler loads no module of the app,
 * so the script's loader is not needed there, and the heap the script runs
 * with is not the printing's. Its result comes back as writeApiContract
 * answers it, and what it throws is thrown here with the same messages, down
 * the chain of causes, so a run reads the same as one in this process.
 */
const writeApiContractInOwnProcess = async (label: string, options: LambderApiContractFileOptions, heapMegabytes: number): Promise<{ ok: boolean; lines: string[] }> => {
    const request: ContractPrinterRequest = { ...options, module: options.module instanceof URL ? options.module.href : options.module };
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMegabytes}`, fileURLToPath(CONTRACT_PRINTER_ENTRY), JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const ended = await new Promise<{ status: number | null; signal: NodeJS.Signals | null } | { error: Error }>((resolveEnd) => {
        child.once("error", (error) => resolveEnd({ error }));
        child.once("close", (status, signal) => resolveEnd({ status, signal }));
    });
    if("error" in ended) return { ok: false, lines: [`✗ ${label} failed: the process to print it in could not start: ${ended.error.message}`] };

    const reportLine = stdout.split("\n").findLast((line) => line.startsWith(CONTRACT_REPORT_PREFIX));
    if(reportLine === undefined){
        if(/JavaScript heap out of memory/i.test(stderr)){
            return { ok: false, lines: [`✗ ${label} failed: the process printing it ran out of its ${heapMegabytes} MB heap; raise contractHeapMegabytes`] };
        }
        const ending = ended.signal ? `signal ${ended.signal}` : `exit status ${ended.status ?? "none"}`;
        return {
            ok: false,
            lines: [
                `✗ ${label} failed: the process printing it ended without an answer (${ending})`,
                ...stderr.trim().split("\n").filter(Boolean).slice(-STDERR_TAIL_LINES).map((line) => `  ${line}`),
            ],
        };
    }
    const report = JSON.parse(reportLine.slice(CONTRACT_REPORT_PREFIX.length)) as ContractPrinterReport;
    if("thrown" in report) throw report.thrown.reduceRight<Error | undefined>((cause, message) => new Error(message, cause ? { cause } : undefined), undefined);
    return report.result;
};

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
export const generateApiFiles = async (config: LambderApiFilesConfig, options: LambderApiFilesOptions = {}): Promise<LambderApiFilesResult> => {
    assertConfig(config);
    const check = options.check ?? false;
    const contractHeapMegabytes = options.contractHeapMegabytes ?? DEFAULT_CONTRACT_HEAP_MEGABYTES;
    if(!Number.isInteger(contractHeapMegabytes) || contractHeapMegabytes <= 0){
        throw new Error(`generateApiFiles: contractHeapMegabytes is ${String(contractHeapMegabytes)}; give the heap of the process each contract is printed in as a whole number of megabytes, such as ${DEFAULT_CONTRACT_HEAP_MEGABYTES}.`);
    }
    const apps = Object.entries(config.apps);
    const runs: { ok: boolean; lines: string[] }[] = [];

    // The contracts first: they compile the app's sources and run none of
    // them, so a module that fails to load still gets its contract checked.
    for(const [name, app] of apps){
        if(!app.contract) continue;
        const label = `${name}: the contract`;
        runs.push(await settle(label, () =>
            writeApiContractInOwnProcess(label, { ...app.contract!, module: app.module, exportName: app.exportName, tsconfig: app.tsconfig, check }, contractHeapMegabytes)));
    }
    // Then what is read off the instance itself, which importing the module
    // builds once for all of them.
    for(const [name, app] of apps){
        const instance = { module: app.module, exportName: app.exportName, check };
        if(app.signatures) runs.push(await settle(`${name}: the signatures`, () => writeApiSignatures({ ...app.signatures!, ...instance })));
        if(app.options) runs.push(await settle(`${name}: the options`, () => writeApiOptions({ ...app.options!, ...instance })));
        for(const guardFile of app.guardParams ?? []){
            runs.push(await settle(`${name}: the "${guardFile.guard}" guard parameters`, () => writeApiGuardParams({ ...guardFile, ...instance })));
        }
        if(app.schemas) runs.push(await settle(`${name}: the schemas`, () => writeApiSchemas({ ...app.schemas!, ...instance })));
    }
    return { ok: runs.every((run) => run.ok), lines: runs.flatMap((run) => run.lines) };
};

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { writeApiSignatures } from "./writeApiSignatures.js";
import { writeApiOptions } from "./writeApiOptions.js";
import { writeApiGuardParams } from "./writeApiGuardParams.js";
import { writeApiSchemas } from "./writeApiSchemas.js";
const APP_KEYS = ["module", "exportName", "tsconfig", "contract", "signatures", "options", "guardParams", "schemas"];
const FILE_KINDS = ["contract", "signatures", "options", "guardParams", "schemas"];
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
function assertConfig(config) {
    const apps = config?.apps;
    if (apps === null || typeof apps !== "object" || Array.isArray(apps) || Object.keys(apps).length === 0) {
        throw new Error("generateApiFiles: the config names no apps. Give `apps`, one entry per Lambder instance: { module, exportName, and the files it is written to }.");
    }
    for (const [name, app] of Object.entries(apps)) {
        if (app === null || typeof app !== "object")
            throw new Error(`generateApiFiles: the app "${name}" is not an object.`);
        const unknownKeys = Object.keys(app).filter((key) => !APP_KEYS.includes(key));
        if (unknownKeys.length)
            throw new Error(`generateApiFiles: the app "${name}" has ${unknownKeys.map((key) => `"${key}"`).join(", ")}, which the generator does not read (it reads ${APP_KEYS.join(", ")}).`);
        if (!app.module)
            throw new Error(`generateApiFiles: the app "${name}" names no module to read its instance from.`);
        if (!FILE_KINDS.some((kind) => app[kind] !== undefined)) {
            throw new Error(`generateApiFiles: the app "${name}" is written to no file; give it a contract, signatures, options, guardParams or schemas.`);
        }
    }
}
/** A writer's run as lines: its own on success or a stale check, the reason when it threw. */
const settle = async (label, write) => {
    try {
        return await write();
    }
    catch (err) {
        const reasons = [];
        for (let cause = err; cause instanceof Error && reasons.length < 4; cause = cause.cause)
            reasons.push(cause.message);
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
const writeApiContractInOwnProcess = async (label, options, heapMegabytes) => {
    const request = { ...options, module: options.module instanceof URL ? options.module.href : options.module };
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMegabytes}`, fileURLToPath(CONTRACT_PRINTER_ENTRY), JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const ended = await new Promise((resolveEnd) => {
        child.once("error", (error) => resolveEnd({ error }));
        child.once("close", (status, signal) => resolveEnd({ status, signal }));
    });
    if ("error" in ended)
        return { ok: false, lines: [`✗ ${label} failed: the process to print it in could not start: ${ended.error.message}`] };
    const reportLine = stdout.split("\n").findLast((line) => line.startsWith(CONTRACT_REPORT_PREFIX));
    if (reportLine === undefined) {
        if (/JavaScript heap out of memory/i.test(stderr)) {
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
    const report = JSON.parse(reportLine.slice(CONTRACT_REPORT_PREFIX.length));
    if ("thrown" in report)
        throw report.thrown.reduceRight((cause, message) => new Error(message, cause ? { cause } : undefined), undefined);
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
export const generateApiFiles = async (config, options = {}) => {
    assertConfig(config);
    const check = options.check ?? false;
    const contractHeapMegabytes = options.contractHeapMegabytes ?? DEFAULT_CONTRACT_HEAP_MEGABYTES;
    if (!Number.isInteger(contractHeapMegabytes) || contractHeapMegabytes <= 0) {
        throw new Error(`generateApiFiles: contractHeapMegabytes is ${String(contractHeapMegabytes)}; give the heap of the process each contract is printed in as a whole number of megabytes, such as ${DEFAULT_CONTRACT_HEAP_MEGABYTES}.`);
    }
    const apps = Object.entries(config.apps);
    const runs = [];
    // The contracts first: they compile the app's sources and run none of
    // them, so a module that fails to load still gets its contract checked.
    for (const [name, app] of apps) {
        if (!app.contract)
            continue;
        const label = `${name}: the contract`;
        runs.push(await settle(label, () => writeApiContractInOwnProcess(label, { ...app.contract, module: app.module, exportName: app.exportName, tsconfig: app.tsconfig, check }, contractHeapMegabytes)));
    }
    // Then what is read off the instance itself, which importing the module
    // builds once for all of them.
    for (const [name, app] of apps) {
        const instance = { module: app.module, exportName: app.exportName, check };
        if (app.signatures)
            runs.push(await settle(`${name}: the signatures`, () => writeApiSignatures({ ...app.signatures, ...instance })));
        if (app.options)
            runs.push(await settle(`${name}: the options`, () => writeApiOptions({ ...app.options, ...instance })));
        for (const guardFile of app.guardParams ?? []) {
            runs.push(await settle(`${name}: the "${guardFile.guard}" guard parameters`, () => writeApiGuardParams({ ...guardFile, ...instance })));
        }
        if (app.schemas)
            runs.push(await settle(`${name}: the schemas`, () => writeApiSchemas({ ...app.schemas, ...instance })));
    }
    return { ok: runs.every((run) => run.ok), lines: runs.flatMap((run) => run.lines) };
};

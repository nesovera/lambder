import { writeApiContract } from "./writeApiContract.js";
import { writeApiSignatures } from "./writeApiSignatures.js";
import { writeApiOptions } from "./writeApiOptions.js";
import { writeApiGuardParams } from "./writeApiGuardParams.js";
const APP_KEYS = ["module", "exportName", "tsconfig", "contract", "signatures", "options", "guardParams"];
const FILE_KINDS = ["contract", "signatures", "options", "guardParams"];
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
            throw new Error(`generateApiFiles: the app "${name}" is written to no file; give it a contract, signatures, options or guardParams.`);
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
export const generateApiFiles = async (config, options = {}) => {
    assertConfig(config);
    const check = options.check ?? false;
    const apps = Object.entries(config.apps);
    const runs = [];
    // The contracts first: they compile the app's sources and run none of
    // them, so a module that fails to load still gets its contract checked.
    for (const [name, app] of apps) {
        if (!app.contract)
            continue;
        runs.push(await settle(`${name}: the contract`, () => writeApiContract({ ...app.contract, module: app.module, exportName: app.exportName, tsconfig: app.tsconfig, check })));
    }
    // Then what is read off the instance itself, which importing the module
    // builds once for all three.
    for (const [name, app] of apps) {
        const instance = { module: app.module, exportName: app.exportName, check };
        if (app.signatures)
            runs.push(await settle(`${name}: the signatures`, () => writeApiSignatures({ ...app.signatures, ...instance })));
        if (app.options)
            runs.push(await settle(`${name}: the options`, () => writeApiOptions({ ...app.options, ...instance })));
        for (const guardFile of app.guardParams ?? []) {
            runs.push(await settle(`${name}: the "${guardFile.guard}" guard parameters`, () => writeApiGuardParams({ ...guardFile, ...instance })));
        }
    }
    return { ok: runs.every((run) => run.ok), lines: runs.flatMap((run) => run.lines) };
};

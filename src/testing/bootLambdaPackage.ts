import { fork, type ChildProcess } from "child_process";
import { existsSync, realpathSync, statSync } from "fs";
import { extname, join, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { buildEnvelopeJson, decodeLambdaHttpResult, synthesizeLambdaHttpEvent } from "../invoke/LambderLambdaEvent.js";
import { LOOPBACK_CLIENT_IP } from "../shared/util/LambderClientIp.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { apiCallPath } from "../shared/wire/LambderApiNames.js";
import { resolveApiOutcome, type LambderApiOutcome } from "../shared/wire/LambderApiOutcome.js";
import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import { DEFAULT_API_PATH } from "../shared/wire/LambderDefaultApiPath.js";
import { DEFAULT_MAX_RESTORED_PAYLOAD_BYTES } from "../shared/wire/LambderRequestPayload.js";
import type { LambdaPackageBootCallRequest, LambdaPackageBootReport, LambdaPackageBootSetup } from "./lambdaPackageBootProcess.js";

/**
 * One call the booted handler receives: a Lambder API call, which becomes
 * the event a gateway (or, with `invoke`, another function) would deliver
 * for it, or an event exactly as given (a schedule, a queue message, an
 * HTTP request written out by hand).
 */
export type LambderPackageBootCall =
    | {
        /** The endpoint, as `group.action`. */
        api: string;
        /** The call's input. Default: none. */
        payload?: unknown;
        /** Headers the event carries beside the ones it owns. */
        headers?: Record<string, string>;
    }
    | {
        /** The event, handed to the handler as it is. */
        event: unknown;
        /** How the result names this call. Default: "event N", N its index. */
        name?: string;
    };

export type LambderPackageBootOptions = {
    /** The assembled deployment package: the directory that becomes the zip, with its production dependencies installed, if it has any. */
    packageDir: string;
    /** The handler as the function's configuration names it: the module's path in the package without its extension, a dot, and the export. Default: "index.handler". The module is the first of `.js`, `.mjs` and `.cjs` that exists, as on Lambda. */
    handler?: string;
    /** What the handler receives, in order, in the one process, as a warm function receives it. Default: none, so the package is only imported. */
    calls?: readonly LambderPackageBootCall[];
    /** Where the server takes API calls, for the calls given as `api`. Default: "/api". */
    apiPath?: string;
    /** The Host an API call's event names. Default: "localhost". */
    host?: string;
    /** The API version an API call's envelope carries, for a server with a version floor. Default: none. */
    apiVersion?: string;
    /** Send API calls as another function's invoke rather than as a browser's request through a gateway. Default: false. */
    invoke?: boolean;
    /** Package names and scopes the Lambda runtime supplies, so the package leaves them out. Default: ["@aws-sdk"]. */
    runtimeModules?: readonly string[];
    /** The directory runtimeModules resolve from, as if a module there imported them: an install that has them. Default: the working directory, normally the project's root. */
    runtimeModulesFrom?: string;
    /** The process's environment, beside PATH: the variables the function's configuration sets. Nothing else of this process's environment reaches it. Default: none. */
    env?: Record<string, string>;
    /** Node's options for the process, such as the heap sizes Lambda starts the function with, so what is measured is what the function pays. Default: none. */
    nodeFlags?: readonly string[];
    /** How long starting the process and importing the handler module may take. Default: 30,000. */
    importTimeoutMs?: number;
    /** How long each call may take. Default: 30,000. */
    callTimeoutMs?: number;
};

/** What loading the package cost, measured in the process that loaded it and nothing before it. */
export type LambderPackageBootMeasurements = {
    /** Importing the handler module and everything it imports statically: what a cold start pays before its first request. */
    importMs: number;
    /** The process's resident memory once that import finished. */
    rssBytes: number;
};

/** The handler's answer to one call. */
export type LambderPackageBootCallResult = {
    /** The call's endpoint, or its event's name. */
    name: string;
    /** What the handler returned, as Lambda hands it back: through JSON, null for nothing. */
    returned: unknown;
    /** The HTTP status, when the handler answered with an HTTP response. */
    status?: number;
    /** For an API call, what a caller reads off the answer, for assertApiSuccess, assertApiFailure and assertApiRefusal. */
    outcome?: LambderApiOutcome<unknown>;
};

export type LambderPackageBootResult = {
    /** Whether the package imported and the handler answered every call. */
    ok: boolean;
    /** Where it failed: "import" (starting the process and importing the handler module) or "handler" (a call threw, ran out of time, or the process died during it). */
    phase?: "import" | "handler";
    /** The call that failed, as its result would have named it. */
    failedCall?: string;
    /** What went wrong, ready to print: the phase or the call, the error, and the end of the process's output when it died. */
    error?: string;
    /** The answer to each call the handler answered, in order: all of them when `ok`. */
    calls: LambderPackageBootCallResult[];
    /** Present once the import finished. */
    measurements?: LambderPackageBootMeasurements;
    /** What the process wrote to stdout and stderr. */
    output: string;
};

const DEFAULT_HANDLER = "index.handler";
const DEFAULT_RUNTIME_MODULES: readonly string[] = ["@aws-sdk"];
const DEFAULT_TIMEOUT_MS = 30_000;

/** The extensions Lambda tries for a handler module, in its order. */
const HANDLER_MODULE_EXTENSIONS = [".js", ".mjs", ".cjs"];

/** A package name or a scope, which is what a runtime supplies whole. */
const PACKAGE_NAME_OR_SCOPE = /^(@[\w.~-]+(\/[\w.~-]+)?|[\w~-][\w.~-]*)$/;

/** How much of the process's output a failure that killed it quotes. */
const QUOTED_OUTPUT_LINES = 20;

/**
 * The boot process's entry, beside this module and in its form: the built
 * `.js` in an installed package, the `.ts` source where this module runs from
 * source on a Node that strips types.
 */
const BOOT_PROCESS_ENTRY = fileURLToPath(new URL(`./lambdaPackageBootProcess${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * The boot process, seen from here: its reports in the order they came, and
 * how it ended once it has. A report is read off the queue rather than waited
 * for as an event, since the process can report, or die, while this side is
 * still reading the answer before.
 */
class LambdaPackageBootProcess {
    readonly #child: ChildProcess;
    readonly #reports: LambdaPackageBootReport[] = [];
    readonly #closed: Promise<void>;
    #ending: string | null = null;
    #wake: (() => void) | null = null;
    output = "";

    constructor(setup: LambdaPackageBootSetup, options: { cwd: string; env: Record<string, string>; nodeFlags: readonly string[] }) {
        this.#child = fork(BOOT_PROCESS_ENTRY, [JSON.stringify(setup)], {
            cwd: options.cwd,
            env: options.env,
            // Never this process's own flags: the test runner's loaders and
            // conditions are not what Lambda starts node with.
            execArgv: [...options.nodeFlags],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        // Decoded as a stream, so a character split across two chunks
        // arrives whole.
        const collect = (text: string) => { this.output += text; };
        this.#child.stdout?.setEncoding("utf8").on("data", collect);
        this.#child.stderr?.setEncoding("utf8").on("data", collect);
        this.#child.on("message", (report) => {
            this.#reports.push(report as LambdaPackageBootReport);
            this.#wake?.();
        });
        let markClosed = () => {};
        this.#closed = new Promise((resolveClosed) => { markClosed = resolveClosed; });
        // "close" rather than "exit": it comes once the output and the
        // channel are drained, so no report or line is still on its way.
        this.#child.on("close", (code, signal) => {
            this.#ending ??= signal ? `was killed by ${signal}` : `exited with code ${code}`;
            this.#wake?.();
            markClosed();
        });
        // A process that never started has nothing to close.
        this.#child.on("error", (error) => {
            if(this.#child.pid !== undefined) return;
            this.#ending ??= `could not start: ${error.message}`;
            this.#wake?.();
            markClosed();
        });
    }

    send(request: LambdaPackageBootCallRequest): void {
        // A send that fails means the process has ended, which "close"
        // reports with its output; the error itself says less.
        this.#child.send(request, () => {});
    }

    /** The next report, or why none came: the process ended, or `timeoutMs` passed. */
    async nextReport(timeoutMs: number): Promise<LambdaPackageBootReport | { failure: string }> {
        const deadline = Date.now() + timeoutMs;
        for(;;){
            const report = this.#reports.shift();
            if(report) return report;
            if(this.#ending !== null){
                const tail = this.output.trimEnd().split("\n").slice(-QUOTED_OUTPUT_LINES).join("\n");
                return { failure: `the process ${this.#ending}${tail ? `; its output ends:\n${tail}` : " with no output"}` };
            }
            const remaining = deadline - Date.now();
            if(remaining <= 0) return { failure: `did not finish within ${timeoutMs} ms` };
            await new Promise<void>((wake) => {
                const timer = setTimeout(wake, remaining);
                this.#wake = () => { clearTimeout(timer); wake(); };
            });
            this.#wake = null;
        }
    }

    /** Ends the process, which the package may be holding open (a pool, a timer), and waits until its output is all in. */
    async stop(): Promise<void> {
        this.#ending ??= "was stopped";
        this.#child.kill("SIGKILL");
        await this.#closed;
    }
}

/**
 * Boots an assembled deployment package the way Lambda boots it, and hands
 * its handler each call in turn: in a fresh node process, so nothing of the
 * calling test's module graph or environment reaches it, with the package
 * directory as the working directory, and with every import the package
 * makes held to what the package carries. What the Lambda runtime supplies
 * (`runtimeModules`, the AWS SDK by default) resolves from an install
 * outside it instead, since the package rightly leaves it out.
 *
 * Makes no assertions: the result says whether the package imported and
 * answered, what each call answered, what the import cost, and where it
 * failed. Throws, before or after starting the process, for what is not
 * the package's doing: a missing directory, a handler that names no module
 * there or no function exported by it, an option out of range, or a Node
 * without synchronous module hooks.
 *
 * ```typescript
 * const boot = await bootLambdaPackage({ packageDir: "build/server", calls: [{ api: "status.ping" }] });
 * expect(boot.ok, boot.error).toBe(true);
 * assertApiSuccess(boot.calls[0]!.outcome!);
 * ```
 */
export const bootLambdaPackage = async (options: LambderPackageBootOptions): Promise<LambderPackageBootResult> => {
    const nodeModule = typeof process.getBuiltinModule === "function" ? process.getBuiltinModule("module") : undefined;
    if(typeof nodeModule?.registerHooks !== "function"){
        throw new Error("Lambder: bootLambdaPackage needs Node 22.15 or later, for the synchronous module hooks that hold the package's imports to the package.");
    }
    if(!existsSync(BOOT_PROCESS_ENTRY)) throw new Error(`Lambder: bootLambdaPackage's process entry is missing from ${BOOT_PROCESS_ENTRY}: is lambder installed whole?`);

    const packageDir = resolve(options.packageDir);
    if(!isDirectory(packageDir)) throw new Error(`Lambder: bootLambdaPackage packageDir ${packageDir} is not a directory.`);
    // The real path: a module's URL is its real path, so the test of
    // whether an import stays inside the package compares real paths too.
    const packageRoot = realpathSync(packageDir);

    const handler = options.handler ?? DEFAULT_HANDLER;
    const exportDot = handler.indexOf(".", handler.lastIndexOf("/") + 1);
    const modulePath = exportDot === -1 ? "" : handler.slice(0, exportDot);
    const handlerExport = exportDot === -1 ? "" : handler.slice(exportDot + 1);
    if(!modulePath || modulePath.endsWith("/") || !handlerExport){
        throw new Error(`Lambder: bootLambdaPackage handler "${handler}" is not a module and an export, as in "index.handler".`);
    }
    const handlerFile = HANDLER_MODULE_EXTENSIONS.map((extension) => join(packageRoot, modulePath + extension)).find((file) => existsSync(file));
    if(!handlerFile){
        throw new Error(`Lambder: bootLambdaPackage found no ${modulePath}.js, ${modulePath}.mjs or ${modulePath}.cjs in ${packageRoot} for the handler "${handler}".`);
    }

    const runtimeModules = options.runtimeModules ?? DEFAULT_RUNTIME_MODULES;
    for(const name of runtimeModules){
        if(!PACKAGE_NAME_OR_SCOPE.test(name)) throw new Error(`Lambder: bootLambdaPackage runtimeModules entry "${name}" is not a package name or a scope.`);
    }
    const runtimeModulesFrom = resolve(options.runtimeModulesFrom ?? process.cwd());
    if(!isDirectory(runtimeModulesFrom)) throw new Error(`Lambder: bootLambdaPackage runtimeModulesFrom ${runtimeModulesFrom} is not a directory.`);

    const importTimeoutMs = assertPositiveInteger(options.importTimeoutMs ?? DEFAULT_TIMEOUT_MS, "bootLambdaPackage importTimeoutMs");
    const callTimeoutMs = assertPositiveInteger(options.callTimeoutMs ?? DEFAULT_TIMEOUT_MS, "bootLambdaPackage callTimeoutMs");

    // Every event is built before the process starts, so a call that names no
    // endpoint throws here rather than after a boot.
    const apiPath = options.apiPath ?? DEFAULT_API_PATH;
    const host = options.host ?? "localhost";
    const calls = (options.calls ?? []).map((call, index) => {
        if("api" in call && typeof call.api === "string"){
            const event = synthesizeLambdaHttpEvent({
                method: "POST",
                path: apiCallPath(apiPath, call.api),
                host,
                headers: call.headers,
                contentType: "application/json",
                clientIp: LOOPBACK_CLIENT_IP,
                body: buildEnvelopeJson({
                    version: options.apiVersion,
                    siteHost: host,
                    payloadJson: call.payload === undefined ? undefined : JSON.stringify(call.payload),
                }),
            }, { invoke: options.invoke ?? false });
            return { name: call.api, event, isApiCall: true };
        }
        if("event" in call) return { name: call.name ?? `event ${index}`, event: call.event, isApiCall: false };
        throw new Error(`Lambder: bootLambdaPackage call ${index} is neither { api } nor { event }.`);
    });

    const boot = new LambdaPackageBootProcess({
        handlerUrl: pathToFileURL(handlerFile).href,
        handlerExport,
        packageUrl: `${pathToFileURL(packageRoot).href}/`,
        runtimeModules: [...runtimeModules],
        runtimeModulesFrom,
        callTimeoutMs,
    }, {
        cwd: packageRoot,
        // PATH alone of this process's environment: a function sees the
        // variables its configuration sets, and a test's (NODE_ENV, the
        // runner's own, credentials) would let the package pass on something
        // it never has when deployed.
        env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), ...options.env },
        nodeFlags: options.nodeFlags ?? [],
    });
    const results: LambderPackageBootCallResult[] = [];
    // The result is read once the process is gone, so its output is all in.
    const finish = async (fields: Omit<LambderPackageBootResult, "calls" | "output">): Promise<LambderPackageBootResult> => {
        await boot.stop();
        return { ...fields, calls: results, output: boot.output };
    };
    try {
        const handlerModule = relative(packageRoot, handlerFile);
        const imported = await boot.nextReport(importTimeoutMs);
        if("failure" in imported) return await finish({ ok: false, phase: "import", error: `importing ${handlerModule} failed: ${imported.failure}` });
        if(imported.kind === "importFailed") return await finish({ ok: false, phase: "import", error: `importing ${handlerModule} failed:\n${imported.error}` });
        if(imported.kind !== "imported") throw new Error(`Lambder: bootLambdaPackage's process reported "${imported.kind}" before its import.`);
        if(imported.handlerType !== "function"){
            const exportNames = imported.exportNames.length ? imported.exportNames.join(", ") : "nothing";
            throw new Error(`Lambder: bootLambdaPackage handler "${handler}": ${handlerModule} exports no function "${handlerExport}" (it exports ${exportNames}).`);
        }
        const measurements = { importMs: imported.importMs, rssBytes: imported.rssBytes };

        for(const [index, call] of calls.entries()){
            const callName = `call ${index} (${call.name})`;
            boot.send({ index, event: call.event });
            const answer = await boot.nextReport(callTimeoutMs);
            if("failure" in answer) return await finish({ ok: false, phase: "handler", failedCall: call.name, error: `${callName} ${answer.failure}`, measurements });
            if(answer.kind === "threw") return await finish({ ok: false, phase: "handler", failedCall: call.name, error: `${callName} threw:\n${answer.error}`, measurements });
            if(answer.kind !== "answered") throw new Error(`Lambder: bootLambdaPackage's process reported "${answer.kind}" for ${callName}.`);

            const returned = answer.returned;
            const statusCode = (returned as { statusCode?: unknown } | null)?.statusCode;
            const status = typeof statusCode === "number" ? statusCode : undefined;
            let outcome: LambderApiOutcome<unknown> | undefined;
            if(call.isApiCall){
                try {
                    const http = await decodeLambdaHttpResult(returned, DEFAULT_MAX_RESTORED_PAYLOAD_BYTES);
                    outcome = await resolveApiOutcome<unknown>({
                        status: http.statusCode,
                        header: (name) => http.headers[name.toLowerCase()] ?? null,
                        json: async () => http.json(),
                        text: async () => http.text(),
                    });
                } catch(error) {
                    // An answer no caller could read, as a caller reads it.
                    outcome = { ok: false, reason: "server", status, error: coerceToError(error) };
                }
            }
            results.push({ name: call.name, returned, ...(status === undefined ? {} : { status }), ...(outcome ? { outcome } : {}) });
        }
        return await finish({ ok: true, measurements });
    } finally {
        // Also on a throw, which leaves the process running otherwise.
        await boot.stop();
    }
};

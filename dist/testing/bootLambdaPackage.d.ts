import { type LambderApiOutcome } from "../shared/wire/LambderApiOutcome.js";
/**
 * One call the booted handler receives: a Lambder API call, which becomes
 * the event a gateway (or, with `invoke`, another function) would deliver
 * for it, or an event exactly as given (a schedule, a queue message, an
 * HTTP request written out by hand).
 */
export type LambderPackageBootCall = {
    /** The endpoint, as `group.action`. */
    api: string;
    /** The call's input. Default: none. */
    payload?: unknown;
    /** Headers the event carries beside the ones it owns. */
    headers?: Record<string, string>;
} | {
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
export declare const bootLambdaPackage: (options: LambderPackageBootOptions) => Promise<LambderPackageBootResult>;

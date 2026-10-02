import { fileURLToPath, pathToFileURL } from "url";
const setup = JSON.parse(process.argv[2] ?? "null");
// The parent kills this process on every way out of its own, but cannot when
// it dies itself (a test runner tearing down a test that timed out). The
// channel closing is the one sign of that, and what the package keeps running
// (a timer, a pool) would otherwise keep this process alive with no parent.
process.on("disconnect", () => process.exit(1));
// Taken from getBuiltinModule rather than imported: every built-in the
// sources import is one package.json's browser field stubs for bundlers, and
// this file never reaches a bundle, only this process.
const { createRequire, registerHooks } = process.getBuiltinModule("module");
const report = (message) => {
    process.send?.(message);
};
/** An error as text that survives the channel: its stack, and the chain of causes under it. */
const describeError = (error) => {
    if (!(error instanceof Error))
        return String(error);
    const text = error.stack ?? `${error.name}: ${error.message}`;
    return error.cause === undefined ? text : `${text}\nCaused by: ${describeError(error.cause)}`;
};
const isRuntimeSupplied = (specifier) => setup.runtimeModules.some((name) => specifier === name || specifier.startsWith(`${name}/`));
// A module in that directory, which need not exist: resolution starts from
// the directory it would sit in.
const runtimeModulesParentUrl = `${pathToFileURL(setup.runtimeModulesFrom).href}/runtime-modules.js`;
/**
 * A specifier naming a place on the function's own filesystem (a layer
 * under /opt, say), which the author wrote on purpose and which is not this
 * machine's to judge, unlike a bare name or a relative path, whose
 * resolution is what decides whether the package carries it.
 */
const ABSOLUTE_SPECIFIER = /^(file:|\/|[A-Za-z]:[\\/])/;
// Every import made from inside the package by a bare name or a relative path
// is held to the package, as on Lambda, where the package directory has no
// node_modules above it to fall back on: a dependency the package does not
// carry, or a relative import out of it, would otherwise resolve from
// whatever install the directory happens to sit in and pass here only to
// fail when deployed. The one exception is what the runtime supplies, which
// the package rightly leaves out and which resolves from runtimeModulesFrom
// instead, unless the package carries its own copy, which wins on Lambda
// too. Imports made by modules outside the package (those runtime modules'
// own) resolve as usual. Synchronous hooks, so `require` is held to the same
// rule as `import`.
registerHooks({
    resolve(specifier, context, nextResolve) {
        const parentURL = context.parentURL;
        if (!parentURL?.startsWith(setup.packageUrl) || ABSOLUTE_SPECIFIER.test(specifier))
            return nextResolve(specifier, context);
        const runtimeSupplied = isRuntimeSupplied(specifier);
        const fromRuntime = () => {
            try {
                // require() resolves from the module that calls it whatever
                // parentURL says, so it is resolved here; import() follows
                // parentURL.
                if (context.conditions.includes("require")) {
                    return { url: pathToFileURL(createRequire(runtimeModulesParentUrl).resolve(specifier)).href, shortCircuit: true };
                }
                return nextResolve(specifier, { ...context, parentURL: runtimeModulesParentUrl });
            }
            catch (error) {
                throw new Error(`"${specifier}" is supplied by the Lambda runtime, so the package leaves it out, and it resolves from ${setup.runtimeModulesFrom} instead, ` +
                    "where it is not installed either: install it there, or point runtimeModulesFrom at an install that has it.", { cause: error });
            }
        };
        let resolved;
        try {
            resolved = nextResolve(specifier, context);
        }
        catch (error) {
            if (runtimeSupplied)
                return fromRuntime();
            throw error;
        }
        if (!resolved.url.startsWith("file:") || resolved.url.startsWith(setup.packageUrl))
            return resolved;
        if (runtimeSupplied)
            return fromRuntime();
        throw new Error(`"${specifier}", imported by ${fileURLToPath(parentURL)}, is not in the package: it resolves to ${fileURLToPath(resolved.url)}, ` +
            "outside the package directory, and a deployment carries only what is inside it.");
    },
});
let handler;
try {
    // What a cold start pays before its first request: evaluating the module
    // and everything it imports statically, in a process that loaded none of
    // it before.
    const importStart = performance.now();
    const namespace = await import(setup.handlerUrl);
    const importMs = Math.round(performance.now() - importStart);
    const rssBytes = process.memoryUsage().rss;
    // A CommonJS module's exports arrive as the default export, and as named
    // ones only as far as Node detects them statically.
    const exported = namespace[setup.handlerExport] ?? namespace.default?.[setup.handlerExport];
    handler = exported;
    // Listening before the report goes out, so the first call cannot arrive
    // to nobody.
    if (typeof exported === "function")
        process.on("message", (request) => void answer(request));
    report({ kind: "imported", importMs, rssBytes, handlerType: typeof exported, exportNames: Object.keys(namespace) });
}
catch (error) {
    report({ kind: "importFailed", error: describeError(error) });
}
async function answer({ index, event }) {
    const deadline = Date.now() + setup.callTimeoutMs;
    const context = {
        callbackWaitsForEmptyEventLoop: true,
        functionName: "lambder-boot-check",
        functionVersion: "$LATEST",
        invokedFunctionArn: "arn:aws:lambda:local:000000000000:function:lambder-boot-check",
        memoryLimitInMB: "128",
        awsRequestId: `lambder-boot-check-${index}`,
        logGroupName: "/aws/lambda/lambder-boot-check",
        logStreamName: "local",
        getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
        done: () => { },
        fail: () => { },
        succeed: () => { },
    };
    try {
        // Through JSON, as Lambda returns an answer: what reaches the parent
        // is what an invoker would receive, and an answer JSON cannot carry
        // fails here as it would there.
        const json = JSON.stringify(await handler(event, context));
        report({ kind: "answered", index, returned: json === undefined ? null : JSON.parse(json) });
    }
    catch (error) {
        report({ kind: "threw", index, error: describeError(error) });
    }
}

import { resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * The module a generator reads the instance from, as both of lambder/build's
 * generators take it: a path relative to the working directory, or a file
 * URL, as a URL (`new URL("../server/index.ts", import.meta.url)`) or as the
 * string `import.meta.resolve()` answers.
 */
export type LambderModuleLocation = string | URL;

/** The module as a file URL. A string that already is one is taken as one: resolved as a path, it would name a directory called "file:". */
export const moduleUrlOf = (module: LambderModuleLocation): string =>
    typeof module === "string" && !/^file:/i.test(module) ? pathToFileURL(resolve(module)).href : new URL(module).href;

/** The module as a path on disk. */
export const modulePathOf = (module: LambderModuleLocation): string => fileURLToPath(moduleUrlOf(module));

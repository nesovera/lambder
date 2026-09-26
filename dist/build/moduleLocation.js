import { resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
/** The module as a file URL. A string that already is one is taken as one: resolved as a path, it would name a directory called "file:". */
export const moduleUrlOf = (module) => typeof module === "string" && !/^file:/i.test(module) ? pathToFileURL(resolve(module)).href : new URL(module).href;
/** The module as a path on disk. */
export const modulePathOf = (module) => fileURLToPath(moduleUrlOf(module));

/**
 * The module a generator reads the instance from, as both of lambder/build's
 * generators take it: a path relative to the working directory, or a file
 * URL, as a URL (`new URL("../server/index.ts", import.meta.url)`) or as the
 * string `import.meta.resolve()` answers.
 */
export type LambderModuleLocation = string | URL;
/** The module as a file URL. A string that already is one is taken as one: resolved as a path, it would name a directory called "file:". */
export declare const moduleUrlOf: (module: LambderModuleLocation) => string;
/** The module as a path on disk. */
export declare const modulePathOf: (module: LambderModuleLocation) => string;

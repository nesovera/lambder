/** The typescript package as the build tools read it: its compiler API. */
export type TypeScriptModule = typeof import("typescript");
/**
 * The compiler API a build tool reads a project through, from the typescript
 * package installed beside lambder. TypeScript 7 ships none, so its package
 * answers the import without one, and an app on TypeScript 7 installs a 6.x
 * where its generator script runs. `reader` says who reads what, for the
 * error: "writeApiContract reads the contract".
 */
export declare const loadTypeScriptCompiler: (reader: string) => Promise<TypeScriptModule>;

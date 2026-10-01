/**
 * The compiler API a build tool reads a project through, from the typescript
 * package installed beside lambder. TypeScript 7 ships none, so its package
 * answers the import without one, and an app on TypeScript 7 installs a 6.x
 * where its generator script runs. `reader` says who reads what, for the
 * error: "writeApiContract reads the contract".
 */
export const loadTypeScriptCompiler = async (reader) => {
    const requirement = `${reader} through the TypeScript compiler API (typescript 5.4 to 6.x): install one beside lambder, such as in the generator's own package when the app is on TypeScript 7`;
    let ts;
    try {
        ts = (await import("typescript")).default;
    }
    catch (err) {
        throw new Error(requirement, { cause: err });
    }
    if (typeof ts?.createProgram !== "function")
        throw new Error(`${requirement}; the typescript installed (${ts?.version ?? "unknown"}) has no compiler API`);
    return ts;
};

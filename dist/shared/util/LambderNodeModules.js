/**
 * The Node built-ins Lambder uses where they exist, and nothing where they do
 * not: the same code runs on Lambda and in a browser, so every one of these
 * is optional and every caller handles null.
 */
/**
 * One of these modules, or null where the runtime has no such thing.
 *
 * A failed import is only half of "no such thing". The other half is a
 * bundler: package.json maps fs, path, zlib and crypto to `false` for the
 * browser, and webpack, Vite and esbuild resolve such an import to a stub
 * object rather than rejecting it, so a truthiness test would call the stub
 * usable and the caller would die on its first real call. `expect` names a
 * function the genuine module exports; a module without it is not the module.
 *
 * The answer, absence included, is memoized, so the probe runs once per
 * module.
 */
const loadNodeModule = (load, expect) => {
    let pending = null;
    return () => {
        pending ??= (async () => {
            try {
                const nodeModule = await load();
                return typeof nodeModule?.[expect] === "function" ? nodeModule : null;
            }
            catch {
                // Silently fail - we're in a browser environment
                return null;
            }
        })();
        return pending;
    };
};
export const getFS = loadNodeModule(() => import('fs'), "readFile");
export const getPath = loadNodeModule(() => import('path'), "join");
export const getZlib = loadNodeModule(() => import('zlib'), "gunzip");
export const getCrypto = loadNodeModule(() => import('crypto'), "createHash");

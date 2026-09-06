import type { LambderRenderContext } from "./LambderContext.js";
import { LambderResponse } from "./LambderResponse.js";
export type LambderPublicFilesOptions = {
    /**
     * Map the request to a file path under publicPath (app-owned logic, e.g.
     * per-tenant roots: (ctx) => `${brand(ctx.host)}${ctx.path}`). Return
     * null/undefined to skip. Default: (ctx) => ctx.path.
     */
    path?: (ctx: LambderRenderContext) => string | null | undefined;
    /** Cache-Control for served files. Default: "public, max-age=3600". */
    cacheControl?: string | ((ctx: LambderRenderContext, filePath: string) => string);
    /** Filenames matching this get immutableCacheControl. Default: content-hash heuristic. Set false to disable. */
    immutablePattern?: RegExp | false;
    /** Default: "public, max-age=31536000, immutable". */
    immutableCacheControl?: string;
    /** In-memory cache of files for warm invocations. Default: { maxBytes: 32MB, maxFileBytes: 2MB }. Set false to disable. */
    memoryCache?: false | {
        maxBytes?: number;
        maxFileBytes?: number;
    };
    /**
     * Compression per file: "auto" (default: compressible mime + size threshold),
     * true/false, or a function, e.g. (ctx) => /\.(css|js|svg)$/.test(ctx.path).
     */
    compress?: boolean | "auto" | ((ctx: LambderRenderContext) => boolean | "auto");
};
/**
 * Terminal public-file handler registered via lambder.servePublicFiles().
 * Runs only when no route matched, so it can never shadow routes registered
 * after it. Serves real files under publicPath (traversal-safe, mime-typed,
 * memory-cached, immutable-cache heuristic for content-hashed assets) and
 * falls through to the route fallback when the file does not exist.
 */
export declare class LambderPublicFilesHandler {
    private publicPath;
    private options;
    private fileCache;
    private fileCacheBytes;
    constructor(publicPath: string, options: LambderPublicFilesOptions);
    /** Serve the mapped file, or return null to fall through. */
    handle(ctx: LambderRenderContext): Promise<LambderResponse | null>;
    /** Join base+target and require the result to stay under base. */
    private resolveSafe;
    /** Read a file, caching small files in memory for warm invocations. */
    private readFileCached;
    private cacheControlFor;
}

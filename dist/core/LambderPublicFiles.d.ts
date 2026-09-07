import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderFiles } from "./LambderFiles.js";
import { LambderResponse } from "./LambderResponse.js";
/** Per-registration policy of servePublicFiles: how a request maps to a file and how the response is cached. */
export type LambderPublicFilesOptions = {
    /**
     * Map the request to a file path (app-owned logic, e.g. per-tenant
     * roots: (ctx) => `${brand(ctx.host)}${ctx.path}`). Return
     * null/undefined to skip. Default: (ctx) => ctx.path.
     */
    path?: (ctx: LambderRenderContext) => string | null | undefined;
    /** Cache-Control for served files; the function receives the relative file path. Default: "public, max-age=3600". */
    cacheControl?: string | ((ctx: LambderRenderContext, relativePath: string) => string);
    /** Filenames matching this get immutableCacheControl. Default: content-hash heuristic. Set false to disable. */
    immutablePattern?: RegExp | false;
    /** Default: "public, max-age=31536000, immutable". */
    immutableCacheControl?: string;
    /**
     * Compression per file: "auto" (default: compressible mime + size threshold),
     * true/false, or a function, e.g. (ctx) => /\.(css|js|svg)$/.test(ctx.path).
     */
    compress?: boolean | "auto" | ((ctx: LambderRenderContext) => boolean | "auto");
};
/**
 * Terminal public-file handler registered via lambder.servePublicFiles().
 * Runs only when no route matched, so it can never shadow routes registered
 * after it. Serves files through the instance's reader (traversal-safe,
 * mime-typed, memory-cached) with the immutable-cache heuristic for
 * content-hashed assets, and falls through to the route fallback when the
 * source has no such file.
 */
export declare class LambderPublicFilesHandler {
    private files;
    private options;
    constructor(files: LambderFiles, options: LambderPublicFilesOptions);
    /** Serve the mapped file, or return null to fall through. */
    handle(ctx: LambderRenderContext): Promise<LambderResponse | null>;
    private cacheControlFor;
}

import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderFiles } from "./LambderFiles.js";
import { LambderResponse } from "./LambderResponse.js";
/** Per-registration policy of servePublicFiles: how a request maps to a file and how the response is cached. */
export type LambderPublicFilesOptions = {
    /** Methods that reach the public-file layer. Default: ["GET", "HEAD"], the same gate and the same default its serveIndexHtml sibling has. */
    methods?: string[];
    /**
     * Map the request to a file path (app-owned logic, e.g. per-tenant
     * roots: (ctx, filePath) => `${brand(ctx.host)}${filePath}`). `filePath`
     * is the file ctx.path names, its kept `%25` read as `%`; a path with an
     * encoded slash inside a segment names no file and never reaches the
     * mapper. Return null/undefined to skip. Default: the file path as it is.
     */
    path?: (ctx: LambderRenderContext, filePath: string) => string | null | undefined;
    /** Cache-Control for served files; the function receives the relative file path. Default: "public, max-age=3600". */
    cacheControl?: string | ((ctx: LambderRenderContext, relativePath: string) => string);
    /** Relative paths matching this get immutableCacheControl. Default: content-hashed names in a bundler's output folder (assets/, static/, _next/static/). Set false to disable. */
    immutablePattern?: RegExp | false;
    /**
     * Default: "public, max-age=31536000, immutable". Like any Cache-Control,
     * it goes out private, without `immutable`, on an answer that also sets a
     * cookie (a hook's guest session, a slid session cookie): see emitResponse.
     */
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
 * after it. Serves files through the instance's reader (one path rule,
 * mime-typed, memory-cached) with the immutable-cache heuristic for
 * content-hashed assets, and falls through to the route fallback when the
 * method is not configured or the source has no such file.
 */
export declare class LambderPublicFilesHandler {
    private files;
    private options;
    private methods;
    constructor(files: LambderFiles, options: LambderPublicFilesOptions);
    /** Serve the mapped file, or return null to fall through. */
    handle(ctx: LambderRenderContext): Promise<LambderResponse | null>;
    private cacheControlFor;
}

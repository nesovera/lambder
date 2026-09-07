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

// Content-hashed build outputs (Vite/webpack/Rollup): a [-.] separated run of
// 8+ hash chars containing at least one digit, before the extension.
const DEFAULT_IMMUTABLE_PATTERN = /[-.](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const DEFAULT_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DEFAULT_CACHE_CONTROL = "public, max-age=3600";

/**
 * Terminal public-file handler registered via lambder.servePublicFiles().
 * Runs only when no route matched, so it can never shadow routes registered
 * after it. Serves files through the instance's reader (traversal-safe,
 * mime-typed, memory-cached) with the immutable-cache heuristic for
 * content-hashed assets, and falls through to the route fallback when the
 * source has no such file.
 */
export class LambderPublicFilesHandler {
    private files: LambderFiles;
    private options: LambderPublicFilesOptions;

    constructor(files: LambderFiles, options: LambderPublicFilesOptions){
        this.files = files;
        this.options = options;
    }

    /** Serve the mapped file, or return null to fall through. */
    async handle(ctx: LambderRenderContext): Promise<LambderResponse | null> {
        const mappedPath = this.options.path ? this.options.path(ctx) : ctx.path;
        if(!mappedPath) return null;

        const file = await this.files.read(mappedPath);
        if(!file) return null;

        const compressOption = this.options.compress;
        const compress = typeof compressOption === "function" ? compressOption(ctx) : (compressOption ?? "auto");

        return new LambderResponse({
            statusCode: 200,
            headers: {
                "Content-Type": file.mimeType,
                "Cache-Control": this.cacheControlFor(ctx, file.relativePath),
            },
            body: file.body,
            compress,
        });
    }

    private cacheControlFor(ctx: LambderRenderContext, relativePath: string): string {
        const cacheOption = this.options.cacheControl;
        if(typeof cacheOption === "function") return cacheOption(ctx, relativePath);

        const immutablePattern = this.options.immutablePattern === false
            ? null
            : (this.options.immutablePattern ?? DEFAULT_IMMUTABLE_PATTERN);
        if(immutablePattern && immutablePattern.test(relativePath)){
            return this.options.immutableCacheControl ?? DEFAULT_IMMUTABLE_CACHE_CONTROL;
        }
        return cacheOption ?? DEFAULT_CACHE_CONTROL;
    }
}

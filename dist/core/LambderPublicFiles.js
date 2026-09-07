import { LambderResponse } from "./LambderResponse.js";
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
    files;
    options;
    constructor(files, options) {
        this.files = files;
        this.options = options;
    }
    /** Serve the mapped file, or return null to fall through. */
    async handle(ctx) {
        const mappedPath = this.options.path ? this.options.path(ctx) : ctx.path;
        if (!mappedPath)
            return null;
        const file = await this.files.read(mappedPath);
        if (!file)
            return null;
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
    cacheControlFor(ctx, relativePath) {
        const cacheOption = this.options.cacheControl;
        if (typeof cacheOption === "function")
            return cacheOption(ctx, relativePath);
        const immutablePattern = this.options.immutablePattern === false
            ? null
            : (this.options.immutablePattern ?? DEFAULT_IMMUTABLE_PATTERN);
        if (immutablePattern && immutablePattern.test(relativePath)) {
            return this.options.immutableCacheControl ?? DEFAULT_IMMUTABLE_CACHE_CONTROL;
        }
        return cacheOption ?? DEFAULT_CACHE_CONTROL;
    }
}

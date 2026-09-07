import mimeTypeResolver from "mime-types";
import { getFS, getPath } from "../shared/node-polyfills.js";
import { LambderResponse } from "./LambderResponse.js";
// Content-hashed build outputs (Vite/webpack/Rollup): a [-.] separated run of
// 8+ hash chars containing at least one digit, before the extension.
const DEFAULT_IMMUTABLE_PATTERN = /[-.](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const DEFAULT_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DEFAULT_CACHE_CONTROL = "public, max-age=3600";
const DEFAULT_MEMORY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * Files from a folder on the Lambda's filesystem, typically the build output
 * bundled into the deployment package. Reads stay under root. The default
 * source of servePublicFiles, over publicPath.
 */
export class LambderLocalFileSource {
    root;
    constructor({ root }) {
        this.root = root;
    }
    async read(relativePath) {
        const fs = await getFS();
        const path = await getPath();
        if (!fs || !path)
            throw new Error("LambderLocalFileSource requires a Node.js environment.");
        const base = path.resolve(this.root);
        const absolute = path.resolve(base, relativePath);
        if (absolute !== base && !absolute.startsWith(base + path.sep))
            return null;
        const stat = await fs.promises.stat(absolute).catch(() => null);
        if (!stat?.isFile())
            return null;
        return { body: await fs.promises.readFile(absolute) };
    }
}
/** Strip the leading slash and reject traversal; null for a path that names no file (empty, or a directory). */
const toRelativePath = (target) => {
    if (target.split("/").some((segment) => segment === ".."))
        return null;
    const relative = target.startsWith("/") ? target.slice(1) : target;
    if (relative === "" || relative.endsWith("/"))
        return null;
    return relative;
};
/**
 * Terminal public-file handler registered via lambder.servePublicFiles().
 * Runs only when no route matched, so it can never shadow routes registered
 * after it. Serves files from its source (traversal-safe, mime-typed,
 * memory-cached, immutable-cache heuristic for content-hashed assets) and
 * falls through to the route fallback when the source has no such file.
 */
export class LambderPublicFilesHandler {
    source;
    options;
    fileCache = new Map();
    fileCacheBytes = 0;
    constructor(source, options) {
        this.source = source;
        this.options = options;
    }
    /** Serve the mapped file, or return null to fall through. */
    async handle(ctx) {
        const mappedPath = this.options.path ? this.options.path(ctx) : ctx.path;
        if (!mappedPath)
            return null;
        const relativePath = toRelativePath(mappedPath);
        if (relativePath === null)
            return null;
        const file = await this.readCached(relativePath);
        if (!file)
            return null;
        const compressOption = this.options.compress;
        const compress = typeof compressOption === "function" ? compressOption(ctx) : (compressOption ?? "auto");
        return new LambderResponse({
            statusCode: 200,
            headers: {
                "Content-Type": file.mimeType,
                "Cache-Control": this.cacheControlFor(ctx, relativePath),
            },
            body: file.body,
            compress,
        });
    }
    /** Read from the source, caching small files in memory for warm invocations. */
    async readCached(relativePath) {
        const cached = this.fileCache.get(relativePath);
        if (cached)
            return cached;
        const file = await this.source.read(relativePath);
        if (!file)
            return null;
        const entry = {
            body: file.body,
            mimeType: file.mimeType || mimeTypeResolver.lookup(relativePath) || "application/octet-stream",
        };
        const cacheConfig = this.options.memoryCache;
        if (cacheConfig !== false) {
            const maxBytes = cacheConfig?.maxBytes ?? DEFAULT_MEMORY_CACHE_MAX_BYTES;
            const maxFileBytes = cacheConfig?.maxFileBytes ?? DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES;
            if (entry.body.length <= maxFileBytes) {
                // Evict oldest entries until the new file fits the budget.
                for (const [key, value] of this.fileCache) {
                    if (this.fileCacheBytes + entry.body.length <= maxBytes)
                        break;
                    this.fileCache.delete(key);
                    this.fileCacheBytes -= value.body.length;
                }
                if (this.fileCacheBytes + entry.body.length <= maxBytes) {
                    this.fileCache.set(relativePath, entry);
                    this.fileCacheBytes += entry.body.length;
                }
            }
        }
        return entry;
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

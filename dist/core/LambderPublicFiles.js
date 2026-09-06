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
 * Terminal public-file handler registered via lambder.servePublicFiles().
 * Runs only when no route matched, so it can never shadow routes registered
 * after it. Serves real files under publicPath (traversal-safe, mime-typed,
 * memory-cached, immutable-cache heuristic for content-hashed assets) and
 * falls through to the route fallback when the file does not exist.
 */
export class LambderPublicFilesHandler {
    publicPath;
    options;
    fileCache = new Map();
    fileCacheBytes = 0;
    constructor(publicPath, options) {
        this.publicPath = publicPath;
        this.options = options;
    }
    /** Serve the mapped file, or return null to fall through. */
    async handle(ctx) {
        const fs = await getFS();
        const path = await getPath();
        if (!fs || !path)
            throw new Error("servePublicFiles requires a Node.js environment.");
        const mappedPath = this.options.path ? this.options.path(ctx) : ctx.path;
        if (!mappedPath)
            return null;
        const publicRoot = path.resolve(this.publicPath);
        const filePath = this.resolveSafe(path, publicRoot, mappedPath);
        if (!filePath)
            return null;
        const file = await this.readFileCached(fs, filePath);
        if (!file)
            return null;
        const compressOption = this.options.compress;
        const compress = typeof compressOption === "function" ? compressOption(ctx) : (compressOption ?? "auto");
        return new LambderResponse({
            statusCode: 200,
            headers: {
                "Content-Type": file.mimeType,
                "Cache-Control": this.cacheControlFor(ctx, filePath),
            },
            body: file.body,
            compress,
        });
    }
    /** Join base+target and require the result to stay under base. */
    resolveSafe(path, base, target) {
        if (target.split("/").some((segment) => segment === ".."))
            return null;
        const normalizedTarget = target.startsWith("/") ? target.slice(1) : target;
        const absolute = path.resolve(base, normalizedTarget);
        if (absolute !== base && !absolute.startsWith(base + path.sep))
            return null;
        return absolute;
    }
    /** Read a file, caching small files in memory for warm invocations. */
    async readFileCached(fs, filePath) {
        const cached = this.fileCache.get(filePath);
        if (cached)
            return cached;
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat?.isFile())
            return null;
        const body = await fs.promises.readFile(filePath);
        const mimeType = mimeTypeResolver.lookup(filePath) || "application/octet-stream";
        const entry = { body, mimeType };
        const cacheConfig = this.options.memoryCache;
        if (cacheConfig !== false) {
            const maxBytes = cacheConfig?.maxBytes ?? DEFAULT_MEMORY_CACHE_MAX_BYTES;
            const maxFileBytes = cacheConfig?.maxFileBytes ?? DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES;
            if (body.length <= maxFileBytes) {
                // Evict oldest entries until the new file fits the budget.
                for (const [key, value] of this.fileCache) {
                    if (this.fileCacheBytes + body.length <= maxBytes)
                        break;
                    this.fileCache.delete(key);
                    this.fileCacheBytes -= value.body.length;
                }
                if (this.fileCacheBytes + body.length <= maxBytes) {
                    this.fileCache.set(filePath, entry);
                    this.fileCacheBytes += body.length;
                }
            }
        }
        return entry;
    }
    cacheControlFor(ctx, filePath) {
        const cacheOption = this.options.cacheControl;
        if (typeof cacheOption === "function")
            return cacheOption(ctx, filePath);
        const immutablePattern = this.options.immutablePattern === false
            ? null
            : (this.options.immutablePattern ?? DEFAULT_IMMUTABLE_PATTERN);
        if (immutablePattern && immutablePattern.test(filePath)) {
            return this.options.immutableCacheControl ?? DEFAULT_IMMUTABLE_CACHE_CONTROL;
        }
        return cacheOption ?? DEFAULT_CACHE_CONTROL;
    }
}

import mimeTypeResolver from "mime-types";
import { getFS, getPath } from "../shared/node-polyfills.js";
import type { LambderRenderContext } from "./LambderContext.js";
import { LambderResponse } from "./LambderResponse.js";

/** A file a source serves: its bytes, and its mime type when the source knows it (otherwise resolved from the extension). */
export type LambderPublicFile = { body: Buffer; mimeType?: string };

/**
 * Where servePublicFiles gets its files. Implement `read` over any backing
 * store: LambderLocalFileSource (a folder, the default), LambderS3FileSource
 * (S3, or R2 and other S3-compatible stores), or your own. The handler does
 * the rest for every source: traversal check, memory cache, mime fallback
 * from the extension, Cache-Control, ETag and compression.
 */
export interface LambderPublicFileSource {
    /**
     * The file at a relative path (no leading slash, no ".." segments: the
     * handler rejects those before calling), or null when there is no such
     * file, which lets the request fall through to the route fallback.
     */
    read(relativePath: string): Promise<LambderPublicFile | null>;
}

export type LambderPublicFilesOptions = {
    /** Where files come from. Default: LambderLocalFileSource over publicPath. */
    source?: LambderPublicFileSource;
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
    /** In-memory cache of files for warm invocations. Default: { maxBytes: 32MB, maxFileBytes: 2MB }. Set false to disable. */
    memoryCache?: false | { maxBytes?: number; maxFileBytes?: number };
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
const DEFAULT_MEMORY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Files from a folder on the Lambda's filesystem, typically the build output
 * bundled into the deployment package. Reads stay under root. The default
 * source of servePublicFiles, over publicPath.
 */
export class LambderLocalFileSource implements LambderPublicFileSource {
    private root: string;

    constructor({ root }: { root: string }){
        this.root = root;
    }

    async read(relativePath: string): Promise<LambderPublicFile | null> {
        const fs = await getFS();
        const path = await getPath();
        if(!fs || !path) throw new Error("LambderLocalFileSource requires a Node.js environment.");

        const base = path.resolve(this.root);
        const absolute = path.resolve(base, relativePath);
        if(absolute !== base && !absolute.startsWith(base + path.sep)) return null;

        const stat = await fs.promises.stat(absolute).catch(() => null);
        if(!stat?.isFile()) return null;
        return { body: await fs.promises.readFile(absolute) };
    }
}

/** Strip the leading slash and reject traversal; null for a path that names no file (empty, or a directory). */
const toRelativePath = (target: string): string | null => {
    if(target.split("/").some((segment) => segment === "..")) return null;
    const relative = target.startsWith("/") ? target.slice(1) : target;
    if(relative === "" || relative.endsWith("/")) return null;
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
    private source: LambderPublicFileSource;
    private options: LambderPublicFilesOptions;
    private fileCache = new Map<string, { body: Buffer, mimeType: string }>();
    private fileCacheBytes = 0;

    constructor(source: LambderPublicFileSource, options: LambderPublicFilesOptions){
        this.source = source;
        this.options = options;
    }

    /** Serve the mapped file, or return null to fall through. */
    async handle(ctx: LambderRenderContext): Promise<LambderResponse | null> {
        const mappedPath = this.options.path ? this.options.path(ctx) : ctx.path;
        if(!mappedPath) return null;

        const relativePath = toRelativePath(mappedPath);
        if(relativePath === null) return null;

        const file = await this.readCached(relativePath);
        if(!file) return null;

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
    private async readCached(relativePath: string): Promise<{ body: Buffer, mimeType: string } | null> {
        const cached = this.fileCache.get(relativePath);
        if(cached) return cached;

        const file = await this.source.read(relativePath);
        if(!file) return null;
        const entry = {
            body: file.body,
            mimeType: file.mimeType || mimeTypeResolver.lookup(relativePath) || "application/octet-stream",
        };

        const cacheConfig = this.options.memoryCache;
        if(cacheConfig !== false){
            const maxBytes = cacheConfig?.maxBytes ?? DEFAULT_MEMORY_CACHE_MAX_BYTES;
            const maxFileBytes = cacheConfig?.maxFileBytes ?? DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES;
            if(entry.body.length <= maxFileBytes){
                // Evict oldest entries until the new file fits the budget.
                for(const [key, value] of this.fileCache){
                    if(this.fileCacheBytes + entry.body.length <= maxBytes) break;
                    this.fileCache.delete(key);
                    this.fileCacheBytes -= value.body.length;
                }
                if(this.fileCacheBytes + entry.body.length <= maxBytes){
                    this.fileCache.set(relativePath, entry);
                    this.fileCacheBytes += entry.body.length;
                }
            }
        }
        return entry;
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

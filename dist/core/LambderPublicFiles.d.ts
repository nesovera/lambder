import type { LambderRenderContext } from "./LambderContext.js";
import { LambderResponse } from "./LambderResponse.js";
/** A file a source serves: its bytes, and its mime type when the source knows it (otherwise resolved from the extension). */
export type LambderPublicFile = {
    body: Buffer;
    mimeType?: string;
};
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
 * Files from a folder on the Lambda's filesystem, typically the build output
 * bundled into the deployment package. Reads stay under root. The default
 * source of servePublicFiles, over publicPath.
 */
export declare class LambderLocalFileSource implements LambderPublicFileSource {
    private root;
    constructor({ root }: {
        root: string;
    });
    read(relativePath: string): Promise<LambderPublicFile | null>;
}
/**
 * Terminal public-file handler registered via lambder.servePublicFiles().
 * Runs only when no route matched, so it can never shadow routes registered
 * after it. Serves files from its source (traversal-safe, mime-typed,
 * memory-cached, immutable-cache heuristic for content-hashed assets) and
 * falls through to the route fallback when the source has no such file.
 */
export declare class LambderPublicFilesHandler {
    private source;
    private options;
    private fileCache;
    private fileCacheBytes;
    constructor(source: LambderPublicFileSource, options: LambderPublicFilesOptions);
    /** Serve the mapped file, or return null to fall through. */
    handle(ctx: LambderRenderContext): Promise<LambderResponse | null>;
    /** Read from the source, caching small files in memory for warm invocations. */
    private readCached;
    private cacheControlFor;
}

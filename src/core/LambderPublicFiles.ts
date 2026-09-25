import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderFiles } from "./LambderFiles.js";
import { LambderResponse } from "./LambderResponse.js";
import { allowsRequestMethod } from "./LambderRouting.js";
import { filePathOf } from "./LambderRequestPath.js";

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

/*
 * Build outputs whose names carry a content hash, so a changed file gets a
 * new name and the old one may be cached for good. Only what a bundler wrote:
 *   - everything under Next.js's _next/static/;
 *   - under assets/ or static/ (Vite, Rollup, esbuild, webpack and CRA, a
 *     Django manifest), a name ending in its hash, then an optional `.chunk`
 *     and the extension. The hash is either exactly 8 base64url characters
 *     after a hyphen (Vite, Rollup, esbuild), or 8 or more letters and
 *     digits with both kinds among them (webpack's contenthash, after a dot
 *     or a hyphen).
 * The 8-character form has to look random, since a hand-named file's last
 * word is often 8 characters too: a capital, a lowercase letter and a digit,
 * or, with no digit, at least three capitals and a lowercase letter. A word
 * in PascalCase (Inter-SemiBold.woff2, icon-Settings.svg) has fewer capitals
 * than that, and lowercase words around a version (og-image-v2-final.png)
 * have none. A hyphen may sit inside the 8, as Rollup's hashes put one
 * there. The lookaheads cannot read past the 8, since a dot follows them.
 * About one real hash in twenty fails the test (one without a digit and
 * with fewer than three capitals) and is served with the ordinary
 * Cache-Control: a revalidation, never a stale file.
 * A hand-named file (android-chrome-192x192.png, team-photo-2023.jpg,
 * privacy-policy-v2.html) keeps the ordinary Cache-Control: marked immutable,
 * a replaced copy would never reach a browser that already had it.
 */
const EXACT_BUNDLER_HASH = "-(?=[\\w-]{0,7}[a-z])(?:(?=[\\w-]{0,7}[A-Z])(?=[\\w-]{0,7}[0-9])|(?=(?:[a-z0-9_-]*[A-Z]){3}))[\\w-]{8}";
const LONG_BUNDLER_HASH = "[-.](?=\\w*[A-Za-z])(?=\\w*\\d)\\w{8,}";
const DEFAULT_IMMUTABLE_PATTERN = new RegExp(
    `(?:^|/)_next/static/|(?:^|/)(?:assets|static)/(?:[^/]+/)*[^/]*(?:${EXACT_BUNDLER_HASH}|${LONG_BUNDLER_HASH})(?:\\.chunk)?\\.[A-Za-z0-9]+$`,
);
const DEFAULT_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DEFAULT_CACHE_CONTROL = "public, max-age=3600";

/**
 * Terminal public-file handler registered via lambder.servePublicFiles().
 * Runs only when no route matched, so it can never shadow routes registered
 * after it. Serves files through the instance's reader (one path rule,
 * mime-typed, memory-cached) with the immutable-cache heuristic for
 * content-hashed assets, and falls through to the route fallback when the
 * method is not configured or the source has no such file.
 */
export class LambderPublicFilesHandler {
    private files: LambderFiles;
    private options: LambderPublicFilesOptions;
    private methods: ReadonlySet<string>;

    constructor(files: LambderFiles, options: LambderPublicFilesOptions){
        this.files = files;
        this.options = options;
        this.methods = new Set((options.methods ?? ["GET", "HEAD"]).map((method) => method.toUpperCase()));
    }

    /** Serve the mapped file, or return null to fall through. */
    async handle(ctx: LambderRenderContext): Promise<LambderResponse | null> {
        if(!allowsRequestMethod(this.methods, ctx.method)) return null;

        const filePath = filePathOf(ctx.path);
        if(filePath === null) return null;
        const mappedPath = this.options.path ? this.options.path(ctx, filePath) : filePath;
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

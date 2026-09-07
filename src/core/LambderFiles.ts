import mimeTypeResolver from "mime-types";
import { getFS, getPath } from "../shared/node-polyfills.js";
import { LambderTemplatingEngine } from "./LambderTemplatingEngine.js";

/** A file a source serves: its bytes, and its mime type when the source knows it (otherwise resolved from the extension). */
export type LambderFile = { body: Buffer; mimeType?: string };

/**
 * Where an app's files come from: the `files` option at creation, read by
 * servePublicFiles, serveIndexHtml, res.file and res.templateFile alike,
 * through the instance's one reader (LambderFiles). Implement `read` over
 * any backing store: LambderLocalFileSource (a folder), LambderS3FileSource
 * (S3, or R2 and other S3-compatible stores), or your own. The reader does
 * the rest for every source: traversal check, memory cache, mime fallback
 * from the extension.
 */
export interface LambderFileSource {
    /**
     * The file at a relative path (no leading slash, no ".." segments: the
     * reader rejects those before calling), or null when there is no such
     * file, which lets a request fall through to the route fallback.
     */
    read(relativePath: string): Promise<LambderFile | null>;
}

/** In-memory cache of files for warm invocations. Default: { maxBytes: 32MB, maxFileBytes: 2MB }. false disables it. */
export type LambderFileMemoryCacheOption = false | { maxBytes?: number; maxFileBytes?: number };

/** The `files` option at creation: a source, or a source with its memory cache tuned or off. */
export type LambderFilesOption = LambderFileSource | { source: LambderFileSource; memoryCache?: LambderFileMemoryCacheOption };

/** A file as the reader hands it out: path normalized, mime type resolved. */
export type LambderReadFile = { body: Buffer; mimeType: string; relativePath: string };

const DEFAULT_MEMORY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Files from a folder on the Lambda's filesystem, typically the build output
 * bundled into the deployment package. Reads stay under root.
 */
export class LambderLocalFileSource implements LambderFileSource {
    private root: string;

    constructor({ root }: { root: string }){
        this.root = root;
    }

    async read(relativePath: string): Promise<LambderFile | null> {
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

/**
 * The path a source is asked for: leading slash stripped, traversal
 * rejected; null for a path that names no file (empty, or a directory).
 */
export const toRelativePath = (target: string): string | null => {
    if(target.split("/").some((segment) => segment === "..")) return null;
    const relative = target.startsWith("/") ? target.slice(1) : target;
    if(relative === "" || relative.endsWith("/")) return null;
    return relative;
};

/**
 * The app's file reader, owned by the Lambder instance: one source, one
 * path rule, one memory cache and one compiled-template cache, shared by
 * every feature that reads files. Both caches live as long as the instance,
 * i.e. across warm invocations.
 */
export class LambderFiles {
    private source: LambderFileSource;
    private cache: Map<string, LambderReadFile> | null;
    private cacheBytes = 0;
    private maxBytes: number;
    private maxFileBytes: number;
    private templates = new Map<string, LambderTemplatingEngine>();

    constructor(option: LambderFilesOption){
        const { source, memoryCache } = "source" in option ? option : { source: option, memoryCache: undefined };
        this.source = source;
        this.cache = memoryCache === false ? null : new Map();
        this.maxBytes = memoryCache === false ? 0 : (memoryCache?.maxBytes ?? DEFAULT_MEMORY_CACHE_MAX_BYTES);
        this.maxFileBytes = memoryCache === false ? 0 : (memoryCache?.maxFileBytes ?? DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES);
    }

    /**
     * The file at a request or handler path (leading slash optional), mime
     * type resolved; null when the path is invalid or the source has none.
     */
    async read(path: string): Promise<LambderReadFile | null> {
        const relativePath = toRelativePath(path);
        if(relativePath === null) return null;

        const cached = this.cache?.get(relativePath);
        if(cached) return cached;

        const file = await this.source.read(relativePath);
        if(!file) return null;
        const entry: LambderReadFile = {
            body: file.body,
            mimeType: file.mimeType || mimeTypeResolver.lookup(relativePath) || "application/octet-stream",
            relativePath,
        };
        this.remember(entry);
        return entry;
    }

    /**
     * The compiled template for an HTML file, compiled once per instance.
     * A missing file throws: it is a server-side configuration error, not a
     * client 404.
     */
    async template(path: string, options: { htmlVirtualSlots?: boolean } = {}): Promise<LambderTemplatingEngine> {
        const key = `${toRelativePath(path)}|${options.htmlVirtualSlots ? "v" : ""}`;
        const cached = this.templates.get(key);
        if(cached) return cached;

        const file = await this.read(path);
        if(!file) throw new Error(`templateFile: file not found in the files source: ${path}`);
        const template = new LambderTemplatingEngine(file.body.toString("utf8"), { htmlVirtualSlots: options.htmlVirtualSlots });
        this.templates.set(key, template);
        return template;
    }

    /** Cache small files within the byte budget, evicting the oldest entries first. */
    private remember(entry: LambderReadFile): void {
        if(!this.cache || entry.body.length > this.maxFileBytes) return;
        for(const [key, value] of this.cache){
            if(this.cacheBytes + entry.body.length <= this.maxBytes) break;
            this.cache.delete(key);
            this.cacheBytes -= value.body.length;
        }
        if(this.cacheBytes + entry.body.length <= this.maxBytes){
            this.cache.set(entry.relativePath, entry);
            this.cacheBytes += entry.body.length;
        }
    }
}

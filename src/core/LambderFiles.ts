import mimeTypeResolver from "mime-types";
import { LRUCache } from "lru-cache";
import { LambderTemplatingEngine } from "./LambderTemplatingEngine.js";
import type { LambderFileSource } from "../shared/contracts/LambderFileSource.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";

/**
 * In-memory cache of files for warm invocations. Default: { maxBytes: 32MB,
 * maxFileBytes: 2MB, missTtlSeconds: 60 }. false disables it, misses
 * included.
 */
export type LambderFileMemoryCacheOption = false | {
    maxBytes?: number;
    maxFileBytes?: number;
    /**
     * How long a path the source had no file for is answered as missing
     * without asking the source again; 0 asks every time. A file uploaded
     * under such a path is served once this runs out.
     */
    missTtlSeconds?: number;
};

/** The `files` option at creation: a source, or a source with its memory cache tuned or off. */
export type LambderFilesOption = LambderFileSource | { source: LambderFileSource; memoryCache?: LambderFileMemoryCacheOption };

/** A file as the reader hands it out: path normalized, mime type resolved. */
export type LambderReadFile = { body: Buffer; mimeType: string; relativePath: string };

const DEFAULT_MEMORY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MISS_TTL_SECONDS = 60;
/**
 * The bytes the remembered misses may hold, each counted by its path and the
 * entry overhead: a bot probing random paths churns through this rather than
 * growing the map. Counted in bytes because the paths are the caller's: a
 * count of 10,000 would let 8 KB paths hold 160 MB of a container's memory.
 * About 12,000 misses of ordinary length.
 */
const MISS_MEMORY_MAX_BYTES = 4 * 1024 * 1024;
/** What an entry costs beside its bytes, so the byte budget also bounds how many entries it holds. */
const FILE_ENTRY_OVERHEAD_BYTES = 256;

/**
 * The path a source is asked for, or null for one that names no file.
 *
 * This is the whole path rule, and it belongs to the reader: a source that
 * resolves the result against a base (a URL, a filesystem root) is safe only
 * if it really is the plain relative path the interface promises. Every
 * leading slash goes, since stripping only one would hand a source
 * "//attacker.example/evil.html" as "/attacker.example/evil.html", which the
 * HTTP source resolves as a protocol-relative reference: the app's origin
 * credentials would go to a host the caller chose, and its bytes would come
 * back under the app's own domain. Every segment is checked, not only ".."
 * ones: an empty inner segment is how a host or a root gets back into the
 * value, and a backslash is a separator to Windows paths and to every
 * browser reading a Location.
 */
const toRelativePath = (target: string): string | null => {
    const relative = target.replace(/^\/+/, "");
    if(relative === "" || relative.endsWith("/")) return null;
    if(relative.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"))) return null;
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
    /** The files read, least recently served evicted first once the byte budget is spent. */
    private readonly cache: LRUCache<string, LambderReadFile> | null;
    private readonly maxFileBytes: number;
    /**
     * Paths the source had no file for, until their TTL. An SPA asks for a
     * file before it serves the shell for every page route, so without this
     * each navigation would cost a source round trip (an S3 GetObject
     * answering NoSuchKey) in warm containers too.
     */
    private readonly misses: LRUCache<string, true> | null;
    private templates = new Map<string, LambderTemplatingEngine>();

    constructor(option: LambderFilesOption){
        const { source, memoryCache } = "source" in option ? option : { source: option, memoryCache: undefined };
        this.source = source;
        const maxBytes = memoryCache === false ? 0 : (memoryCache?.maxBytes ?? DEFAULT_MEMORY_CACHE_MAX_BYTES);
        this.maxFileBytes = memoryCache === false ? 0 : (memoryCache?.maxFileBytes ?? DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES);
        const missTtlMs = memoryCache === false ? 0 : (memoryCache?.missTtlSeconds ?? DEFAULT_MISS_TTL_SECONDS) * 1000;
        this.cache = maxBytes > 0
            ? new LRUCache<string, LambderReadFile>({
                maxSize: maxBytes,
                // The key is a JS string, two bytes a character.
                sizeCalculation: (entry, key) => entry.body.byteLength + key.length * 2 + FILE_ENTRY_OVERHEAD_BYTES,
            })
            : null;
        this.misses = missTtlMs > 0
            ? new LRUCache<string, true>({
                maxSize: MISS_MEMORY_MAX_BYTES,
                // The key is a JS string, two bytes a character.
                sizeCalculation: (_miss, key) => key.length * 2 + FILE_ENTRY_OVERHEAD_BYTES,
                ttl: missTtlMs,
            })
            : null;
    }

    /**
     * Puts the reader over another source, for `lambder/testing`. In place,
     * because servePublicFiles holds this reader rather than the instance's
     * field; both caches go with the source they were filled from.
     */
    [LAMBDER_BACKEND_SWAP](source: LambderFileSource): void {
        this.source = source;
        this.cache?.clear();
        this.misses?.clear();
        this.templates.clear();
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
        if(this.misses?.has(relativePath)) return null;

        const file = await this.source.read(relativePath);
        if(!file){
            this.misses?.set(relativePath, true);
            return null;
        }
        const entry: LambderReadFile = {
            body: file.body,
            // A source's own type as it gave it: the source knows the bytes'
            // encoding (an S3 object stored as Latin-1 text/plain). Worked out
            // from the extension, a text type carries a UTF-8 charset, so a
            // .txt or an .html with no meta charset is not read in the
            // browser's legacy encoding.
            mimeType: file.mimeType || mimeTypeResolver.contentType(mimeTypeResolver.lookup(relativePath) || "application/octet-stream") || "application/octet-stream",
            relativePath,
        };
        if(this.cache && entry.body.byteLength <= this.maxFileBytes) this.cache.set(relativePath, entry);
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
        if(!file) throw new Error(`Lambder: res.templateFile found no such file in the files source: ${path}`);
        const template = new LambderTemplatingEngine(file.body.toString("utf8"), { htmlVirtualSlots: options.htmlVirtualSlots });
        this.templates.set(key, template);
        return template;
    }
}

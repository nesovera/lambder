import mimeTypeResolver from "mime-types";
import { LambderTemplatingEngine } from "./LambderTemplatingEngine.js";
const DEFAULT_MEMORY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * The path a source is asked for, or null for one that names no file.
 *
 * This is the whole path rule, and it belongs to the reader: every source is
 * handed the result, and a source that resolves it against a base (a URL, a
 * filesystem root) is safe only if the value really is the plain relative
 * path the interface promises. Stripping only ONE leading slash would hand a
 * source "//attacker.example/evil.html" as "/attacker.example/evil.html",
 * which the HTTP source resolves as a protocol-relative reference: the app's
 * origin credentials would go to a host the caller chose and its bytes would
 * come back under the app's own domain. So every leading slash goes, and every segment is
 * checked rather than only the ".." ones: an empty inner segment is how a
 * host or a root gets back into the value, and a backslash is a separator to
 * Windows paths and to every browser reading a Location.
 */
const toRelativePath = (target) => {
    const relative = target.replace(/^\/+/, "");
    if (relative === "" || relative.endsWith("/"))
        return null;
    if (relative.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\")))
        return null;
    return relative;
};
/**
 * The app's file reader, owned by the Lambder instance: one source, one
 * path rule, one memory cache and one compiled-template cache, shared by
 * every feature that reads files. Both caches live as long as the instance,
 * i.e. across warm invocations.
 */
export class LambderFiles {
    source;
    cache;
    cacheBytes = 0;
    maxBytes;
    maxFileBytes;
    templates = new Map();
    constructor(option) {
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
    async read(path) {
        const relativePath = toRelativePath(path);
        if (relativePath === null)
            return null;
        const cached = this.cache?.get(relativePath);
        if (cached)
            return cached;
        const file = await this.source.read(relativePath);
        if (!file)
            return null;
        const entry = {
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
    async template(path, options = {}) {
        const key = `${toRelativePath(path)}|${options.htmlVirtualSlots ? "v" : ""}`;
        const cached = this.templates.get(key);
        if (cached)
            return cached;
        const file = await this.read(path);
        if (!file)
            throw new Error(`Lambder: res.templateFile found no such file in the files source: ${path}`);
        const template = new LambderTemplatingEngine(file.body.toString("utf8"), { htmlVirtualSlots: options.htmlVirtualSlots });
        this.templates.set(key, template);
        return template;
    }
    /** Cache small files within the byte budget, evicting the oldest entries first. */
    remember(entry) {
        if (!this.cache || entry.body.length > this.maxFileBytes)
            return;
        for (const [key, value] of this.cache) {
            if (this.cacheBytes + entry.body.length <= this.maxBytes)
                break;
            this.cache.delete(key);
            this.cacheBytes -= value.body.length;
        }
        if (this.cacheBytes + entry.body.length <= this.maxBytes) {
            this.cache.set(entry.relativePath, entry);
            this.cacheBytes += entry.body.length;
        }
    }
}

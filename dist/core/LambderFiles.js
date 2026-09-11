import mimeTypeResolver from "mime-types";
import { getFS, getPath } from "../shared/node-polyfills.js";
import { LambderTemplatingEngine } from "./LambderTemplatingEngine.js";
const DEFAULT_MEMORY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MEMORY_CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * Files from a folder on the Lambda's filesystem, typically the build output
 * bundled into the deployment package. Reads stay under root.
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
/**
 * A file a remote store returned: the store's Content-Type unless it is a
 * generic octet-stream, in which case the extension decides, as for local
 * files.
 */
export const remoteStoreFile = (body, contentType) => contentType && !contentType.endsWith("octet-stream") ? { body, mimeType: contentType } : { body };
/**
 * The path a source is asked for: leading slash stripped, traversal
 * rejected; null for a path that names no file (empty, or a directory).
 */
export const toRelativePath = (target) => {
    if (target.split("/").some((segment) => segment === ".."))
        return null;
    const relative = target.startsWith("/") ? target.slice(1) : target;
    if (relative === "" || relative.endsWith("/"))
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
            throw new Error(`templateFile: file not found in the files source: ${path}`);
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

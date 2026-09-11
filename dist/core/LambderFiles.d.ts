import { LambderTemplatingEngine } from "./LambderTemplatingEngine.js";
/** A file a source serves: its bytes, and its mime type when the source knows it (otherwise resolved from the extension). */
export type LambderFile = {
    body: Buffer;
    mimeType?: string;
};
/**
 * Where an app's files come from: the `files` option at creation, read by
 * servePublicFiles, serveIndexHtml, res.file and res.templateFile alike,
 * through the instance's one reader (LambderFiles). Implement `read` over
 * any backing store: LambderLocalFileSource (a folder), LambderS3FileSource
 * (S3, or R2 and other S3-compatible stores), LambderHttpFileSource (any
 * origin serving files by path), or your own. The reader does the rest for
 * every source: traversal check, memory cache, mime fallback from the
 * extension.
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
export type LambderFileMemoryCacheOption = false | {
    maxBytes?: number;
    maxFileBytes?: number;
};
/** The `files` option at creation: a source, or a source with its memory cache tuned or off. */
export type LambderFilesOption = LambderFileSource | {
    source: LambderFileSource;
    memoryCache?: LambderFileMemoryCacheOption;
};
/** A file as the reader hands it out: path normalized, mime type resolved. */
export type LambderReadFile = {
    body: Buffer;
    mimeType: string;
    relativePath: string;
};
/**
 * Files from a folder on the Lambda's filesystem, typically the build output
 * bundled into the deployment package. Reads stay under root.
 */
export declare class LambderLocalFileSource implements LambderFileSource {
    private root;
    constructor({ root }: {
        root: string;
    });
    read(relativePath: string): Promise<LambderFile | null>;
}
/**
 * A file a remote store returned: the store's Content-Type unless it is a
 * generic octet-stream, in which case the extension decides, as for local
 * files.
 */
export declare const remoteStoreFile: (body: Buffer, contentType: string | null | undefined) => LambderFile;
/**
 * The path a source is asked for: leading slash stripped, traversal
 * rejected; null for a path that names no file (empty, or a directory).
 */
export declare const toRelativePath: (target: string) => string | null;
/**
 * The app's file reader, owned by the Lambder instance: one source, one
 * path rule, one memory cache and one compiled-template cache, shared by
 * every feature that reads files. Both caches live as long as the instance,
 * i.e. across warm invocations.
 */
export declare class LambderFiles {
    private source;
    private cache;
    private cacheBytes;
    private maxBytes;
    private maxFileBytes;
    private templates;
    constructor(option: LambderFilesOption);
    /**
     * The file at a request or handler path (leading slash optional), mime
     * type resolved; null when the path is invalid or the source has none.
     */
    read(path: string): Promise<LambderReadFile | null>;
    /**
     * The compiled template for an HTML file, compiled once per instance.
     * A missing file throws: it is a server-side configuration error, not a
     * client 404.
     */
    template(path: string, options?: {
        htmlVirtualSlots?: boolean;
    }): Promise<LambderTemplatingEngine>;
    /** Cache small files within the byte budget, evicting the oldest entries first. */
    private remember;
}

import { LambderTemplatingEngine } from "./LambderTemplatingEngine.js";
import type { LambderFileSource } from "../shared/contracts/LambderFileSource.js";
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

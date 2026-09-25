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
    /** The files read, least recently served evicted first once the byte budget is spent. */
    private readonly cache;
    private readonly maxFileBytes;
    /**
     * Paths the source had no file for, until their TTL. An SPA asks for a
     * file before it serves the shell for every page route, so without this
     * each navigation would cost a source round trip (an S3 GetObject
     * answering NoSuchKey) in warm containers too.
     */
    private readonly misses;
    private templates;
    constructor(option: LambderFilesOption);
    /**
     * Puts the reader over another source, for `lambder/testing`. In place,
     * because servePublicFiles holds this reader rather than the instance's
     * field; both caches go with the source they were filled from.
     */
    [LAMBDER_BACKEND_SWAP](source: LambderFileSource): void;
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
}

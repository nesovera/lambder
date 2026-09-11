import { type LambderFile, type LambderFileSource } from "../core/LambderFiles.js";
export type LambderHttpFileSourceOptions = {
    /**
     * The folder URL relative paths resolve under: "https://assets.example.com/v42/".
     * It names a folder, so a missing trailing slash is added.
     */
    baseUrl: string;
    /** Sent with every read, e.g. an Authorization header for a private origin or a User-Agent a firewall allows. */
    headers?: Record<string, string>;
    /** How long one read may take before it fails. Default: 10000. */
    timeoutMs?: number;
};
/**
 * Files over HTTP(S) from any origin that serves them by path: a CDN, a
 * public bucket's own domain (a Cloudflare R2 custom domain, an S3 website
 * endpoint) or another server. Reads with the runtime's fetch, so it needs
 * no SDK, and no credentials for a public origin; reads come out of the
 * origin's edge cache. Each path segment is percent-encoded, so a relative
 * path names the same object it would as an S3 key. A 404 or 410 reads as
 * null and the request falls through; any other failed status, a network
 * error or a timeout propagates as an error. The response's Content-Type is
 * used unless it is a generic octet-stream, in which case the extension
 * decides, as for local files.
 */
export declare class LambderHttpFileSource implements LambderFileSource {
    private readonly baseUrl;
    private readonly headers;
    private readonly timeoutMs;
    constructor({ baseUrl, headers, timeoutMs }: LambderHttpFileSourceOptions);
    read(relativePath: string): Promise<LambderFile | null>;
}

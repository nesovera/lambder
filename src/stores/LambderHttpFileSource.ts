import { remoteStoreFile, type LambderFile, type LambderFileSource } from "../core/LambderFiles.js";

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

const DEFAULT_TIMEOUT_MS = 10_000;

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
export class LambderHttpFileSource implements LambderFileSource {
    private readonly baseUrl: URL;
    private readonly headers: Record<string, string>;
    private readonly timeoutMs: number;

    constructor({ baseUrl, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }: LambderHttpFileSourceOptions){
        let url: URL;
        try{
            url = new URL(baseUrl);
        }catch{
            throw new Error(`baseUrl must be an absolute http(s) URL: ${baseUrl}`);
        }
        if(url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`baseUrl must be an absolute http(s) URL: ${baseUrl}`);
        if(!url.pathname.endsWith("/")) url.pathname += "/";
        this.baseUrl = url;
        this.headers = headers;
        this.timeoutMs = timeoutMs;
    }

    async read(relativePath: string): Promise<LambderFile | null> {
        const url = new URL(relativePath.split("/").map(encodeURIComponent).join("/"), this.baseUrl);
        const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
        if(!response.ok){
            await response.body?.cancel();
            if(response.status === 404 || response.status === 410) return null;
            throw new Error(`LambderHttpFileSource: ${response.status} ${response.statusText} reading ${url}`);
        }
        return remoteStoreFile(Buffer.from(await response.arrayBuffer()), response.headers.get("content-type"));
    }
}

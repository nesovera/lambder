import { remoteStoreFile, type LambderFile, type LambderFileSource } from "../shared/contracts/LambderFileSource.js";

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
    /**
     * The statuses that mean "no such file", read as null so the request
     * falls through. Default: [403, 404, 410]. A private S3 bucket behind
     * CloudFront answers a missing key 403, since its reader may not list the
     * bucket; an origin whose 403 only ever means a refused credential passes
     * [404, 410] so that failure surfaces as an error.
     */
    notFoundStatuses?: readonly number[];
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_NOT_FOUND_STATUSES: readonly number[] = [403, 404, 410];

/**
 * Files over HTTP(S) from any origin that serves them by path: a CDN, a
 * public bucket's own domain (a Cloudflare R2 custom domain, an S3 website
 * endpoint) or another server. Reads with the runtime's fetch, so it needs
 * no SDK, and no credentials for a public origin; reads come out of the
 * origin's edge cache. Each path segment is percent-encoded, so a relative
 * path names the same object it would as an S3 key. A missing file (see
 * `notFoundStatuses`) reads as null and the request falls through; any other
 * failed status, a network error or a timeout throws. The response's
 * Content-Type is used unless it is a generic octet-stream, in which case
 * the extension decides.
 */
export class LambderHttpFileSource implements LambderFileSource {
    private readonly baseUrl: URL;
    private readonly headers: Record<string, string>;
    private readonly timeoutMs: number;
    private readonly notFoundStatuses: readonly number[];

    constructor({ baseUrl, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, notFoundStatuses = DEFAULT_NOT_FOUND_STATUSES }: LambderHttpFileSourceOptions){
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
        this.notFoundStatuses = notFoundStatuses;
    }

    async read(relativePath: string): Promise<LambderFile | null> {
        const url = new URL(relativePath.split("/").map(encodeURIComponent).join("/"), this.baseUrl);
        // The reader's path rule already refuses anything that could make this
        // reference leave the configured folder (a leading slash makes it
        // root-relative, two make it protocol-relative and pick the host).
        // Re-checked rather than trusted: the value is the request path, and
        // escaping would mean a credentialed fetch of an attacker-named
        // origin, served back from this app's own domain.
        if(!url.href.startsWith(this.baseUrl.href)) return null;
        const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
        if(!response.ok){
            await response.body?.cancel();
            if(this.notFoundStatuses.includes(response.status)) return null;
            throw new Error(`LambderHttpFileSource: ${response.status} ${response.statusText} reading ${url}`);
        }
        return remoteStoreFile(Buffer.from(await response.arrayBuffer()), response.headers.get("content-type"));
    }
}

import { remoteStoreFile } from "../shared/contracts/LambderFileSource.js";
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
export class LambderHttpFileSource {
    baseUrl;
    headers;
    timeoutMs;
    constructor({ baseUrl, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
        let url;
        try {
            url = new URL(baseUrl);
        }
        catch {
            throw new Error(`baseUrl must be an absolute http(s) URL: ${baseUrl}`);
        }
        if (url.protocol !== "http:" && url.protocol !== "https:")
            throw new Error(`baseUrl must be an absolute http(s) URL: ${baseUrl}`);
        if (!url.pathname.endsWith("/"))
            url.pathname += "/";
        this.baseUrl = url;
        this.headers = headers;
        this.timeoutMs = timeoutMs;
    }
    async read(relativePath) {
        const url = new URL(relativePath.split("/").map(encodeURIComponent).join("/"), this.baseUrl);
        // The reader's path rule already refuses everything that could make
        // this reference leave the configured folder (a leading slash makes it
        // root-relative, two make it protocol-relative and pick the host).
        // Checked again here rather than trusted, because the value being
        // resolved is the request path and what leaving costs is a
        // credentialed fetch of an attacker-named origin, served back from
        // this app's own domain.
        if (!url.href.startsWith(this.baseUrl.href))
            return null;
        const response = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 404 || response.status === 410)
                return null;
            throw new Error(`LambderHttpFileSource: ${response.status} ${response.statusText} reading ${url}`);
        }
        return remoteStoreFile(Buffer.from(await response.arrayBuffer()), response.headers.get("content-type"));
    }
}

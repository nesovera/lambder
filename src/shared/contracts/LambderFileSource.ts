/*
 * Where an app's files come from: the interface, and the one helper its
 * remote implementations share.
 *
 * Declared in shared/ beside LambderSessionStore, LambderRateLimiter and
 * LambderIdempotencyStore, so all four store families read the same way: the
 * interface here, the implementations in stores/ (LambderLocalFileSource,
 * LambderS3FileSource, LambderHttpFileSource). core/ names the interface and
 * nothing else of the family.
 *
 * What reads through a source is the instance's reader, LambderFiles: it owns
 * the path rule, the memory cache and the mime fallback.
 */

/** A file a source serves: its bytes, and its mime type when the source knows it (otherwise resolved from the extension). */
export type LambderFile = { body: Buffer; mimeType?: string };

/**
 * Where an app's files come from: the `files` option at creation, read by
 * servePublicFiles, serveIndexHtml, res.file and res.templateFile alike,
 * through the instance's one reader (LambderFiles). Implement `read` over
 * any backing store: LambderLocalFileSource (a folder), LambderS3FileSource
 * (S3, or R2 and other S3-compatible stores), LambderHttpFileSource (any
 * origin serving files by path), or your own. The reader does the rest for
 * every source: path rule, memory cache, mime fallback from the extension.
 */
export interface LambderFileSource {
    /**
     * The file at a relative path, or null when there is no such file, which
     * lets a request fall through to the route fallback.
     *
     * The reader has already refused everything that is not a plain relative
     * path: no leading slash, no empty, "." or ".." segment, no backslash.
     * A source that resolves the value against a base an attacker must not
     * leave (a URL, a filesystem root) still re-checks the result, because a
     * contract is not a boundary.
     */
    read(relativePath: string): Promise<LambderFile | null>;
}

/**
 * A file a remote store returned: the store's Content-Type unless it is a
 * generic octet-stream, in which case the extension decides, as for local
 * files.
 */
export const remoteStoreFile = (body: Buffer, contentType: string | null | undefined): LambderFile =>
    contentType && !contentType.endsWith("octet-stream") ? { body, mimeType: contentType } : { body };

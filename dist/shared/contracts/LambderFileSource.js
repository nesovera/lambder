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
/**
 * A file a remote store returned: the store's Content-Type unless it is a
 * generic octet-stream, in which case the extension decides, as for local
 * files.
 */
export const remoteStoreFile = (body, contentType) => contentType && !contentType.endsWith("octet-stream") ? { body, mimeType: contentType } : { body };

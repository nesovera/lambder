/*
 * Where an app's files come from: the interface, and the one helper its
 * remote implementations share.
 *
 * Laid out like the other store families (LambderSessionStore,
 * LambderRateLimiter, LambderIdempotencyStore): the interface here, the
 * implementations in stores/. core/ names only the interface. The instance's
 * reader, LambderFiles, reads through a source and owns the path rule, the
 * memory cache and the mime fallback.
 */
/**
 * A file a remote store returned: the store's Content-Type unless it is a
 * generic octet-stream, in which case the extension decides, as for local
 * files.
 */
export const remoteStoreFile = (body, contentType) => contentType && !contentType.endsWith("octet-stream") ? { body, mimeType: contentType } : { body };

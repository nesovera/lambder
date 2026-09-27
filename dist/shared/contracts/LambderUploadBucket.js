/*
 * Direct uploads: a file that travels from the browser straight to object
 * storage, never through the app's function.
 *
 * An API payload tops out near a few megabytes once a file is base64, and a
 * Lambda's request body at six, so anything larger (a scanned lease, a
 * signed PDF, a video) is sent by the browser to the bucket itself, with a
 * ticket the server signed beforehand. The ticket pins everything about the
 * upload: the key, the exact byte size, the content type and the SHA-256 of
 * the bytes, all enforced by the storage, so the browser can only ever store
 * the one file it described.
 *
 * The conversation is the same three steps whatever the app stores: the
 * browser describes the file (LambderUploadFileFacts), the app's endpoint
 * answers with a ticket (LambderUploadTicket), and after the upload the app's
 * confirm endpoint asks the bucket what arrived before its record counts as
 * uploaded. The server half is a LambderUploadBucket, the browser half is
 * LambderUploadRunner.
 *
 * This module is the vocabulary both halves share and the contract a bucket
 * implements, and it imports nothing: the zod schemas an endpoint declares
 * its input and output with are in wire/LambderUploadSchemas.ts.
 */
/** The longest a ticket or a download link may live: S3's limit for a signature, seven days. */
export const UPLOAD_SIGNATURE_MAX_SECONDS = 7 * 24 * 60 * 60;
/** Throws unless a lifetime is a positive number of seconds within S3's seven days. */
export const assertSignatureLifetime = (seconds, name) => {
    if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= UPLOAD_SIGNATURE_MAX_SECONDS)) {
        throw new RangeError(`${name} must be a number of seconds above 0 and at most ${UPLOAD_SIGNATURE_MAX_SECONDS} (seven days): ${seconds}`);
    }
};
/** Throws when object options break a limit S3 holds them to, so the mistake shows where the app wrote it rather than as a refused post. */
export const assertObjectOptions = (options) => {
    const tags = Object.entries(options?.tags ?? {});
    if (tags.length > 10)
        throw new RangeError(`An object carries at most 10 tags: ${tags.length}`);
    for (const [key, value] of tags) {
        if (!key || key.length > 128 || value.length > 256)
            throw new RangeError(`A tag's key is 1 to 128 characters and its value at most 256: ${key}`);
    }
    let metadataBytes = 0;
    for (const [name, value] of Object.entries(options?.metadata ?? {})) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
            throw new RangeError(`A metadata name is letters, digits, "-" and "_": ${name}`);
        if (!/^[\x20-\x7e]*$/.test(value))
            throw new RangeError(`A metadata value is printable ASCII: ${name}`);
        metadataBytes += name.length + value.length;
    }
    if (metadataBytes > 2048)
        throw new RangeError(`An object's metadata is at most 2 KB: ${metadataBytes} bytes`);
};
/** A rule's verdict on a file, or null when it may be uploaded: the check the browser makes before hashing and the bucket makes before signing. */
export const checkUploadRule = (rule, file) => {
    if (file.byteSize <= 0)
        return "fileEmpty";
    if (!rule.mimeTypes.includes(file.mimeType))
        return "fileTypeRejected";
    if (file.byteSize > rule.maxBytes)
        return "fileTooLarge";
    return null;
};
/**
 * Throws when an object key would not pin the key a ticket writes to: S3
 * substitutes the uploaded file's own name for `${filename}` in a presigned
 * POST's key, so a key holding it lets the browser choose where under it the
 * file lands. A key is the app's, built from its own ids, so this is a
 * programming error rather than a refusal.
 */
export const assertPinnedObjectKey = (objectKey) => {
    if (!objectKey)
        throw new Error("An upload's object key is empty");
    if (objectKey.includes("${filename}"))
        throw new Error(`An upload's object key may not hold \${filename}, which storage replaces with the uploaded file's name: ${objectKey}`);
};

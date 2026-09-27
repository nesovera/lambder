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

/** What an app accepts for one kind of upload, declared once and read by both sides. */
export type LambderUploadRule = {
    /** The largest file accepted, in bytes. */
    maxBytes: number;
    /** The accepted content types, exact, with no wildcards: `["application/pdf"]`. */
    mimeTypes: readonly string[];
};

/** What the browser says about a file before any of its bytes move. */
export type LambderUploadFileFacts = {
    fileName: string;
    mimeType: string;
    byteSize: number;
    /** SHA-256 of the file's bytes as base64, the form storage checks an upload against: 43 characters and one pad. */
    sha256Base64: string;
};

/**
 * Everything the browser needs to send one file to storage, and until when,
 * in one of the two forms a store signs. `POST` is a form (S3's presigned
 * POST), `PUT` the file as the body of a signed URL (a presigned PUT, which
 * Cloudflare R2 and other stores without POST policies take).
 */
export type LambderUploadTicket =
    | {
        method: "POST";
        uploadUrl: string;
        /** Sent as form fields ahead of the file, which storage wants last. */
        formFields: Record<string, string>;
        /** Epoch milliseconds after which storage refuses the ticket. */
        expiresAt: number;
    }
    | {
        method: "PUT";
        uploadUrl: string;
        /** Sent exactly as given, each one signed into the URL; the browser adds the length itself. */
        headers: Record<string, string>;
        /** Epoch milliseconds after which storage refuses the ticket. */
        expiresAt: number;
    };

/** How a bucket's tickets send a file: the `method` of the tickets it signs. */
export type LambderUploadMethod = LambderUploadTicket["method"];

/** What a bucket holds under a key, compared with what the browser said it would upload. */
export type LambderUploadVerdict =
    | { verified: true }
    /** `objectMissing`: nothing was posted. `factsMismatch`: something else sits under the key. */
    | { verified: false; reason: "objectMissing" | "factsMismatch" };

/** How a browser presents an object it reads: in place (a PDF in its viewer) or saved as a file, under a name. */
export type LambderUploadContentDisposition = {
    disposition: "inline" | "attachment";
    /** The name the file is saved or shown under; any characters, encoded for the header. Without one, the browser takes the key's last segment. */
    fileName?: string;
};

/**
 * What storage keeps beside an object's bytes. A ticket pins every one of
 * these in its signature, so the browser sends them unchanged.
 */
export type LambderUploadObjectOptions = {
    /**
     * The object's tags, at most ten. They are how an object gets a time to
     * live: S3 has no expiry per object, and a lifecycle rule keyed on a tag
     * (`retention: "30d"` expiring after 30 days) deletes what carries it.
     * Keys up to 128 characters, values up to 256.
     */
    tags?: Record<string, string>;
    /** User metadata, kept as `x-amz-meta-<name>` and returned with every read of the object. Names are lowercased; printable ASCII, 2 KB in all. */
    metadata?: Record<string, string>;
    /** The Cache-Control every read of the object answers with, for one served through a CDN. */
    cacheControl?: string;
    /** How a browser presents the object by default; a download link can say otherwise. */
    contentDisposition?: LambderUploadContentDisposition;
};

/** The longest a ticket or a download link may live: S3's limit for a signature, seven days. */
export const UPLOAD_SIGNATURE_MAX_SECONDS = 7 * 24 * 60 * 60;

/** Throws unless a lifetime is a positive number of seconds within S3's seven days. */
export const assertSignatureLifetime = (seconds: number, name: string): void => {
    if(!(Number.isFinite(seconds) && seconds > 0 && seconds <= UPLOAD_SIGNATURE_MAX_SECONDS)){
        throw new RangeError(`${name} must be a number of seconds above 0 and at most ${UPLOAD_SIGNATURE_MAX_SECONDS} (seven days): ${seconds}`);
    }
};

/** Throws when object options break a limit S3 holds them to, so the mistake shows where the app wrote it rather than as a refused post. */
export const assertObjectOptions = (options: LambderUploadObjectOptions | undefined): void => {
    const tags = Object.entries(options?.tags ?? {});
    if(tags.length > 10) throw new RangeError(`An object carries at most 10 tags: ${tags.length}`);
    for(const [key, value] of tags){
        if(!key || key.length > 128 || value.length > 256) throw new RangeError(`A tag's key is 1 to 128 characters and its value at most 256: ${key}`);
    }
    let metadataBytes = 0;
    for(const [name, value] of Object.entries(options?.metadata ?? {})){
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new RangeError(`A metadata name is letters, digits, "-" and "_": ${name}`);
        if(!/^[\x20-\x7e]*$/.test(value)) throw new RangeError(`A metadata value is printable ASCII: ${name}`);
        metadataBytes += name.length + value.length;
    }
    if(metadataBytes > 2048) throw new RangeError(`An object's metadata is at most 2 KB: ${metadataBytes} bytes`);
};

/** What a rule holds against a file, known before any of it is sent. */
export type LambderUploadRuleVerdict = "fileEmpty" | "fileTypeRejected" | "fileTooLarge";

/** A rule's verdict on a file, or null when it may be uploaded: the check the browser makes before hashing and the bucket makes before signing. */
export const checkUploadRule = (rule: LambderUploadRule, file: { mimeType: string; byteSize: number }): LambderUploadRuleVerdict | null => {
    if(file.byteSize <= 0) return "fileEmpty";
    if(!rule.mimeTypes.includes(file.mimeType)) return "fileTypeRejected";
    if(file.byteSize > rule.maxBytes) return "fileTooLarge";
    return null;
};

/**
 * Throws when an object key would not pin the key a ticket writes to: S3
 * substitutes the uploaded file's own name for `${filename}` in a presigned
 * POST's key, so a key holding it lets the browser choose where under it the
 * file lands. A key is the app's, built from its own ids, so this is a
 * programming error rather than a refusal.
 */
export const assertPinnedObjectKey = (objectKey: string): void => {
    if(!objectKey) throw new Error("An upload's object key is empty");
    if(objectKey.includes("${filename}")) throw new Error(`An upload's object key may not hold \${filename}, which storage replaces with the uploaded file's name: ${objectKey}`);
};

/**
 * Object storage a browser uploads to directly, with tickets the server
 * signs, and that the server reads, writes and deletes through for the rest
 * of an object's life. One instance per bucket. LambderS3UploadBucket in
 * production; LambderMemoryUploadBucket in tests and the mock runtime.
 *
 * The object key is always chosen by the app from its own ids. It never
 * comes from the browser, and a ticket pins it, so a ticket cannot be used to
 * write anywhere else.
 */
export interface LambderUploadBucket {
    /**
     * Signs a ticket for exactly the file the browser described, or refuses
     * (a LambderApiRefusal, code `lambder/upload-empty`,
     * `lambder/upload-type-rejected` or `lambder/upload-too-large`) when the
     * rule does not accept it. Storage then enforces every fact: the upload
     * fails unless the body has that byte size, that content type and that
     * SHA-256, so what verifies later is what was described here. `object`
     * is what the stored object carries besides, pinned the same way, and
     * `lifetimeSeconds` overrides the bucket's ticket lifetime for this one.
     */
    issueUploadTicket(options: {
        objectKey: string;
        fileFacts: LambderUploadFileFacts;
        uploadRule: LambderUploadRule;
        lifetimeSeconds?: number;
        object?: LambderUploadObjectOptions;
    }): Promise<LambderUploadTicket>;
    /**
     * Asks storage what it holds under the key. The browser saying "done"
     * proves nothing, so an app calls this before its record counts as
     * uploaded.
     */
    verifyUploadedObject(options: { objectKey: string; fileFacts: Pick<LambderUploadFileFacts, "byteSize" | "sha256Base64"> }): Promise<LambderUploadVerdict>;
    /**
     * A link the browser can read the object with (a preview, a download)
     * until it expires: `lifetimeSeconds`, or the bucket's link lifetime.
     * `contentDisposition` decides for this link whether the browser shows
     * the file or saves it, and under what name.
     */
    issueDownloadUrl(options: { objectKey: string; lifetimeSeconds?: number; contentDisposition?: LambderUploadContentDisposition }): Promise<string>;
    /** The object's bytes, for work the server does on a file itself. Throws when the key holds nothing. */
    readObject(objectKey: string): Promise<Uint8Array>;
    /**
     * Stores bytes the server produced, with their SHA-256 checked by storage
     * on the way in, as a ticket checks a browser's upload. Pass the digest
     * when it is already known; otherwise it is computed. `object` is what
     * the object carries besides, as for a ticket.
     */
    writeObject(options: { objectKey: string; body: Uint8Array; mimeType: string; sha256Base64?: string; object?: LambderUploadObjectOptions }): Promise<void>;
    /**
     * A second object with the same bytes, made inside storage: nothing is
     * read into the function, so a file of any size copies in one call. For
     * records that must each own their file, so deleting one never takes the
     * other's. The copy carries the source's type, metadata and tags.
     */
    copyObject(options: { fromObjectKey: string; toObjectKey: string }): Promise<void>;
    /** Removes the object. Deleting a key that holds nothing is not an error. */
    deleteObject(objectKey: string): Promise<void>;
}

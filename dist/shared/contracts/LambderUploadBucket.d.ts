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
/** Everything the browser needs to post one file to storage, and until when. */
export type LambderUploadTicket = {
    uploadUrl: string;
    /** Sent as form fields ahead of the file, which storage wants last. */
    formFields: Record<string, string>;
    /** Epoch milliseconds after which storage refuses the ticket. */
    expiresAt: number;
};
/** What a bucket holds under a key, compared with what the browser said it would upload. */
export type LambderUploadVerdict = {
    verified: true;
}
/** `objectMissing`: nothing was posted. `factsMismatch`: something else sits under the key. */
 | {
    verified: false;
    reason: "objectMissing" | "factsMismatch";
};
/** How a browser presents an object it reads: in place (a PDF in its viewer) or saved as a file, under a name. */
export type LambderUploadContentDisposition = {
    disposition: "inline" | "attachment";
    /** The name the file is saved or shown under; any characters, encoded for the header. Without one, the browser takes the key's last segment. */
    fileName?: string;
};
/**
 * What storage keeps beside an object's bytes. A ticket pins every one of
 * these in its signed policy, so the browser posts them unchanged.
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
export declare const UPLOAD_SIGNATURE_MAX_SECONDS: number;
/** Throws unless a lifetime is a positive number of seconds within S3's seven days. */
export declare const assertSignatureLifetime: (seconds: number, name: string) => void;
/** Throws when object options break a limit S3 holds them to, so the mistake shows where the app wrote it rather than as a refused post. */
export declare const assertObjectOptions: (options: LambderUploadObjectOptions | undefined) => void;
/** What a rule holds against a file, known before any of it is sent. */
export type LambderUploadRuleVerdict = "fileEmpty" | "fileTypeRejected" | "fileTooLarge";
/** A rule's verdict on a file, or null when it may be uploaded: the check the browser makes before hashing and the bucket makes before signing. */
export declare const checkUploadRule: (rule: LambderUploadRule, file: {
    mimeType: string;
    byteSize: number;
}) => LambderUploadRuleVerdict | null;
/**
 * Throws when an object key would not pin the key a ticket writes to: S3
 * substitutes the uploaded file's own name for `${filename}` in a presigned
 * POST's key, so a key holding it lets the browser choose where under it the
 * file lands. A key is the app's, built from its own ids, so this is a
 * programming error rather than a refusal.
 */
export declare const assertPinnedObjectKey: (objectKey: string) => void;
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
     * rule does not accept it. Storage then enforces every fact: the post
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
    verifyUploadedObject(options: {
        objectKey: string;
        fileFacts: Pick<LambderUploadFileFacts, "byteSize" | "sha256Base64">;
    }): Promise<LambderUploadVerdict>;
    /**
     * A link the browser can read the object with (a preview, a download)
     * until it expires: `lifetimeSeconds`, or the bucket's link lifetime.
     * `contentDisposition` decides for this link whether the browser shows
     * the file or saves it, and under what name.
     */
    issueDownloadUrl(options: {
        objectKey: string;
        lifetimeSeconds?: number;
        contentDisposition?: LambderUploadContentDisposition;
    }): Promise<string>;
    /** The object's bytes, for work the server does on a file itself. Throws when the key holds nothing. */
    readObject(objectKey: string): Promise<Uint8Array>;
    /**
     * Stores bytes the server produced, with their SHA-256 checked by storage
     * on the way in, as a ticket checks a browser's upload. Pass the digest
     * when it is already known; otherwise it is computed. `object` is what
     * the object carries besides, as for a ticket.
     */
    writeObject(options: {
        objectKey: string;
        body: Uint8Array;
        mimeType: string;
        sha256Base64?: string;
        object?: LambderUploadObjectOptions;
    }): Promise<void>;
    /**
     * A second object with the same bytes, made inside storage: nothing is
     * read into the function, so a file of any size copies in one call. For
     * records that must each own their file, so deleting one never takes the
     * other's. The copy carries the source's type, metadata and tags.
     */
    copyObject(options: {
        fromObjectKey: string;
        toObjectKey: string;
    }): Promise<void>;
    /** Removes the object. Deleting a key that holds nothing is not an error. */
    deleteObject(objectKey: string): Promise<void>;
}

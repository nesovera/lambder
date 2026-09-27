import { type LambderUploadBucket, type LambderUploadContentDisposition, type LambderUploadFileFacts, type LambderUploadMethod, type LambderUploadObjectOptions, type LambderUploadRule, type LambderUploadTicket, type LambderUploadVerdict } from "../shared/contracts/LambderUploadBucket.js";
export type LambderMemoryUploadBucketOptions = {
    /**
     * The URL tickets and download links point under, which a mock's MSW
     * handler (lambderMockUploadMswHandler) or a test's fetch stub answers
     * for. Default: a URL of its own per bucket, on a host that cannot
     * resolve (`https://upload-bucket-<id>.invalid/`), so a request nothing
     * intercepts fails rather than reaching the network.
     */
    baseUrl?: string;
    /** How long a ticket stays usable, unless a ticket says otherwise. Default: 600 seconds, as LambderS3UploadBucket. */
    ticketLifetimeSeconds?: number;
    /** How long a download link reads the object, unless a link says otherwise. Default: 300 seconds, as LambderS3UploadBucket. */
    downloadLifetimeSeconds?: number;
    /** The clock tickets and links expire by, injectable so a test can move past an expiry without waiting. Default: Date.now. */
    now?: () => number;
    /** How the browser sends a file, as LambderS3UploadBucket's option: a `POST` form or a `PUT`. Default: `POST`. */
    uploadMethod?: LambderUploadMethod;
};
/** What the memory bucket holds under a key, for a test to assert on: the object's facts and what it carries. */
export type LambderMemoryUploadObject = {
    byteSize: number;
    mimeType: string;
    sha256Base64: string;
} & LambderUploadObjectOptions;
/**
 * An upload bucket in memory (see LambderUploadBucket), for tests and the
 * mock runtime.
 *
 * It holds a post to the rules S3 holds a presigned POST to: every field the
 * ticket carries, each with the ticket's value, and no other, all ahead of
 * the file (as S3 does, anything after the file is ignored); a ticket it
 * issued and not yet expired; a body of exactly the size described; and bytes
 * whose SHA-256 is the one described. It refuses otherwise with the status
 * and the XML error S3 answers with (AccessDenied for a policy, and "Policy
 * expired" for a late one, EntityTooSmall, EntityTooLarge, BadDigest), so any
 * client, a LambderUploadRunner or another, takes the same path against it as
 * against S3: an expired ticket is asked for again, a wrong file is refused.
 * With `uploadMethod: "PUT"` it holds a PUT to the rules a store holds a
 * presigned PUT to: every header the ticket carries with its value, no other
 * `x-amz-` header, a body of the signed length (SignatureDoesNotMatch
 * otherwise), a URL not yet expired ("Request has expired"), and bytes with
 * the SHA-256 (BadDigest). A download link reads the object until it expires.
 *
 * Storage requests reach it through handleStorageRequest(), which answers a
 * fetch Request with a Response: lambderMockUploadMswHandler plugs that into
 * MSW, and a test can route a stubbed fetch to it directly. Everything it
 * uses is a web API (fetch's Request and Response, FormData, WebCrypto), so it
 * runs in a browser, a service worker and Node alike.
 */
export declare class LambderMemoryUploadBucket implements LambderUploadBucket {
    /** Where tickets and download links point, always ending in a slash. */
    readonly baseUrl: string;
    private readonly ticketLifetimeSeconds;
    private readonly downloadLifetimeSeconds;
    private readonly uploadMethod;
    private readonly now;
    private readonly objects;
    private readonly tickets;
    private readonly links;
    constructor({ baseUrl, ticketLifetimeSeconds, downloadLifetimeSeconds, now, uploadMethod }?: LambderMemoryUploadBucketOptions);
    issueUploadTicket({ objectKey, fileFacts, uploadRule, lifetimeSeconds, object }: {
        objectKey: string;
        fileFacts: LambderUploadFileFacts;
        uploadRule: LambderUploadRule;
        lifetimeSeconds?: number;
        object?: LambderUploadObjectOptions;
    }): Promise<LambderUploadTicket>;
    verifyUploadedObject({ objectKey, fileFacts }: {
        objectKey: string;
        fileFacts: Pick<LambderUploadFileFacts, "byteSize" | "sha256Base64">;
    }): Promise<LambderUploadVerdict>;
    issueDownloadUrl({ objectKey, lifetimeSeconds, contentDisposition }: {
        objectKey: string;
        lifetimeSeconds?: number;
        contentDisposition?: LambderUploadContentDisposition;
    }): Promise<string>;
    readObject(objectKey: string): Promise<Uint8Array>;
    writeObject({ objectKey, body, mimeType, sha256Base64, object }: {
        objectKey: string;
        body: Uint8Array;
        mimeType: string;
        sha256Base64?: string;
        object?: LambderUploadObjectOptions;
    }): Promise<void>;
    copyObject({ fromObjectKey, toObjectKey }: {
        fromObjectKey: string;
        toObjectKey: string;
    }): Promise<void>;
    deleteObject(objectKey: string): Promise<void>;
    /** The keys that hold an object, sorted, for a test to assert on. */
    listObjectKeys(): string[];
    /** What is held under a key (its facts, tags, metadata and headers), for a test to assert on; null when nothing is. */
    inspectObject(objectKey: string): LambderMemoryUploadObject | null;
    /** Forgets every object, ticket and link. */
    reset(): void;
    /**
     * Answers a request to storage the way S3 answers it: a post or a PUT
     * under a ticket stores its file, a GET or HEAD through a download link
     * reads an object. A request outside baseUrl answers null, for the caller
     * to hand on.
     */
    handleStorageRequest(request: Request): Promise<Response | null>;
    private acceptUpload;
    /**
     * A PUT under a ticket's signed URL. A header the signature covers with
     * another value, or a body of another length, does not match the
     * signature; an `x-amz-` header it does not cover is refused as a store
     * refuses one; the checksum is held against the bytes.
     */
    private acceptPut;
    private serveDownload;
}

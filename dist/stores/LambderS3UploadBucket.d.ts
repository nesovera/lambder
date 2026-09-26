import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { type LambderUploadBucket, type LambderUploadContentDisposition, type LambderUploadFileFacts, type LambderUploadObjectOptions, type LambderUploadRule, type LambderUploadTicket, type LambderUploadVerdict } from "../shared/contracts/LambderUploadBucket.js";
export type LambderS3UploadBucketOptions = {
    bucket: string;
    /** A ready client, e.g. one shared with the rest of the app. */
    client?: S3Client;
    /** Otherwise the client is created from this on first use: `{ region }`. */
    clientConfig?: S3ClientConfig;
    /** How long a ticket stays usable, unless a ticket says otherwise. Default: 600 seconds, enough for a large file on a slow phone. */
    ticketLifetimeSeconds?: number;
    /** How long a download link reads the object, unless a link says otherwise. Default: 300 seconds. */
    downloadLifetimeSeconds?: number;
};
/**
 * An S3 bucket browsers upload to directly (see LambderUploadBucket).
 *
 * A ticket is an S3 presigned POST whose policy pins the key, the content
 * type, the exact byte size and the SHA-256 checksum, so S3 itself refuses
 * any other file. That needs S3's POST policies with checksum fields: S3, or
 * a store that implements them; Cloudflare R2 does not take presigned POSTs.
 *
 * Signing a ticket or a download link is arithmetic over the function's
 * credentials and reaches nothing; verifying, reading, writing, copying and
 * deleting are calls to the bucket. A signature lives at most seven days,
 * and never past the credentials that made it: a Lambda's role credentials
 * last hours, so a link meant to outlive them needs long-lived keys. Needs @aws-sdk/client-s3,
 * @aws-sdk/s3-presigned-post and @aws-sdk/s3-request-presigner, optional peer
 * dependencies each loaded the first time a call needs it, so an app that
 * never uploads never loads them.
 */
export declare class LambderS3UploadBucket implements LambderUploadBucket {
    private readonly bucket;
    private readonly ticketLifetimeSeconds;
    private readonly downloadLifetimeSeconds;
    private readonly clientConfig;
    private client;
    private clientSdk;
    private presignedPostSdk;
    private requestPresignerSdk;
    constructor({ bucket, client, clientConfig, ticketLifetimeSeconds, downloadLifetimeSeconds }: LambderS3UploadBucketOptions);
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
    private s3;
    private loadPresignedPostSdk;
    private loadRequestPresignerSdk;
}

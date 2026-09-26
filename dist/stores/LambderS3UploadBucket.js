import { assertObjectOptions, assertPinnedObjectKey, assertSignatureLifetime, } from "../shared/contracts/LambderUploadBucket.js";
import { contentDispositionHeader } from "../shared/util/LambderContentDisposition.js";
import { uploadObjectFormFields } from "../shared/wire/LambderUploadObjectFields.js";
import { refuseUnacceptedUpload } from "../shared/wire/LambderUploadRefusal.js";
import { withInstallHint } from "./LambderSdkInstallHint.js";
/** The S3 error names that mean nothing is stored under the key: HeadObject answers NotFound, the other calls NoSuchKey. */
const MISSING_OBJECT_ERROR_NAMES = ["NotFound", "NoSuchKey"];
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
export class LambderS3UploadBucket {
    bucket;
    ticketLifetimeSeconds;
    downloadLifetimeSeconds;
    clientConfig;
    client;
    clientSdk;
    presignedPostSdk;
    requestPresignerSdk;
    constructor({ bucket, client, clientConfig, ticketLifetimeSeconds = 600, downloadLifetimeSeconds = 300 }) {
        if (!bucket.trim())
            throw new Error("bucket is required");
        assertSignatureLifetime(ticketLifetimeSeconds, "ticketLifetimeSeconds");
        assertSignatureLifetime(downloadLifetimeSeconds, "downloadLifetimeSeconds");
        this.bucket = bucket;
        this.client = client;
        this.clientConfig = clientConfig;
        this.ticketLifetimeSeconds = ticketLifetimeSeconds;
        this.downloadLifetimeSeconds = downloadLifetimeSeconds;
    }
    async issueUploadTicket({ objectKey, fileFacts, uploadRule, lifetimeSeconds = this.ticketLifetimeSeconds, object }) {
        assertPinnedObjectKey(objectKey);
        assertSignatureLifetime(lifetimeSeconds, "lifetimeSeconds");
        assertObjectOptions(object);
        refuseUnacceptedUpload(uploadRule, fileFacts);
        const [{ client }, { createPresignedPost }] = await Promise.all([this.s3(), this.loadPresignedPostSdk()]);
        const post = await createPresignedPost(client, {
            Bucket: this.bucket,
            Key: objectKey,
            Expires: lifetimeSeconds,
            // Each field is also an exact-match condition of the signed policy.
            Fields: {
                "Content-Type": fileFacts.mimeType,
                "x-amz-checksum-algorithm": "SHA256",
                "x-amz-checksum-sha256": fileFacts.sha256Base64,
                ...uploadObjectFormFields(object),
            },
            Conditions: [["content-length-range", fileFacts.byteSize, fileFacts.byteSize]],
        });
        return { uploadUrl: post.url, formFields: post.fields, expiresAt: Date.now() + lifetimeSeconds * 1000 };
    }
    async verifyUploadedObject({ objectKey, fileFacts }) {
        const { sdk, client } = await this.s3();
        let head;
        try {
            head = await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: objectKey, ChecksumMode: "ENABLED" }));
        }
        catch (err) {
            if (MISSING_OBJECT_ERROR_NAMES.includes(err.name ?? ""))
                return { verified: false, reason: "objectMissing" };
            throw err;
        }
        const matches = head.ContentLength === fileFacts.byteSize && head.ChecksumSHA256 === fileFacts.sha256Base64;
        return matches ? { verified: true } : { verified: false, reason: "factsMismatch" };
    }
    async issueDownloadUrl({ objectKey, lifetimeSeconds = this.downloadLifetimeSeconds, contentDisposition }) {
        assertSignatureLifetime(lifetimeSeconds, "lifetimeSeconds");
        const [{ sdk, client }, { getSignedUrl }] = await Promise.all([this.s3(), this.loadRequestPresignerSdk()]);
        return getSignedUrl(client, new sdk.GetObjectCommand({
            Bucket: this.bucket,
            Key: objectKey,
            // Signed into the link: S3 answers with this header for its reads alone.
            ...(contentDisposition ? { ResponseContentDisposition: contentDispositionHeader(contentDisposition) } : {}),
        }), { expiresIn: lifetimeSeconds });
    }
    async readObject(objectKey) {
        const { sdk, client } = await this.s3();
        const object = await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
        if (!object.Body)
            throw new Error(`LambderS3UploadBucket.readObject: no body under ${objectKey}`);
        return object.Body.transformToByteArray();
    }
    async writeObject({ objectKey, body, mimeType, sha256Base64, object }) {
        assertObjectOptions(object);
        const { sdk, client } = await this.s3();
        const tags = Object.entries(object?.tags ?? {});
        const metadata = Object.entries(object?.metadata ?? {});
        await client.send(new sdk.PutObjectCommand({
            Bucket: this.bucket,
            Key: objectKey,
            Body: body,
            ContentType: mimeType,
            ...(tags.length ? { Tagging: new URLSearchParams(tags).toString() } : {}),
            ...(metadata.length ? { Metadata: Object.fromEntries(metadata.map(([name, value]) => [name.toLowerCase(), value])) } : {}),
            ...(object?.cacheControl !== undefined ? { CacheControl: object.cacheControl } : {}),
            ...(object?.contentDisposition ? { ContentDisposition: contentDispositionHeader(object.contentDisposition) } : {}),
            // A digest the caller already has is sent as it is; otherwise the
            // SDK computes it. Either way S3 checks the body against it and
            // stores it, which is what verifyUploadedObject reads back.
            ...(sha256Base64 !== undefined ? { ChecksumSHA256: sha256Base64 } : { ChecksumAlgorithm: "SHA256" }),
        }));
    }
    async copyObject({ fromObjectKey, toObjectKey }) {
        const { sdk, client } = await this.s3();
        await client.send(new sdk.CopyObjectCommand({
            Bucket: this.bucket,
            // The source is named as a URL path, so a key's own characters are escaped and its slashes kept.
            CopySource: `${this.bucket}/${fromObjectKey.split("/").map(encodeURIComponent).join("/")}`,
            Key: toObjectKey,
        }));
    }
    async deleteObject(objectKey) {
        const { sdk, client } = await this.s3();
        await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    }
    async s3() {
        this.clientSdk ??= withInstallHint(import("@aws-sdk/client-s3"), "@aws-sdk/client-s3", "LambderS3UploadBucket", () => { this.clientSdk = undefined; });
        const sdk = await this.clientSdk;
        this.client ??= new sdk.S3Client(this.clientConfig ?? {});
        return { sdk, client: this.client };
    }
    loadPresignedPostSdk() {
        this.presignedPostSdk ??= withInstallHint(import("@aws-sdk/s3-presigned-post"), "@aws-sdk/s3-presigned-post", "LambderS3UploadBucket", () => { this.presignedPostSdk = undefined; });
        return this.presignedPostSdk;
    }
    loadRequestPresignerSdk() {
        this.requestPresignerSdk ??= withInstallHint(import("@aws-sdk/s3-request-presigner"), "@aws-sdk/s3-request-presigner", "LambderS3UploadBucket", () => { this.requestPresignerSdk = undefined; });
        return this.requestPresignerSdk;
    }
}

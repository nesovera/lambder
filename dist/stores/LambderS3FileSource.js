import { remoteStoreFile } from "../core/LambderFiles.js";
/**
 * Files from an S3 bucket, or any S3-compatible store such as Cloudflare
 * R2 (pass its endpoint in clientConfig). Needs @aws-sdk/client-s3, an
 * optional peer dependency loaded on first read, so apps that serve from a
 * folder never load it. A missing object reads as null and the request
 * falls through; grant s3:ListBucket besides s3:GetObject, otherwise S3
 * answers a missing key with AccessDenied, which propagates as an error.
 * An object's Content-Type is used unless it is a generic octet-stream, in
 * which case the extension decides, as for local files.
 */
export class LambderS3FileSource {
    bucket;
    prefix;
    clientConfig;
    client;
    sdk;
    constructor({ bucket, prefix = "", client, clientConfig }) {
        if (!bucket.trim())
            throw new Error("bucket is required");
        this.bucket = bucket;
        this.prefix = prefix;
        this.client = client;
        this.clientConfig = clientConfig;
    }
    loadSdk() {
        if (!this.sdk) {
            this.sdk = import("@aws-sdk/client-s3").catch(() => {
                throw new Error("LambderS3FileSource requires @aws-sdk/client-s3: npm install @aws-sdk/client-s3");
            });
        }
        return this.sdk;
    }
    async read(relativePath) {
        const { S3Client, GetObjectCommand } = await this.loadSdk();
        if (!this.client)
            this.client = new S3Client(this.clientConfig ?? {});
        let output;
        try {
            output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${relativePath}` }));
        }
        catch (err) {
            const name = err.name;
            if (name === "NoSuchKey" || name === "NotFound")
                return null;
            throw err;
        }
        if (!output.Body)
            return null;
        return remoteStoreFile(Buffer.from(await output.Body.transformToByteArray()), output.ContentType);
    }
}

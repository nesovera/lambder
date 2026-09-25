import { remoteStoreFile } from "../shared/contracts/LambderFileSource.js";
const DEFAULT_NOT_FOUND_ERROR_NAMES = ["NoSuchKey", "NotFound", "AccessDenied", "KeyTooLongError", "InvalidURI", "InvalidObjectName"];
/**
 * Files from an S3 bucket, or any S3-compatible store such as Cloudflare
 * R2 (pass its endpoint in clientConfig). Needs @aws-sdk/client-s3, an
 * optional peer dependency loaded on first read, so apps that serve from a
 * folder never load it. A missing object (see `notFoundErrorNames`) reads as
 * null and the request falls through; any other failure throws. A request
 * path names the key, so a key that is missing or that S3 refuses to look
 * up is the visitor's doing, and reading it as an error would answer every
 * such path with a 500 before an SPA's shell could be served. An object's
 * Content-Type is used unless it is a generic octet-stream, in which case
 * the extension decides, as for local files.
 */
export class LambderS3FileSource {
    bucket;
    prefix;
    clientConfig;
    notFoundErrorNames;
    client;
    sdk;
    constructor({ bucket, prefix = "", client, clientConfig, notFoundErrorNames = DEFAULT_NOT_FOUND_ERROR_NAMES }) {
        if (!bucket.trim())
            throw new Error("bucket is required");
        this.bucket = bucket;
        this.prefix = prefix;
        this.client = client;
        this.clientConfig = clientConfig;
        this.notFoundErrorNames = notFoundErrorNames;
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
            if (typeof name === "string" && this.notFoundErrorNames.includes(name))
                return null;
            throw err;
        }
        if (!output.Body)
            return null;
        return remoteStoreFile(Buffer.from(await output.Body.transformToByteArray()), output.ContentType);
    }
}

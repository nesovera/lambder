import { remoteStoreFile } from "../shared/contracts/LambderFileSource.js";
import { withInstallHint } from "./LambderSdkInstallHint.js";
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
    clientSdk;
    constructor({ bucket, prefix = "", client, clientConfig, notFoundErrorNames = DEFAULT_NOT_FOUND_ERROR_NAMES }) {
        if (!bucket.trim())
            throw new Error("bucket is required");
        this.bucket = bucket;
        this.prefix = prefix;
        this.client = client;
        this.clientConfig = clientConfig;
        this.notFoundErrorNames = notFoundErrorNames;
    }
    async read(relativePath) {
        const { sdk, client } = await this.s3();
        let output;
        try {
            output = await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${relativePath}` }));
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
    /** The SDK, loaded on the first read, and the client: the one supplied, or one made from clientConfig. */
    async s3() {
        this.clientSdk ??= withInstallHint(import("@aws-sdk/client-s3"), "@aws-sdk/client-s3", "LambderS3FileSource", () => { this.clientSdk = undefined; });
        const sdk = await this.clientSdk;
        this.client ??= new sdk.S3Client(this.clientConfig ?? {});
        return { sdk, client: this.client };
    }
}

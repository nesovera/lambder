import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import type { LambderPublicFile, LambderPublicFileSource } from "../core/LambderPublicFiles.js";

export type LambderS3FileSourceOptions = {
    bucket: string;
    /** Literal key prefix the relative path is appended to, so include the trailing slash: "web/v42/". Default: none. */
    prefix?: string;
    /** A ready client, e.g. one shared with the rest of the app. */
    client?: S3Client;
    /**
     * Otherwise the client is created from this on first read: `{ region }`
     * for S3; for Cloudflare R2 or another S3-compatible store,
     * `{ region: "auto", endpoint, credentials }`.
     */
    clientConfig?: S3ClientConfig;
};

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
export class LambderS3FileSource implements LambderPublicFileSource {
    private readonly bucket: string;
    private readonly prefix: string;
    private readonly clientConfig: S3ClientConfig | undefined;
    private client: S3Client | undefined;
    private sdk: Promise<typeof import("@aws-sdk/client-s3")> | undefined;

    constructor({ bucket, prefix = "", client, clientConfig }: LambderS3FileSourceOptions){
        if(!bucket.trim()) throw new Error("bucket is required");
        this.bucket = bucket;
        this.prefix = prefix;
        this.client = client;
        this.clientConfig = clientConfig;
    }

    private loadSdk(){
        if(!this.sdk){
            this.sdk = import("@aws-sdk/client-s3").catch(() => {
                throw new Error("LambderS3FileSource requires @aws-sdk/client-s3: npm install @aws-sdk/client-s3");
            });
        }
        return this.sdk;
    }

    async read(relativePath: string): Promise<LambderPublicFile | null> {
        const { S3Client, GetObjectCommand } = await this.loadSdk();
        if(!this.client) this.client = new S3Client(this.clientConfig ?? {});

        let output;
        try{
            output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${relativePath}` }));
        }catch(err){
            const name = (err as { name?: string }).name;
            if(name === "NoSuchKey" || name === "NotFound") return null;
            throw err;
        }
        if(!output.Body) return null;

        const body = Buffer.from(await output.Body.transformToByteArray());
        const contentType = output.ContentType;
        return contentType && !contentType.endsWith("octet-stream") ? { body, mimeType: contentType } : { body };
    }
}

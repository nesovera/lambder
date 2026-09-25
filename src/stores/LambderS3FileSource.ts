import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { remoteStoreFile, type LambderFile, type LambderFileSource } from "../shared/contracts/LambderFileSource.js";

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
    /**
     * The S3 error names that mean "no such file", read as null so the
     * request falls through. Default: NoSuchKey and NotFound (the key does
     * not exist), AccessDenied (what S3 answers a reader without
     * s3:ListBucket for a missing key, since it will not say whether the key
     * exists), and the refusals of a key S3 will not look up at all:
     * KeyTooLongError and InvalidURI from S3, InvalidObjectName from R2. A
     * reader granted s3:ListBucket gets NoSuchKey for a missing key, so a
     * list without AccessDenied makes a refused credential surface as the
     * error it is.
     */
    notFoundErrorNames?: readonly string[];
};

const DEFAULT_NOT_FOUND_ERROR_NAMES: readonly string[] = ["NoSuchKey", "NotFound", "AccessDenied", "KeyTooLongError", "InvalidURI", "InvalidObjectName"];

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
export class LambderS3FileSource implements LambderFileSource {
    private readonly bucket: string;
    private readonly prefix: string;
    private readonly clientConfig: S3ClientConfig | undefined;
    private readonly notFoundErrorNames: readonly string[];
    private client: S3Client | undefined;
    private sdk: Promise<typeof import("@aws-sdk/client-s3")> | undefined;

    constructor({ bucket, prefix = "", client, clientConfig, notFoundErrorNames = DEFAULT_NOT_FOUND_ERROR_NAMES }: LambderS3FileSourceOptions){
        if(!bucket.trim()) throw new Error("bucket is required");
        this.bucket = bucket;
        this.prefix = prefix;
        this.client = client;
        this.clientConfig = clientConfig;
        this.notFoundErrorNames = notFoundErrorNames;
    }

    private loadSdk(){
        if(!this.sdk){
            this.sdk = import("@aws-sdk/client-s3").catch(() => {
                throw new Error("LambderS3FileSource requires @aws-sdk/client-s3: npm install @aws-sdk/client-s3");
            });
        }
        return this.sdk;
    }

    async read(relativePath: string): Promise<LambderFile | null> {
        const { S3Client, GetObjectCommand } = await this.loadSdk();
        if(!this.client) this.client = new S3Client(this.clientConfig ?? {});

        let output;
        try{
            output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${relativePath}` }));
        }catch(err){
            const name = (err as { name?: unknown }).name;
            if(typeof name === "string" && this.notFoundErrorNames.includes(name)) return null;
            throw err;
        }
        if(!output.Body) return null;

        return remoteStoreFile(Buffer.from(await output.Body.transformToByteArray()), output.ContentType);
    }
}

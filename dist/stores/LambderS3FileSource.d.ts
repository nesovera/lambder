import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { type LambderFile, type LambderFileSource } from "../core/LambderFiles.js";
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
export declare class LambderS3FileSource implements LambderFileSource {
    private readonly bucket;
    private readonly prefix;
    private readonly clientConfig;
    private client;
    private sdk;
    constructor({ bucket, prefix, client, clientConfig }: LambderS3FileSourceOptions);
    private loadSdk;
    read(relativePath: string): Promise<LambderFile | null>;
}

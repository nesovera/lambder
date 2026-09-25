import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { type LambderFile, type LambderFileSource } from "../shared/contracts/LambderFileSource.js";
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
export declare class LambderS3FileSource implements LambderFileSource {
    private readonly bucket;
    private readonly prefix;
    private readonly clientConfig;
    private readonly notFoundErrorNames;
    private client;
    private sdk;
    constructor({ bucket, prefix, client, clientConfig, notFoundErrorNames }: LambderS3FileSourceOptions);
    private loadSdk;
    read(relativePath: string): Promise<LambderFile | null>;
}

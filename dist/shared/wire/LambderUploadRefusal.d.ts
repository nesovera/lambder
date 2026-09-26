import { type LambderUploadFileFacts, type LambderUploadRule } from "../contracts/LambderUploadBucket.js";
/**
 * Refuses the API call signing a ticket when the rule does not accept the
 * file, with the refusal code a client branches and translates on. Both of
 * Lambder's buckets sign through this, and a bucket of an app's own (another
 * store behind LambderUploadBucket) calls it the same way, so a file is
 * refused alike whichever storage an app runs on.
 */
export declare const refuseUnacceptedUpload: (uploadRule: LambderUploadRule, fileFacts: Pick<LambderUploadFileFacts, "mimeType" | "byteSize">) => void;

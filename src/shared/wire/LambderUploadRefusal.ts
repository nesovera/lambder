import { checkUploadRule, type LambderUploadFileFacts, type LambderUploadRule } from "../contracts/LambderUploadBucket.js";
import { LAMBDER_REFUSAL_CODES, refuse } from "./LambderApiRefusal.js";

/**
 * Refuses the API call signing a ticket when the rule does not accept the
 * file, with the refusal code a client branches and translates on. Both of
 * Lambder's buckets sign through this, and a bucket of an app's own (another
 * store behind LambderUploadBucket) calls it the same way, so a file is
 * refused alike whichever storage an app runs on.
 */
export const refuseUnacceptedUpload = (uploadRule: LambderUploadRule, fileFacts: Pick<LambderUploadFileFacts, "mimeType" | "byteSize">): void => {
    const verdict = checkUploadRule(uploadRule, fileFacts);
    if(verdict === "fileEmpty") refuse("This file is empty.", { code: LAMBDER_REFUSAL_CODES.uploadEmpty });
    if(verdict === "fileTypeRejected") refuse("This type of file is not accepted.", { code: LAMBDER_REFUSAL_CODES.uploadTypeRejected });
    if(verdict === "fileTooLarge") refuse("This file is too large.", { code: LAMBDER_REFUSAL_CODES.uploadTooLarge });
};

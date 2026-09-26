import type { LambderUploadObjectOptions } from "../contracts/LambderUploadBucket.js";
/**
 * What a ticket's form carries for the stored object, in the fields S3's
 * presigned POST reads them from: the tag set as the XML `tagging` field,
 * each metadata entry as `x-amz-meta-<name>` (lowercased, as S3 keeps it),
 * `Cache-Control` and `Content-Disposition`. Both buckets build their
 * tickets' fields with this, so a post carries the same form to either, and
 * every field is pinned by the ticket like the key and the checksum.
 */
export declare const uploadObjectFormFields: (object: LambderUploadObjectOptions | undefined) => Record<string, string>;

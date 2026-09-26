import type { LambderUploadObjectOptions } from "../contracts/LambderUploadBucket.js";
import { contentDispositionHeader } from "../util/LambderContentDisposition.js";
import { escapeXmlText } from "../util/escapeXmlText.js";

/**
 * What a ticket's form carries for the stored object, in the fields S3's
 * presigned POST reads them from: the tag set as the XML `tagging` field,
 * each metadata entry as `x-amz-meta-<name>` (lowercased, as S3 keeps it),
 * `Cache-Control` and `Content-Disposition`. Both buckets build their
 * tickets' fields with this, so a post carries the same form to either, and
 * every field is pinned by the ticket like the key and the checksum.
 */
export const uploadObjectFormFields = (object: LambderUploadObjectOptions | undefined): Record<string, string> => {
    const fields: Record<string, string> = {};
    const tags = Object.entries(object?.tags ?? {});
    if(tags.length){
        fields.tagging = `<Tagging><TagSet>${tags.map(([key, value]) => `<Tag><Key>${escapeXmlText(key)}</Key><Value>${escapeXmlText(value)}</Value></Tag>`).join("")}</TagSet></Tagging>`;
    }
    for(const [name, value] of Object.entries(object?.metadata ?? {})) fields[`x-amz-meta-${name.toLowerCase()}`] = value;
    if(object?.cacheControl !== undefined) fields["Cache-Control"] = object.cacheControl;
    if(object?.contentDisposition) fields["Content-Disposition"] = contentDispositionHeader(object.contentDisposition);
    return fields;
};

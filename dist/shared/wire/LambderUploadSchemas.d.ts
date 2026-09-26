import { z } from "zod";
export declare const LambderUploadFileFactsSchema: z.ZodObject<{
    fileName: z.ZodString;
    mimeType: z.ZodString;
    byteSize: z.ZodNumber;
    sha256Base64: z.ZodString;
}, z.core.$strip>;
export declare const LambderUploadTicketSchema: z.ZodObject<{
    uploadUrl: z.ZodURL;
    formFields: z.ZodRecord<z.ZodString, z.ZodString>;
    expiresAt: z.ZodNumber;
}, z.core.$strip>;

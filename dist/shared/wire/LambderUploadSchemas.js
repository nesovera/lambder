import { z } from "zod";
/*
 * The two shapes of a direct upload that cross an app's own API, as schemas
 * an endpoint declares its input and output with: the file facts the browser
 * posts to the ticket endpoint, and the ticket it answers.
 *
 * ```ts
 * requestUpload: defineApi({
 *     input: z.object({ folderId: z.uuid(), fileFacts: LambderUploadFileFactsSchema }),
 *     output: z.object({ ticket: LambderUploadTicketSchema, documentId: z.uuid() }),
 *     guards: "signedIn",
 * }, ...)
 * ```
 *
 * The types they infer are the contract's own (contracts/LambderUploadBucket.ts),
 * which the compiler holds them to below in both directions.
 */
export const LambderUploadFileFactsSchema = z.object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(100),
    byteSize: z.number().int().positive(),
    /** SHA-256 of the file's bytes as base64: 32 bytes are always 43 characters and one pad. */
    sha256Base64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});
export const LambderUploadTicketSchema = z.discriminatedUnion("method", [
    z.object({
        method: z.literal("POST"),
        uploadUrl: z.url(),
        /** Sent as form fields ahead of the file, which storage wants last. */
        formFields: z.record(z.string(), z.string()),
        /** Epoch milliseconds after which storage refuses the ticket. */
        expiresAt: z.number().int(),
    }),
    z.object({
        method: z.literal("PUT"),
        uploadUrl: z.url(),
        /** Sent exactly as given, each one signed into the URL. */
        headers: z.record(z.string(), z.string()),
        /** Epoch milliseconds after which storage refuses the ticket. */
        expiresAt: z.number().int(),
    }),
]);

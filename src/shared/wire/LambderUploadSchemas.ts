import { z } from "zod";
import type { LambderUploadFileFacts, LambderUploadTicket } from "../contracts/LambderUploadBucket.js";

/*
 * The two shapes of a direct upload that cross an app's own API, as schemas
 * an endpoint declares its input and output with: the file facts the browser
 * posts to the ticket endpoint, and the ticket it answers.
 *
 * ```ts
 * .addSessionApi("documents.requestUpload", {
 *     input: z.object({ folderId: z.uuid(), fileFacts: LambderUploadFileFactsSchema }),
 *     output: z.object({ ticket: LambderUploadTicketSchema, documentId: z.uuid() }),
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

export const LambderUploadTicketSchema = z.object({
    uploadUrl: z.url(),
    /** Sent as form fields ahead of the file, which storage wants last. */
    formFields: z.record(z.string(), z.string()),
    /** Epoch milliseconds after which storage refuses the ticket. */
    expiresAt: z.number().int(),
});

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _FileFactsSchemaIsTheContract = Assert<Exactly<z.output<typeof LambderUploadFileFactsSchema>, LambderUploadFileFacts>>;
type _TicketSchemaIsTheContract = Assert<Exactly<z.output<typeof LambderUploadTicketSchema>, LambderUploadTicket>>;

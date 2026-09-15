import type { z } from "zod";
import type { LambderApiEnvelopeBody, LambderApiResponseConfig } from "../shared/wire/LambderApiContract.js";
import { type LambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
export declare const API_ANSWER_CONTENT_TYPE = "application/json; charset=utf-8";
/** The envelope's config plus the logList channel the call accumulated. */
export type LambderApiEnvelopeConfig = LambderApiResponseConfig & {
    logList?: unknown[];
};
/**
 * The wire envelope for one answer. Flags are only present when set, so a
 * plain success is `{ apiVersion, payload }` and nothing else; an empty
 * logList is omitted.
 */
export declare const buildApiEnvelope: <T>(apiVersion: string | null | undefined, payload: T | null, { versionExpired, sessionExpired, notAuthorized, message, errorMessage, logList, crash, }?: LambderApiEnvelopeConfig) => LambderApiEnvelopeBody<T>;
/** An envelope as an answer: JSON body, JSON content type, the status and headers given (200 and none by default). */
export declare const envelopeAnswer: (envelope: LambderApiEnvelopeBody<unknown>, options?: {
    statusCode?: number;
    headers?: Record<string, string | string[]>;
}) => LambderApiAnswer;
/**
 * A thrown refusal as an answer: its errorMessage and flags on the envelope,
 * its status (200 unless it set one) and its extra headers (Retry-After on a
 * rate limit). The logList the call accumulated rides along, as it does on
 * a success.
 */
export declare const refusalAnswer: (err: LambderApiRefusal, apiVersion: string | null | undefined, logList?: unknown[]) => LambderApiAnswer;
/** The body a validation refusal carries, the shape resolveApiOutcome reads a 422 by. */
export type LambderValidationAnswerBody = {
    error: string;
    zodError: {
        name: string;
        message: string;
        issues: z.core.$ZodIssue[];
    };
    /** Present only when the answer was trimmed (issues dropped, or oversized values inside one shortened): how many issues there were. */
    issueCount?: number;
    /** The logList channel the call accumulated, as a success carries it; omitted when empty. */
    logList?: unknown[];
};
/**
 * The standard answer for a rejected input: a 422 whose body spells the
 * ZodError out. Spelled out rather than serialized as-is: zod 4 keeps
 * `issues` as a non-enumerable property, so JSON.stringify(zodError) would
 * carry the issues only inside the message string, and a client's
 * validation handler would receive a ZodError with nothing to branch on.
 *
 * zod's own `message` never ships: it is the whole issue tree re-serialized,
 * so carrying it would send every capped byte a second time. The generated
 * summary takes its place on every answer, trimmed or not.
 */
export declare const validationAnswer: (zodError: z.ZodError, logList?: unknown[]) => LambderApiAnswer;
/** No API is registered under the requested name: a refusal, not a 404, so a typed caller reads it. */
export declare const apiNotFoundAnswer: (apiVersion: string | null | undefined, logList?: unknown[]) => LambderApiAnswer;
/** A session API called without a live session: the protocol's sessionExpired flag, which the caller clears its cookies on. */
export declare const sessionExpiredAnswer: (apiVersion: string | null | undefined, logList?: unknown[]) => LambderApiAnswer;
/** The caller's version is behind the server's: the protocol's versionExpired flag, which the caller reloads on. */
export declare const versionExpiredAnswer: (apiVersion: string | null | undefined) => LambderApiAnswer;
/** A compressed request payload that could not be restored: a 400 with the reason, never a crash. */
export declare const invalidPayloadAnswer: (apiVersion: string | null | undefined, message: string) => LambderApiAnswer;
/**
 * The last-resort answer when the call crashed and nothing else could
 * answer: a 500 that is still an envelope, so a caller reads a structured
 * failure rather than a text page. The server sends it only when its global
 * error handler is absent or itself failed.
 */
export declare const crashAnswer: (apiVersion: string | null | undefined) => LambderApiAnswer;

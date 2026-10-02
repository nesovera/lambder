import type { z } from "zod";
import type { LambderApiEnvelopeBody, LambderRefusalEnvelopeFields, LambderApiRefusalConfig, LambderApiRefusalEnvelope, LambderApiSuccessEnvelope } from "../shared/wire/LambderApiContract.js";
import { type LambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
import type { LambderCrashDetail } from "../shared/wire/LambderCrashDetail.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
export declare const API_ANSWER_CONTENT_TYPE = "application/json; charset=utf-8";
/**
 * A handler's answer as the wire envelope: its parsed output and the logList
 * the call accumulated, nothing else. The only envelope a reader takes for a
 * success; an empty logList is omitted.
 */
export declare const successEnvelope: <T>(apiVersion: string | null | undefined, payload: T, logList?: unknown[]) => LambderApiSuccessEnvelope<T>;
/**
 * Every other answer as the wire envelope: a null payload beside the
 * refusal's message and flags. Flags are only present when set, and an
 * empty logList is omitted.
 */
export declare const refusalEnvelope: (apiVersion: string | null | undefined, { versionExpired, sessionExpired, notAuthorized, refusal, logList, crash }: LambderRefusalEnvelopeFields) => LambderApiRefusalEnvelope;
/**
 * An API call answered from outside its handler (res.apiRefusal on the
 * server, onInvalidInput in the mock) as its envelope, once the config is
 * known to be a refusal: a refusal message or one of the three flags, so a
 * reader never takes it for the handler's output, and a message with a
 * framework code that carries no data, or none, since it answers outside any
 * one endpoint's declared refusals. `writer` names the call in the error, and
 * the logList is the config's own or the one given.
 */
export declare const plainRefusalEnvelope: (apiVersion: string | null | undefined, config: LambderApiRefusalConfig, writer: string, logList?: unknown[]) => LambderApiRefusalEnvelope;
/** An envelope as an answer: JSON body, JSON content type, the status and headers given (200 and none by default). */
export declare const envelopeAnswer: (envelope: LambderApiEnvelopeBody<unknown>, options?: {
    statusCode?: number;
    headers?: Record<string, string | string[]>;
}) => LambderApiAnswer;
/**
 * A thrown refusal as an answer: its refusal and flags on the envelope,
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
 * ZodError out. Not serialized as-is: zod 4 keeps `issues` non-enumerable,
 * so JSON.stringify(zodError) would carry the issues only inside the message
 * string, leaving a client's validation handler nothing to branch on.
 *
 * zod's own `message` never ships: it is the whole issue tree re-serialized
 * and would send every capped byte a second time. A generated summary takes
 * its place on every answer.
 */
export declare const validationAnswer: (zodError: z.ZodError, logList?: unknown[]) => LambderApiAnswer;
/** No API is registered under the requested name: a refusal, not a 404, so a typed caller reads it. */
export declare const apiNotFoundAnswer: (apiVersion: string | null | undefined, logList?: unknown[]) => LambderApiAnswer;
/** A session API called without a live session: the protocol's sessionExpired flag, which the caller clears its cookies on. */
export declare const sessionExpiredAnswer: (apiVersion: string | null | undefined, logList?: unknown[]) => LambderApiAnswer;
/** The caller was built against another shape of the endpoint (the signature gate), or the app judged it stale: the protocol's versionExpired flag, which the caller reloads on. */
export declare const versionExpiredAnswer: (apiVersion: string | null | undefined) => LambderApiAnswer;
/** A compressed request payload that could not be restored: a 400 with the reason, never a crash. */
export declare const invalidPayloadAnswer: (apiVersion: string | null | undefined, message: string) => LambderApiAnswer;
/**
 * The last-resort answer when the call crashed and nothing else could
 * answer: a 500 that is still an envelope, so a caller reads a structured
 * failure rather than a text page. The server sends it only when its global
 * error handler is absent or itself failed. `revealed` (the crash in full,
 * with the call's logList) is passed only for a caller the app's
 * `crashes.reveal` trusts.
 */
export declare const crashAnswer: (apiVersion: string | null | undefined, revealed?: {
    crash: LambderCrashDetail;
    logList: unknown[];
}) => LambderApiAnswer;

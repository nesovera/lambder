import type { z } from "zod";
import type { LambderApiEnvelopeBody, LambderApiResponseConfig } from "../shared/wire/LambderApiContract.js";
import { LAMBDER_REFUSAL_CODES, type LambderApiRefusal, type LambderRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import { setAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";

/*
 * The one place the API envelope is written, and the one mapping from each
 * kind of protocol outcome onto an answer: a success, a thrown refusal, a
 * rejected input, an unknown name, a missing session, a stale client, a
 * malformed compressed payload, and the last-resort crash. The server's
 * res.api() and the mock runtime's handler wrapping both build through
 * buildApiEnvelope, and the pipeline renders every refusal through the
 * functions below, so the two sides cannot drift on a single byte of the
 * wire format. Pure: no Node built-ins, no response classes.
 */

export const API_ANSWER_CONTENT_TYPE = "application/json; charset=utf-8";

/** The envelope's config plus the logList channel the call accumulated. */
export type LambderApiEnvelopeConfig = LambderApiResponseConfig & { logList?: unknown[] };

/**
 * The wire envelope for one answer. Flags are only present when set, so a
 * plain success is `{ apiVersion, payload }` and nothing else; an empty
 * logList is omitted.
 */
export const buildApiEnvelope = <T>(
    apiVersion: string | null | undefined,
    payload: T | null,
    {
        versionExpired, sessionExpired, notAuthorized,
        message, errorMessage, logList, crash,
    }: LambderApiEnvelopeConfig = {},
): LambderApiEnvelopeBody<T> => ({
    apiVersion: apiVersion ?? null,
    payload,
    ...(versionExpired ? { versionExpired } : {}),
    ...(sessionExpired ? { sessionExpired } : {}),
    ...(notAuthorized ? { notAuthorized } : {}),
    // Presence, not truthiness: the three channels below carry app values,
    // and an app that refuses with errorMessage: "" (or 0, or a message
    // object it built empty) meant to say something. The flags above are
    // booleans, where false and absent are the same statement.
    ...(message !== undefined ? { message } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(crash !== undefined ? { crash } : {}),
    ...(logList?.length ? { logList } : {}),
});

/** An envelope as an answer: JSON body, JSON content type, the status and headers given (200 and none by default). */
export const envelopeAnswer = (
    envelope: LambderApiEnvelopeBody<unknown>,
    options: { statusCode?: number; headers?: Record<string, string | string[]> } = {},
): LambderApiAnswer => {
    const headers: Record<string, string[]> = { "Content-Type": [API_ANSWER_CONTENT_TYPE] };
    for(const [key, value] of Object.entries(options.headers ?? {})){
        // Through setAnswerHeader, so a header the refusal names under another
        // casing replaces the envelope's own rather than shipping beside it.
        setAnswerHeader(headers, key, value);
    }
    return { statusCode: options.statusCode ?? 200, headers, body: JSON.stringify(envelope) };
};

/**
 * A thrown refusal as an answer: its errorMessage and flags on the envelope,
 * its status (200 unless it set one) and its extra headers (Retry-After on a
 * rate limit). The logList the call accumulated rides along, as it does on
 * a success.
 */
export const refusalAnswer = (
    err: LambderApiRefusal,
    apiVersion: string | null | undefined,
    logList?: unknown[],
): LambderApiAnswer => envelopeAnswer(
    buildApiEnvelope(apiVersion, null, {
        ...(err.errorMessage !== undefined ? { errorMessage: err.errorMessage } : {}),
        ...(err.notAuthorized ? { notAuthorized: true } : {}),
        ...(err.sessionExpired ? { sessionExpired: true } : {}),
        logList,
    }),
    {
        ...(err.statusCode !== undefined ? { statusCode: err.statusCode } : {}),
        ...(err.headers ? { headers: err.headers } : {}),
    },
);

/** The body a validation refusal carries, the shape resolveApiOutcome reads a 422 by. */
export type LambderValidationAnswerBody = {
    error: string;
    zodError: { name: string; message: string; issues: z.core.$ZodIssue[] };
    /** Present only when the answer was trimmed (issues dropped, or oversized values inside one shortened): how many issues there were. */
    issueCount?: number;
    /** The logList channel the call accumulated, as a success carries it; omitted when empty. */
    logList?: unknown[];
};

/**
 * How many issues a 422 spells out before it starts counting instead. A
 * caller fixing their request needs the first few; the rest are the same
 * mistake repeated.
 */
const MAX_VALIDATION_ISSUES = 50;
/**
 * What the whole issue list may cost, serialized. The count cap alone bounds
 * the wrong thing: ONE `unrecognized_keys` issue carries every key the client
 * posted, so a strictObject answered a 1MB body with a 4MB one, unauthenticated
 * and before any guard ran, and past maxResponseBytes the 422 became a 500.
 * Bytes are what the amplification is measured in, so bytes are what is
 * capped.
 */
const MAX_VALIDATION_ISSUES_BYTES = 32_000;
/** How many entries of one issue's own lists (`keys`, `path`) survive. */
const MAX_VALIDATION_LIST_ENTRIES = 20;
/** How long one string inside an issue may be. */
const MAX_VALIDATION_TEXT_CHARS = 200;

const utf8Encoder = new TextEncoder();

const clampText = (value: string): string =>
    value.length > MAX_VALIDATION_TEXT_CHARS ? `${value.slice(0, MAX_VALIDATION_TEXT_CHARS)}...` : value;

/**
 * One issue with its own strings and lists bounded. Applied field by field
 * rather than to the named fields only, because `keys` is merely the one that
 * grows without a bound TODAY: any issue a schema authors itself may carry a
 * list or a message the client chose the size of.
 */
const clampIssueValue = (value: unknown): unknown => {
    if(typeof value === "string") return clampText(value);
    if(Array.isArray(value)) return value.slice(0, MAX_VALIDATION_LIST_ENTRIES).map(clampIssueValue);
    return value;
};

const clampIssue = (issue: z.core.$ZodIssue): z.core.$ZodIssue =>
    // Structurally an issue with shorter values, so the cast says what the
    // mapping already guarantees: every field is carried through, in kind,
    // and the union's discriminant with it. A mapped object has no way to say
    // that in the type system.
    Object.fromEntries(Object.entries(issue).map(([key, value]) => [key, clampIssueValue(value)])) as unknown as z.core.$ZodIssue;

/** The issue list the body may carry: clamped, then cut to the byte budget, whole issues from the end. */
const boundIssueList = (all: readonly z.core.$ZodIssue[]): { issues: z.core.$ZodIssue[]; trimmed: boolean } => {
    const issues: z.core.$ZodIssue[] = [];
    let bytes = 0;
    let trimmed = false;
    for(const issue of all.slice(0, MAX_VALIDATION_ISSUES)){
        const clamped = clampIssue(issue);
        if(JSON.stringify(clamped) !== JSON.stringify(issue)) trimmed = true;
        const size = utf8Encoder.encode(JSON.stringify(clamped)).length;
        if(bytes + size > MAX_VALIDATION_ISSUES_BYTES){
            trimmed = true;
            // A first issue that is over the budget on its own still has to
            // say what it is: the three fields every issue carries, so a
            // client always has a code and a path to branch on.
            if(issues.length === 0){
                issues.push({ code: clamped.code, path: clamped.path.slice(0, MAX_VALIDATION_LIST_ENTRIES), message: clampText(clamped.message) } as unknown as z.core.$ZodIssue);
            }
            break;
        }
        issues.push(clamped);
        bytes += size;
    }
    return { issues, trimmed: trimmed || issues.length < all.length };
};

/** What the answer says about itself, in place of zod's own message. */
const summarizeIssues = (total: number, listed: number, trimmed: boolean): string => {
    const head = `${total} validation issue${total === 1 ? "" : "s"}`;
    if(listed < total) return `${head}; the first ${listed} are listed.`;
    if(trimmed) return `${head}; oversized values are shortened.`;
    return `${head}.`;
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
export const validationAnswer = (zodError: z.ZodError, logList?: unknown[]): LambderApiAnswer => {
    const { issues, trimmed } = boundIssueList(zodError.issues);
    return {
        statusCode: 422,
        headers: { "Content-Type": [API_ANSWER_CONTENT_TYPE] },
        body: JSON.stringify({
            error: "Input validation failed",
            zodError: {
                name: zodError.name,
                message: summarizeIssues(zodError.issues.length, issues.length, trimmed),
                issues,
            },
            ...(trimmed ? { issueCount: zodError.issues.length } : {}),
            ...(logList?.length ? { logList } : {}),
        } satisfies LambderValidationAnswerBody),
    };
};

/** No API is registered under the requested name: a refusal, not a 404, so a typed caller reads it. */
export const apiNotFoundAnswer = (apiVersion: string | null | undefined, logList?: unknown[]): LambderApiAnswer => envelopeAnswer(
    buildApiEnvelope(apiVersion, null, {
        errorMessage: { type: "warning", code: LAMBDER_REFUSAL_CODES.apiNotFound, content: "API not found." } satisfies LambderRefusalMessage,
        logList,
    }),
);

/** A session API called without a live session: the protocol's sessionExpired flag, which the caller clears its cookies on. */
export const sessionExpiredAnswer = (apiVersion: string | null | undefined, logList?: unknown[]): LambderApiAnswer =>
    envelopeAnswer(buildApiEnvelope(apiVersion, null, { sessionExpired: true, logList }));

/** The caller was built against another shape of the endpoint (the signature gate), or the app judged it stale: the protocol's versionExpired flag, which the caller reloads on. */
export const versionExpiredAnswer = (apiVersion: string | null | undefined): LambderApiAnswer =>
    envelopeAnswer(buildApiEnvelope(apiVersion, null, { versionExpired: true }));

/** A compressed request payload that could not be restored: a 400 with the reason, never a crash. */
export const invalidPayloadAnswer = (apiVersion: string | null | undefined, message: string): LambderApiAnswer => envelopeAnswer(
    buildApiEnvelope(apiVersion, null, {
        errorMessage: { type: "error", code: LAMBDER_REFUSAL_CODES.invalidRequestPayload, content: message } satisfies LambderRefusalMessage,
    }),
    { statusCode: 400 },
);

/**
 * The last-resort answer when the call crashed and nothing else could
 * answer: a 500 that is still an envelope, so a caller reads a structured
 * failure rather than a text page. The server sends it only when its global
 * error handler is absent or itself failed.
 */
export const crashAnswer = (apiVersion: string | null | undefined): LambderApiAnswer => envelopeAnswer(
    buildApiEnvelope(apiVersion, null, { errorMessage: "Internal server error." }),
    { statusCode: 500 },
);

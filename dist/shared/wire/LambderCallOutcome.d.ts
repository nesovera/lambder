/**
 * What an API call ended in, as the server names it in the call's summary
 * line: the reasons a caller reads the same answer by (resolveApiOutcome),
 * with the server's side of a 5xx, a crash, and `other` for an answer that
 * was not written as an API answer (a hook answering an API call with a page
 * of its own).
 */
export type LambderCallOutcome = "success" | "refusal" | "notAuthorized" | "sessionExpired" | "versionExpired" | "validation" | "crash" | "other";
/** An answer's outcome and refusal code, as the code that wrote the answer knows them. */
export type LambderCallOutcomeHint = {
    outcome: LambderCallOutcome;
    /** The refusal's code, a framework code (`lambder/rate-limited`) or an app's; null when the answer carries none. */
    code: string | null;
};
/**
 * An envelope's outcome, read in the order a caller honours it: a 5xx is a
 * crash whatever the envelope says, then the three flags, then a refusal,
 * and anything else is the handler's answer.
 */
export declare const outcomeOfEnvelope: (written: object, statusCode: number) => LambderCallOutcomeHint;
/**
 * The outcome of an answer written as text, for an answer that arrived with
 * no hint (a replayed one, which its store keeps as text): a 422 is a
 * validation refusal, an envelope is read as outcomeOfEnvelope reads it, and
 * anything else is known by its status alone.
 */
export declare const outcomeOfAnswerText: (statusCode: number, body: string) => LambderCallOutcomeHint;

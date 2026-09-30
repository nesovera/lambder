const codeOf = (refusal) => {
    if (refusal === null || typeof refusal !== "object")
        return null;
    const code = refusal.code;
    return typeof code === "string" ? code : null;
};
/**
 * An envelope's outcome, read in the order a caller honours it: a 5xx is a
 * crash whatever the envelope says, then the three flags, then a refusal,
 * and anything else is the handler's answer.
 */
export const outcomeOfEnvelope = (written, statusCode) => {
    const envelope = written;
    if (statusCode >= 500)
        return { outcome: "crash", code: null };
    if (envelope.versionExpired)
        return { outcome: "versionExpired", code: null };
    if (envelope.sessionExpired)
        return { outcome: "sessionExpired", code: null };
    if (envelope.notAuthorized)
        return { outcome: "notAuthorized", code: codeOf(envelope.refusal) };
    if (envelope.refusal !== undefined)
        return { outcome: "refusal", code: codeOf(envelope.refusal) };
    return { outcome: "success", code: null };
};
/**
 * The outcome of an answer written as text, for an answer that arrived with
 * no hint (a replayed one, which its store keeps as text): a 422 is a
 * validation refusal, an envelope is read as outcomeOfEnvelope reads it, and
 * anything else is known by its status alone.
 */
export const outcomeOfAnswerText = (statusCode, body) => {
    if (statusCode >= 500)
        return { outcome: "crash", code: null };
    if (statusCode === 422)
        return { outcome: "validation", code: null };
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return { outcome: "other", code: null };
    }
    if (parsed === null || typeof parsed !== "object" || !("payload" in parsed))
        return { outcome: "other", code: null };
    return outcomeOfEnvelope(parsed, statusCode);
};

import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
/**
 * An answer in the accessor form resolveApiOutcome() reads, the same view a
 * fetch Response or a decoded Lambda result is given. What the mock
 * transport hands the caller.
 *
 * The body is handed over as it stands, base64 hint or not: the only answers
 * that reach here are the mock runtime's own, which are JSON envelopes, and
 * a caller reading a binary body through the JSON accessors would have
 * nothing to do with what it decoded anyway.
 */
export const toHttpAnswer = (answer) => ({
    status: answer.statusCode,
    statusText: "",
    header: (name) => getAnswerHeader(answer.headers, name)?.join(", ") ?? null,
    json: async () => JSON.parse(answer.body),
    text: async () => answer.body,
    setCookies: getAnswerHeader(answer.headers, "Set-Cookie") ?? [],
});

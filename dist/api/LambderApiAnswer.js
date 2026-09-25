import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
/**
 * An answer in the accessor form resolveApiOutcome() reads (the same view a
 * fetch Response or a decoded Lambda result gets); the mock transport hands
 * this to the caller.
 *
 * The body passes through as it stands, base64 hint or not: only the mock
 * runtime's own answers reach here, and those are JSON envelopes. A binary
 * body read through the JSON accessors would be of no use decoded anyway.
 */
export const toHttpAnswer = (answer) => ({
    status: answer.statusCode,
    statusText: "",
    header: (name) => getAnswerHeader(answer.headers, name)?.join(", ") ?? null,
    json: async () => JSON.parse(answer.body),
    text: async () => answer.body,
    setCookies: getAnswerHeader(answer.headers, "Set-Cookie") ?? [],
});

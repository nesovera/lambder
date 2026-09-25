import type { LambderApiHttpAnswer } from "../shared/wire/LambderApiOutcome.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";

/**
 * The core's output for one API call, before any transport-level
 * finalization. The server adapter turns it into a Lambda response
 * (compression, ETag, base64); the mock transport hands it to the caller as
 * it is. The idempotency store persists and replays this shape, which is why
 * it is plain data.
 *
 * Header names keep their written casing; lookups are case-insensitive (see
 * getAnswerHeader), as in LambderResponse.
 */
export type LambderApiAnswer = {
    statusCode: number;
    headers: Record<string, string[]>;
    body: string;
    /**
     * Finalization hints for the server adapter, so an answer that started as
     * a LambderResponse loses nothing on the way: `isBodyBase64` marks a body
     * that is base64 of binary bytes (never cached by the idempotency engine,
     * never compressed); `compress` and `etag` are the LambderResponse flags.
     * The mock runtime finalizes nothing and the stores drop the hints.
     */
    isBodyBase64?: boolean;
    compress?: boolean | "auto";
    etag?: boolean | "auto";
};

/**
 * An answer in the accessor form resolveApiOutcome() reads (the same view a
 * fetch Response or a decoded Lambda result gets); the mock transport hands
 * this to the caller.
 *
 * The body passes through as it stands, base64 hint or not: only the mock
 * runtime's own answers reach here, and those are JSON envelopes. A binary
 * body read through the JSON accessors would be of no use decoded anyway.
 */
export const toHttpAnswer = (answer: LambderApiAnswer): LambderApiHttpAnswer => ({
    status: answer.statusCode,
    statusText: "",
    header: (name) => getAnswerHeader(answer.headers, name)?.join(", ") ?? null,
    json: async () => JSON.parse(answer.body),
    text: async () => answer.body,
    setCookies: getAnswerHeader(answer.headers, "Set-Cookie") ?? [],
});

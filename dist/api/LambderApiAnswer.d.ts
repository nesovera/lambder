import type { LambderApiHttpAnswer } from "../shared/wire/LambderApiOutcome.js";
/**
 * The core's output for one API call: what goes back over the wire before
 * any transport-level finalization. The server adapter turns it into a
 * Lambda response (compression, ETag, base64); the mock transport hands it
 * to the caller as it is. It is also the shape the idempotency store
 * persists and replays, which is why it is plain data.
 *
 * Header names keep the casing they were written with; lookups are
 * case-insensitive (see getAnswerHeader), the way LambderResponse treats
 * them.
 */
export type LambderApiAnswer = {
    statusCode: number;
    headers: Record<string, string[]>;
    body: string;
    /**
     * Finalization hints for the server adapter, carried through so an
     * answer that started as a LambderResponse loses nothing on the way:
     * `isBodyBase64` marks a body that is base64 of binary bytes (never
     * cached by the idempotency engine, never compressed), `compress` and
     * `etag` are the LambderResponse flags. The mock runtime finalizes
     * nothing, so it hands the body to the caller as it stands; the stores
     * drop the hints.
     */
    isBodyBase64?: boolean;
    compress?: boolean | "auto";
    etag?: boolean | "auto";
};
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
export declare const toHttpAnswer: (answer: LambderApiAnswer) => LambderApiHttpAnswer;

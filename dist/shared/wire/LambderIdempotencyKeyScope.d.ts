/**
 * What a key scope reads from an attempt's outcome. Both callers' outcomes
 * carry these fields, so the one rule below serves the browser caller and
 * the invoke caller alike.
 */
export type LambderIdempotentAttemptOutcome = {
    ok: boolean;
    reason?: string;
    status?: number;
    errorMessage?: {
        code?: string;
    };
};
/** One call's key, and what tells its scope how the call ended. */
export type LambderIdempotentAttempt = {
    /** The key this attempt sends; undefined for a call that sends none. */
    readonly key: string | undefined;
    /** Tells the scope the attempt's outcome, once it is known. Only the first call counts. */
    settle(outcome: LambderIdempotentAttemptOutcome): void;
};
/** The outcome of an attempt that ended before anything was sent: it tried nothing. */
export declare const IDEMPOTENT_ATTEMPT_NOT_SENT: LambderIdempotentAttemptOutcome;
/**
 * Generate an idempotency key for one logical operation. Create it when the
 * operation begins (a form opens, a draft starts), send the same key on every
 * attempt of that operation, and generate a new one after a confirmed
 * success; createIdempotencyKeyScope() does that bookkeeping itself. Uses
 * crypto.randomUUID when available, else a v4 UUID from getRandomValues,
 * because randomUUID only exists in secure contexts (plain-http LAN device
 * testing lacks it).
 *
 * A runtime with neither throws rather than using Math.random: the key
 * scopes the replay record for a logged-out client, so a guessable one hands
 * that client's stored response to whoever guesses it.
 */
export declare const createIdempotencyKey: () => string;
/**
 * One logical operation's rotating idempotency key, from
 * createIdempotencyKeyScope(). Every attempt of the operation
 * sends the current key, and the scope moves to a new key once an answer
 * settles the operation:
 *
 * - A success settles it, and so does a key refused as reused for another
 *   request, since that key can never carry this one.
 * - A refusal of this request (a rejected input, not authorized, an
 *   errorMessage) settles it, unless another attempt under the same key is
 *   still in flight or went unanswered. That attempt may run or have run the
 *   operation, and guards, validation and rate limits refuse before the
 *   replay record is claimed, so the refusal of a retry or a double-tap says
 *   nothing about it. Keeping the key lets the next attempt replay the
 *   original's answer rather than run again.
 * - A rate limit, an expired session, a stale version, and an attempt that
 *   ended before anything was sent keep the key.
 * - Anything that is not an answer (a network failure, a timeout, a 5xx, a
 *   crash) keeps the key and marks it as possibly used, and so does a
 *   duplicate of an original still in flight, unless the scope has another
 *   attempt of its own still waiting for its answer (a double-tap): that
 *   attempt is the original, and its answer settles the key, a refusal
 *   included.
 *
 * An answer to a key the scope has already moved past changes nothing: a
 * slow original answering after the person moved on must not rotate away
 * the key their current attempt is using.
 */
export declare class LambderIdempotencyKeyScope {
    #private;
    /** The key for the operation currently in progress. */
    get current(): string;
    /** Moves on to a new operation by hand, for a caller that settles operations itself. Returns the new key. */
    rotate(): string;
}
/**
 * A self-rotating idempotency key for a component or form that performs the
 * same logical operation repeatedly. Pass the scope itself as the call's
 * `idempotencyKey`, on LambderCaller or LambderInvokeCaller: every attempt of
 * one operation (a retry after a dropped connection, a double-tap) sends its
 * current key, so the server collapses them, and the caller rotates it once
 * an answer settles the operation (a success, or a refusal of this request),
 * so the next attempt, a corrected form included, is a new operation.
 * LambderIdempotencyKeyScope says which answers settle it.
 *
 * ```typescript
 * const submitKey = createIdempotencyKeyScope();
 * await caller.api("order.create", payload, { idempotencyKey: submitKey });
 * ```
 */
export declare const createIdempotencyKeyScope: () => LambderIdempotencyKeyScope;
/** The attempt a call makes with its idempotencyKey option: a scope's current key, or a plain key with nothing to settle. */
export declare const beginIdempotentAttempt: (option: string | LambderIdempotencyKeyScope | undefined) => LambderIdempotentAttempt;

import { LAMBDER_REFUSAL_CODES } from "./LambderApiRefusal.js";
/** The outcome of an attempt that ended before anything was sent: it tried nothing. */
export const IDEMPOTENT_ATTEMPT_NOT_SENT = { ok: false, reason: "notSent" };
/**
 * Refusals that answer this request itself, so the same request would get
 * the same answer again and what the person sends next is a new operation.
 */
const REFUSAL_REASONS = new Set(["validation", "notAuthorized", "errorMessage"]);
/** Answers that never reached the operation: the same request may pass later. */
const UNTRIED_REASONS = new Set(["sessionExpired", "versionExpired", "payloadTooLarge", "notSent"]);
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
export const createIdempotencyKey = () => {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj?.randomUUID)
        return cryptoObj.randomUUID();
    if (!cryptoObj?.getRandomValues)
        throw new Error("createIdempotencyKey needs crypto.getRandomValues: an idempotency key must be unguessable, and this runtime offers no random source that is.");
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
/** What a scope's attempts are started through: the class hands it out once, below, so it is reachable from this module alone. */
let beginAttemptOf;
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
export class LambderIdempotencyKeyScope {
    #key = createIdempotencyKey();
    #possiblyUsed = false;
    /** Attempts under the current key that have not settled yet. */
    #inFlight = 0;
    static {
        beginAttemptOf = (scope) => scope.#beginAttempt();
    }
    /** The key for the operation currently in progress. */
    get current() { return this.#key; }
    /** Moves on to a new operation by hand, for a caller that settles operations itself. Returns the new key. */
    rotate() {
        this.#key = createIdempotencyKey();
        this.#possiblyUsed = false;
        this.#inFlight = 0;
        return this.#key;
    }
    /**
     * Starts one attempt under the current key; the callers do this for
     * every call handed the scope. Private, and reached through
     * beginIdempotentAttempt: an attempt started and never settled holds the
     * in-flight count up, so a refusal would stop moving the key.
     */
    #beginAttempt() {
        const key = this.#key;
        this.#inFlight += 1;
        let settled = false;
        return { key, settle: (outcome) => {
                if (settled)
                    return;
                settled = true;
                if (key !== this.#key)
                    return;
                this.#inFlight -= 1;
                const code = outcome.errorMessage?.code;
                if (outcome.ok || code === LAMBDER_REFUSAL_CODES.idempotencyKeyReused) {
                    this.rotate();
                    return;
                }
                // A rate limit refuses before the claim, whatever code a policy's
                // own message carries, so its status is what names it.
                if (UNTRIED_REASONS.has(outcome.reason ?? "") || outcome.status === 429 || code === LAMBDER_REFUSAL_CODES.rateLimited)
                    return;
                if (REFUSAL_REASONS.has(outcome.reason ?? "") && code !== LAMBDER_REFUSAL_CODES.duplicateInFlight) {
                    if (!this.#possiblyUsed && this.#inFlight === 0)
                        this.rotate();
                    return;
                }
                // A duplicate while another attempt of this scope still waits for
                // its answer: unless an earlier attempt went unanswered (which
                // marked the key already), the running original is that attempt,
                // and its own answer settles the key. Marked here, the key would
                // outlive that answer when it is a refusal, and the corrected
                // request after it would be refused as a reused key.
                if (code === LAMBDER_REFUSAL_CODES.duplicateInFlight && this.#inFlight > 0)
                    return;
                // No answer, or an original this scope has no attempt waiting
                // for: the operation may have run under this key.
                this.#possiblyUsed = true;
            } };
    }
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
export const createIdempotencyKeyScope = () => new LambderIdempotencyKeyScope();
/** The attempt a call makes with its idempotencyKey option: a scope's current key, or a plain key with nothing to settle. */
export const beginIdempotentAttempt = (option) => option instanceof LambderIdempotencyKeyScope ? beginAttemptOf(option) : { key: option, settle: () => { } };

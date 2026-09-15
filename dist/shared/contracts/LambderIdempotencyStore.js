/**
 * The idempotency vocabulary every part of Lambder shares: what a stored
 * answer looks like, what claiming a scope reports, and the four methods the
 * idempotency engine asks of a store.
 *
 * Kept apart from the engine for the same reason LambderRateLimiter is:
 * a store implements this and nothing else, and importing it from the engine
 * would pull the engine (and through it the refusal machinery) into every
 * store's import graph. Pure and dependency-free, so the mock runtime and the
 * browser entry can resolve it.
 */
export {};

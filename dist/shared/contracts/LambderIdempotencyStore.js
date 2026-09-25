/**
 * The idempotency vocabulary every part of Lambder shares: what a stored
 * answer looks like, what claiming a scope reports, and the four methods the
 * idempotency engine asks of a store.
 *
 * Kept apart from the engine, like LambderRateLimiter: a store implements this
 * and nothing else, and importing it from the engine would pull the engine
 * and its refusal machinery into every store's import graph. Dependency-free,
 * so the mock runtime and the browser entry can resolve it.
 */
export {};

/**
 * The runtime shapes of the three per-API policy options (guards, rate limit,
 * idempotency), declared below both the contract that records them and the
 * engines that enforce them so neither has to import the other.
 *
 * A contract type carries these options exactly as an API wrote them, and the
 * engines in `api/` read the same shapes back. Declaring them here is what
 * keeps `shared/` at the bottom of the stack: without it the contract would
 * name an `api/` type and `shared/` would depend on a layer above it.
 */
export {};

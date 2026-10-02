/**
 * The runtime shapes of the per-API declarative options (guards, rate limit,
 * idempotency, refusals), declared below both the contract that records them
 * and the engines that enforce them so neither has to import the other.
 *
 * A contract type carries these options exactly as an API wrote them, and the
 * engines in `api/` read the same shapes back. Declaring them here is what
 * keeps `shared/` at the bottom of the stack: without it the contract would
 * name an `api/` type and `shared/` would depend on a layer above it.
 */
import type { LambderUncheckedRefusalMessage } from "./LambderApiRefusal.js";
import type { LambderRateLimitPolicy } from "../contracts/LambderRateLimiter.js";
/** The guards option's runtime shape: a name, ordered names, or a name-to-param map. */
export type LambderGuardsOptionValue = string | readonly string[] | Readonly<Record<string, unknown>>;
/**
 * The message a rate-limit refusal carries, as a policy or an API writes it:
 * its type, title and content. Its code is always `lambder/rate-limited` and
 * its data always the framework's (the policy that refused and the seconds to
 * wait, LambderRateLimitRefusalData), so a rate limit is never a code an
 * endpoint has to declare.
 */
export type LambderRateLimitMessage = Omit<LambderUncheckedRefusalMessage, "code" | "data">;
/**
 * What an API may override on a policy it references, in the map form of the
 * rateLimit option. Windows merge over the policy's own (a tighter burst keeps
 * the policy's daily cap) and are only overridable on "perApi" budgets: a
 * shared counter has one set of numbers. refusal is per-API text, so it
 * is overridable on either budget.
 */
export type LambderRateLimitOverride = LambderRateLimitPolicy & {
    refusal?: LambderRateLimitMessage;
};
/** The rateLimit option's runtime shape: a name, ordered names, or a name-to-override map (LambderRateLimitOption narrows the names and overrides per policy). */
export type LambderRateLimitOptionValue = string | readonly string[] | Readonly<Record<string, true | LambderRateLimitOverride | undefined>>;
/** The refusals option's runtime shape: one code of the app's vocabulary, or a non-empty list of them. */
export type LambderRefusalsOptionValue = string | readonly string[];
/** The per-endpoint idempotency declaration: on, or on with its own replay TTL. */
export type LambderApiIdempotencyOption = boolean | {
    /** Seconds this API's stored answer replays for; overrides defaultTtlSeconds. */
    ttlSeconds?: number;
    /**
     * Seconds this API's claim stays pending before a retry may take the
     * scope; overrides defaultPendingTtlSeconds. Raise it on an API whose
     * handler can run longer than the default, or a retry that arrives after
     * it expires runs the operation a second time while the original is still
     * working.
     */
    pendingTtlSeconds?: number;
};

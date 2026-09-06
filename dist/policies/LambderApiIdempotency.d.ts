import type { LambderRenderContext } from "../core/LambderContext.js";
import type { LambderDdbIdempotency } from "../stores/LambderDdbIdempotency.js";
import { LambderResponse } from "../core/LambderResponse.js";
export type LambderApiIdempotencyConfig = {
    /** Your idempotency store instance; may share the rate limiter's table (distinct key prefix). */
    store: LambderDdbIdempotency;
    /** Seconds a stored response replays for. Default: 86400 (24h). Per-API override: idempotency: { ttlSeconds }. */
    defaultTtlSeconds?: number;
    /** Skip idempotency (execute normally) when DynamoDB errors, instead of failing the request. Default: true. */
    failOpen?: boolean;
};
/**
 * Runtime side of the idempotency subsystem: claims a per-operation scope
 * around handler execution, replays stored responses, and settles claims.
 * Composed into LambderApiPolicyEngine.
 */
export declare class LambderApiIdempotencyEngine {
    private store;
    private defaultTtlSeconds;
    private failOpen;
    configure(config: LambderApiIdempotencyConfig): void;
    /** True once the idempotency option was configured; registration asserts check it. */
    get isConfigured(): boolean;
    /**
     * The request's idempotencyKey: null when absent, the key when valid, a
     * 400 refusal when malformed. The minimum length matters for security:
     * see IDEMPOTENCY_MIN_KEY_LENGTH.
     */
    private readKey;
    /**
     * The record's scope. Session APIs scope per session, so even a leaked
     * key cannot cross users. Public APIs scope by the key alone: the key is
     * required to be long (and documented to be random), and identity proxies
     * like the client IP are deliberately NOT part of the scope, because the
     * retry idempotency exists for (a timeout followed by a network change)
     * frequently arrives from a different IP.
     */
    private scopeOf;
    /**
     * Replay fast path, run BEFORE rate limits and guards: a completed record
     * answers with its stored response so a legitimate retry neither burns
     * rate-limit quota nor re-runs guards (the original already passed them,
     * and no handler executes). Misses fall through to the normal pipeline;
     * store errors follow the failOpen setting.
     */
    findReplay(apiName: string, ctx: LambderRenderContext): Promise<LambderResponse | null>;
    /**
     * Idempotency wrapper around validation-passed handler execution. Without
     * a client idempotencyKey the handler just runs; with one, the scope
     * (identity + api + key) is claimed atomically: duplicates of an
     * in-flight original refuse with 409, replays of a completed one return
     * the stored response verbatim, and a crashed original releases its claim
     * so a retry actually retries.
     */
    withIdempotency(apiName: string, ctx: LambderRenderContext, config: boolean | {
        ttlSeconds?: number;
    }, exec: () => Promise<LambderResponse>): Promise<LambderResponse>;
}

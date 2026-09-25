import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext, LambderApiCallTrace } from "./LambderApiCallContext.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
import type { LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import type { LambderApiIdempotencyOption } from "../shared/wire/LambderApiOptionValues.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
export type LambderApiIdempotencyConfig = {
    /** Your idempotency store instance; may share the rate limiter's table (distinct key prefix). */
    store: LambderIdempotencyStore;
    /** Seconds a stored response replays for. Default: 86400 (24h). Per-API override: idempotency: { ttlSeconds }. */
    defaultTtlSeconds?: number;
    /**
     * Seconds a claim stays pending before a retry may take the scope.
     * Default: 300. Raise it past the longest a handler of yours can run, or
     * a retry arriving after it expires executes the operation again while
     * the original is still working. Per-API override:
     * idempotency: { pendingTtlSeconds }.
     */
    defaultPendingTtlSeconds?: number;
    /** Skip idempotency (execute normally) when the store errors, instead of failing the request. Default: true. */
    failOpen?: boolean;
    /**
     * Who a request is acting as, for scoping a PUBLIC API's stored answer
     * (session APIs already scope per user, by the session's sessionKey).
     *
     * Without it, a public API's scope is the posted key alone, which makes
     * the key a bearer token for its stored answer. The replay is served
     * BEFORE guards run, so an API authorized by a guard would hand its
     * answer to anyone holding the key. An identity here puts the caller in
     * the scope, so a key replays only to whoever it was issued to.
     *
     * The context arrives without a session (public APIs read none); the
     * function sees what the request carries: `request.guardInputs`,
     * `request.payload`, `request.headers` and `request.ip`. Read the
     * credential a guard would check, not a value that changes between
     * attempts: a single-use token (a captcha) would give the legitimate
     * retry a different scope and defeat its replay. Return null for
     * requests with no identity.
     */
    callerIdentity?: (ctx: Omit<LambderApiCallContext, "session">, request: LambderApiRequest) => string | null | Promise<string | null>;
};
/**
 * A call under an idempotency key: the scope its record lives under, and the
 * fingerprint of the request as it was posted. Worked out once per call, by
 * resolveKeyedCall, and handed to the replay lookup and the claim.
 */
export type LambderIdempotentCall = {
    scopeKey: string;
    fingerprint: string;
};
/**
 * Runtime side of the idempotency subsystem: claims a per-operation scope
 * around handler execution, replays stored answers, and settles claims.
 * Held by LambderApiPipeline. Works on plain answers, so it runs
 * unchanged under the server and the mock runtime.
 */
export declare class LambderApiIdempotencyEngine {
    /** Stamped on the crash answer the engine records for an answer that broke its output schema. */
    private readonly apiVersion;
    private store;
    private defaultTtlSeconds;
    private defaultPendingTtlSeconds;
    private failOpen;
    private callerIdentity;
    constructor(apiVersion: string | null);
    configure(config: LambderApiIdempotencyConfig): void;
    /**
     * Puts the engine over another store, for `lambder/testing`; the replay
     * TTLs, failOpen and callerIdentity stay as configured. False when
     * idempotency was never configured.
     */
    [LAMBDER_BACKEND_SWAP](store: LambderIdempotencyStore): boolean;
    /** Startup validation of one API registration's idempotency option. */
    assertRegistration(apiName: string, config: LambderApiIdempotencyOption): void;
    /** True once the idempotency option was configured; registration asserts check it. */
    get isConfigured(): boolean;
    /**
     * The request's idempotencyKey: null when absent, the key when valid, a
     * 400 refusal when malformed. The minimum length matters for security:
     * see IDEMPOTENCY_MIN_KEY_LENGTH.
     */
    private readKey;
    /**
     * The record's scope. Session APIs scope per user (the sessionKey, which
     * every session of one user shares), so even a leaked key cannot cross
     * users. Public APIs scope by the key alone (it must be
     * long and is documented to be random) unless the app supplies
     * callerIdentity. The client IP is deliberately NOT part of the scope:
     * the retry idempotency exists for (a timeout, then a network change)
     * often arrives from a different IP. Apps whose public APIs are
     * authorized by a guard should give callerIdentity, since the replay is
     * served before guards run.
     *
     * joinKeyFields escapes the fields, so no two distinct scopes collide.
     * The identity field is the caller's (a device token in the docs' own
     * example), so it is bounded first (boundKeyField): an over-long one
     * would push the scope past a store's key limit, and the store's refusal
     * is a throw that failOpen turns into no idempotency for that caller.
     */
    private scopeOf;
    /**
     * The call's key worked out, once per call: its scope and its request's
     * fingerprint, for findReplay and withIdempotency. Null for a call that
     * sends no key, or when idempotency is not configured; a malformed key
     * refuses with a 400. Taken at the replay lookup, before input validation
     * replaces the payload with its parsed form, so the fingerprint is of the
     * request as it was posted, and callerIdentity (app code that may verify
     * a token or read a store) runs once.
     */
    resolveKeyedCall(apiName: string, request: LambderApiRequest, ctx: LambderApiCallContext): Promise<LambderIdempotentCall | null>;
    /**
     * Replay fast path, run before guards and all rate limits except
     * `per: "ip"`: a completed record returns its stored answer, so a
     * legitimate retry neither burns quota nor re-runs guards (the original
     * passed them, and no handler executes). The IP limits run first because
     * the store read a replay costs is one of the things they bound. Misses
     * fall through to the normal pipeline; store errors follow failOpen.
     */
    findReplay(apiName: string, call: LambderIdempotentCall, trace: LambderApiCallTrace): Promise<LambderApiAnswer | null>;
    /**
     * Idempotency wrapper around validation-passed handler execution, for a
     * call resolveKeyedCall found a key on (a keyless call runs its handler
     * without one): the scope (identity + api + key) is claimed atomically: duplicates of an in-flight original
     * refuse with 409, replays of a completed one return the stored answer
     * verbatim, and a crashed original releases its claim so a retry retries.
     *
     * `exec` returns the handler's own answer with the headers the handler
     * wrote, so a Set-Cookie it set is visible to the caching rule below.
     * Headers written EARLIER in the call (a session read evicting a stale
     * cookie) are deliberately left off: they reach the client either way,
     * and charging them to this answer would make it uncacheable, silently
     * ending the operation's idempotency.
     */
    withIdempotency(apiName: string, { scopeKey, fingerprint }: LambderIdempotentCall, config: LambderApiIdempotencyOption, trace: LambderApiCallTrace, exec: () => Promise<LambderApiAnswer>): Promise<LambderApiAnswer>;
}

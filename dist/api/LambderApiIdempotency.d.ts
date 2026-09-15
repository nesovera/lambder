import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext, LambderApiCallTrace } from "./LambderApiCallContext.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
import type { LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import type { LambderApiIdempotencyOption } from "../shared/wire/LambderApiOptionValues.js";
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
     * Who a request is acting as, for scoping a PUBLIC API's stored answer.
     * Session APIs already scope per session, so this only affects the ones
     * that do not have a session to scope by.
     *
     * Without it, a public API's scope is the posted key alone, which makes
     * that key a bearer token for its own stored answer: anyone presenting it
     * gets the response back, and the replay is served BEFORE guards run, so
     * an API whose authorization is a guard hands its answer over without the
     * guard ever being consulted. Returning an identity here puts that caller
     * in the scope, so a key only replays to whoever it was issued to.
     *
     * Consulted only on public APIs, and a public API reads no session, so
     * there is no session here to read: the context arrives without one, and
     * an identity that came from a session would be the session scope the
     * engine already applies. It sees what the request itself carries, and
     * that is the point of it: `request.guardInputs`, `request.payload`,
     * `request.headers` and `request.ip`.
     *
     * Read the credential a guard would check, not a value that changes
     * between attempts: a single-use token (a captcha) would give the
     * legitimate retry a different scope and defeat the replay it needs.
     * Return null for requests with no identity to speak of.
     */
    callerIdentity?: (ctx: Omit<LambderApiCallContext, "session">, request: LambderApiRequest) => string | null | Promise<string | null>;
};
/**
 * Runtime side of the idempotency subsystem: claims a per-operation scope
 * around handler execution, replays stored answers, and settles claims.
 * Composed into LambderApiPolicyEngine. Works on plain answers, so it runs
 * unchanged under the server and the mock runtime.
 */
export declare class LambderApiIdempotencyEngine {
    private store;
    private defaultTtlSeconds;
    private defaultPendingTtlSeconds;
    private failOpen;
    private callerIdentity;
    /**
     * The scope this call resolved to, keyed by its context, which is the one
     * object per call the engine is handed. A keyed request asks for it
     * twice, at the replay lookup and at the claim, and callerIdentity is app
     * code that may verify a token or read a store: running it twice per
     * request is a cost the app never asked for, and one it cannot see.
     * Entries go when the call's context does.
     */
    private readonly scopeByCall;
    configure(config: LambderApiIdempotencyConfig): void;
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
     * The record's scope. Session APIs scope per session, so even a leaked
     * key cannot cross users. Public APIs scope by the key alone unless the
     * app supplies callerIdentity, because the key is required to be long
     * (and documented to be random), and identity proxies like the client IP
     * are deliberately NOT part of the scope: the retry idempotency exists
     * for (a timeout followed by a network change) frequently arrives from a
     * different IP. An app whose public APIs are authorized by a guard should
     * give callerIdentity, since the replay is served before guards run.
     *
     * Fields are escaped and joined through joinKeyFields, so no two distinct
     * scopes can produce one string.
     */
    private scopeOf;
    private computeScope;
    /**
     * Replay fast path, run before the remaining rate limits and before
     * guards: a completed record answers with its stored answer, so a
     * legitimate retry neither burns rate-limit quota nor re-runs guards (the
     * original already passed them, and no handler executes). The `per: "ip"`
     * limits are the exception and are checked ahead of this, since the store
     * read a replay costs is one of the things they exist to bound. Misses
     * fall through to the normal pipeline; store errors follow the failOpen
     * setting.
     */
    findReplay(apiName: string, request: LambderApiRequest, ctx: LambderApiCallContext, trace: LambderApiCallTrace): Promise<LambderApiAnswer | null>;
    /**
     * Idempotency wrapper around validation-passed handler execution. Without
     * a client idempotencyKey the handler just runs; with one, the scope
     * (identity + api + key) is claimed atomically: duplicates of an
     * in-flight original refuse with 409, replays of a completed one return
     * the stored answer verbatim, and a crashed original releases its claim
     * so a retry actually retries.
     *
     * `exec` must hand back the handler's own answer, the headers the handler
     * itself wrote included: the pipeline applies those before returning here,
     * so a Set-Cookie the handler set is visible to the caching rule below.
     * Headers written EARLIER in the call (a session read evicting a stale
     * cookie) are deliberately not on it: they are the call's, they reach the
     * client either way, and charging them to this answer would make an
     * idempotent operation silently stop being idempotent.
     */
    withIdempotency(apiName: string, request: LambderApiRequest, ctx: LambderApiCallContext, config: LambderApiIdempotencyOption, trace: LambderApiCallTrace, exec: () => Promise<LambderApiAnswer>): Promise<LambderApiAnswer>;
}

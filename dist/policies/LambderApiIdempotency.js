import { LambderApiError } from "../shared/LambderApiError.js";
import { LambderResponse, normalizeHeaders } from "../core/LambderResponse.js";
/** A crashed original must not block retries forever: pending claims expire on their own. */
const IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
/**
 * Keys must be unguessable: without a session, the replay scope is the key
 * itself, so a guessable key would let one client read another's stored
 * response. LambderCaller.createIdempotencyKey() returns 36 chars.
 */
const IDEMPOTENCY_MIN_KEY_LENGTH = 16;
const IDEMPOTENCY_MAX_KEY_LENGTH = 200;
/**
 * Runtime side of the idempotency subsystem: claims a per-operation scope
 * around handler execution, replays stored responses, and settles claims.
 * Composed into LambderApiPolicyEngine.
 */
export class LambderApiIdempotencyEngine {
    store = null;
    defaultTtlSeconds = 24 * 3600;
    failOpen = true;
    configure(config) {
        if (this.store)
            throw new Error("Lambder: idempotency was already configured.");
        this.store = config.store;
        this.defaultTtlSeconds = config.defaultTtlSeconds ?? 24 * 3600;
        this.failOpen = config.failOpen ?? true;
    }
    /** True once the idempotency option was configured; registration asserts check it. */
    get isConfigured() { return this.store !== null; }
    /**
     * The request's idempotencyKey: null when absent, the key when valid, a
     * 400 refusal when malformed. The minimum length matters for security:
     * see IDEMPOTENCY_MIN_KEY_LENGTH.
     */
    readKey(ctx) {
        const rawKey = ctx.post?.idempotencyKey;
        if (rawKey === undefined || rawKey === null)
            return null;
        if (typeof rawKey !== "string" || rawKey.length < IDEMPOTENCY_MIN_KEY_LENGTH || rawKey.length > IDEMPOTENCY_MAX_KEY_LENGTH) {
            throw new LambderApiError(`Invalid idempotency key: must be a string of ${IDEMPOTENCY_MIN_KEY_LENGTH}-${IDEMPOTENCY_MAX_KEY_LENGTH} characters.`, { statusCode: 400 });
        }
        return rawKey;
    }
    /**
     * The record's scope. Session APIs scope per session, so even a leaked
     * key cannot cross users. Public APIs scope by the key alone: the key is
     * required to be long (and documented to be random), and identity proxies
     * like the client IP are deliberately NOT part of the scope, because the
     * retry idempotency exists for (a timeout followed by a network change)
     * frequently arrives from a different IP.
     */
    scopeOf(apiName, ctx, key) {
        const sessionKey = ctx.session?.sessionKey;
        return `${sessionKey ? `s:${sessionKey}` : "k"}|${apiName}|${key}`;
    }
    /**
     * Replay fast path, run BEFORE rate limits and guards: a completed record
     * answers with its stored response so a legitimate retry neither burns
     * rate-limit quota nor re-runs guards (the original already passed them,
     * and no handler executes). Misses fall through to the normal pipeline;
     * store errors follow the failOpen setting.
     */
    async findReplay(apiName, ctx) {
        const store = this.store;
        if (!store)
            return null;
        const key = this.readKey(ctx);
        if (key === null)
            return null;
        try {
            const done = await store.peek(this.scopeOf(apiName, ctx, key));
            if (!done)
                return null;
            return new LambderResponse({
                statusCode: done.statusCode,
                headers: done.headers,
                body: done.body,
            });
        }
        catch (err) {
            if (this.failOpen)
                return null;
            throw err;
        }
    }
    /**
     * Idempotency wrapper around validation-passed handler execution. Without
     * a client idempotencyKey the handler just runs; with one, the scope
     * (identity + api + key) is claimed atomically: duplicates of an
     * in-flight original refuse with 409, replays of a completed one return
     * the stored response verbatim, and a crashed original releases its claim
     * so a retry actually retries.
     */
    async withIdempotency(apiName, ctx, config, exec) {
        const store = this.store;
        if (!store)
            return await exec();
        const rawKey = this.readKey(ctx);
        if (rawKey === null)
            return await exec();
        const ttlSeconds = (typeof config === "object" ? config.ttlSeconds : undefined) ?? this.defaultTtlSeconds;
        const scopeKey = this.scopeOf(apiName, ctx, rawKey);
        let begun;
        try {
            begun = await store.begin(scopeKey, { pendingTtlSeconds: IDEMPOTENCY_PENDING_TTL_SECONDS });
        }
        catch (err) {
            if (this.failOpen)
                return await exec();
            throw err;
        }
        if (begun.state === "pending") {
            throw new LambderApiError(`Duplicate request for "${apiName}": the original is still processing.`, {
                statusCode: 409,
                errorMessage: "This request is already being processed.",
            });
        }
        if (begun.state === "done") {
            return new LambderResponse({
                statusCode: begun.statusCode,
                headers: begun.headers,
                body: begun.body,
            });
        }
        const ownerToken = begun.ownerToken;
        // Headers pushed via res.setHeader/res.addHeader (and session cookie
        // writes) land on ctx accumulators and are applied AFTER this wrapper
        // returns, so snapshot the baseline: entries added during exec belong
        // to this response and must be stored with it, and a Set-Cookie among
        // them makes the response uncacheable (replaying another request's
        // cookies, e.g. session tokens, would be wrong).
        const setBaseline = ctx._otherInternal.setHeaderFnAccumulator.length;
        const addBaseline = ctx._otherInternal.addHeaderFnAccumulator.length;
        // Store the response for replays when it qualifies, release the claim
        // otherwise. Settle failures only surface when failing closed.
        const settleClaim = async (response) => {
            const execSetHeaders = ctx._otherInternal.setHeaderFnAccumulator.slice(setBaseline);
            const execAddHeaders = ctx._otherInternal.addHeaderFnAccumulator.slice(addBaseline);
            const setsCookie = response.getHeader("Set-Cookie") !== undefined
                || [...execSetHeaders, ...execAddHeaders].some((h) => h.key.toLowerCase() === "set-cookie");
            // The store owns the size decision: bodies are Brotli-compressed
            // there, and only ones exceeding the item budget even compressed
            // come back as "too-large".
            const cacheable = response.statusCode < 500
                && !setsCookie
                && typeof response.body === "string"
                && !response.isBodyBase64;
            try {
                if (cacheable) {
                    // Merge during-exec accumulator headers into the stored
                    // copy (same replace/append semantics the render pipeline
                    // applies), so a replay reproduces the full header set.
                    const storedResponse = new LambderResponse({
                        statusCode: response.statusCode,
                        headers: normalizeHeaders(response.headers),
                        body: response.body,
                    });
                    for (const header of execSetHeaders)
                        storedResponse.setHeader(header.key, header.value);
                    for (const header of execAddHeaders)
                        storedResponse.addHeader(header.key, header.value);
                    const completion = await store.complete(scopeKey, ownerToken, {
                        statusCode: response.statusCode,
                        headers: storedResponse.headers,
                        body: response.body,
                        ttlSeconds,
                    });
                    if (completion !== "too-large")
                        return;
                    // Too large to replay: fall through to release the claim
                    // so retries re-execute instead of 409ing.
                }
                await store.abandon(scopeKey, ownerToken);
            }
            catch (storeErr) {
                // A failed complete() must not leave the pending claim
                // dangling (it would 409 retries until the pending TTL).
                try {
                    await store.abandon(scopeKey, ownerToken);
                }
                catch { /* claim expires on its own */ }
                if (!this.failOpen)
                    throw storeErr;
            }
        };
        try {
            const response = await exec();
            await settleClaim(response);
            return response;
        }
        catch (err) {
            // A thrown LambderResponse IS the response (res.die.*, throw
            // res.api(...)): settle the claim like a returned one so its side
            // effect replays, then rethrow so the pipeline emits it.
            if (err instanceof LambderResponse) {
                await settleClaim(err);
                throw err;
            }
            // A real crash (or a thrown refusal like LambderApiError /
            // refuse()) releases the claim so a retry actually retries. This
            // is the deliberate rule: RESPONSES are stored and replayed,
            // refusals delivered as returned envelopes included; EXCEPTIONS
            // are not, so a thrown refusal re-executes on retry and the
            // handler decides afresh. Pick the idiom accordingly.
            try {
                await store.abandon(scopeKey, ownerToken);
            }
            catch (cleanupErr) {
                if (!this.failOpen)
                    throw cleanupErr;
            }
            throw err;
        }
    }
}

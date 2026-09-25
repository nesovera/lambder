import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import { LambderApiRefusal, LAMBDER_REFUSAL_CODES } from "../shared/wire/LambderApiRefusal.js";
import { joinKeyFields } from "../shared/util/joinKeyFields.js";
import { boundKeyField } from "../shared/util/boundKeyField.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
import { canonicalJson } from "../shared/util/canonicalJson.js";
import { sha256HexOf } from "../shared/util/LambderTextDigest.js";
import { crashAnswer } from "./LambderApiEnvelope.js";
import { LambderApiOutputValidationError } from "./LambderApiOutputValidationError.js";
/**
 * A pending claim expires on its own so a crashed original cannot block
 * retries forever. Five minutes covers most handlers, but the claim must
 * outlive its handler: a Lambda may run for fifteen minutes, and a claim that
 * expires mid-run hands the next retry a free scope, so the operation runs
 * twice. Apps with long handlers raise it past their timeout through
 * `idempotency: { pendingTtlSeconds }`, or per API.
 */
const DEFAULT_IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
/**
 * Keys must be unguessable: without a session, the replay scope is the key
 * itself, so a guessable key would let one client read another's stored
 * response. createIdempotencyKey() returns 36 chars.
 */
const IDEMPOTENCY_MIN_KEY_LENGTH = 16;
const IDEMPOTENCY_MAX_KEY_LENGTH = 200;
/**
 * An answer's headers with the map and every value list copied, on the way
 * into a store and on the way out of one. The pipeline applies the CALL's
 * headers into the answer's own map as the call ends, so a custom store that
 * kept the object it was given, or handed back the one it keeps (the
 * interface asks for copies both ways, but nothing enforces it), would store
 * one call's Set-Cookie and replay it to everyone.
 */
const copyAnswerHeaders = (headers) => Object.fromEntries(Object.entries(headers).map(([name, values]) => [name, [...values]]));
/**
 * A stored record as an answer: the three fields, nothing else, and the
 * headers copied (see copyAnswerHeaders). The pipeline applies the replaying
 * call's own headers into the answer's map, so a store that handed back the
 * object it keeps would have this call's Set-Cookie written into its record
 * and replayed to the next caller.
 */
const answerFromRecord = (record) => ({
    statusCode: record.statusCode,
    headers: copyAnswerHeaders(record.headers),
    body: record.body,
});
/**
 * A replay window a store can act on. NaN matters most: it survives every
 * comparison an expiry test makes, so an in-memory record with a NaN expiry
 * outlives every sweep, while DynamoDB rejects the number outright. Zero is
 * refused too, since a record that expires as it is written silently turns
 * replay off for the API that asked for it.
 */
const assertReplayTtl = (subject, ttlSeconds) => {
    if (ttlSeconds === undefined)
        return;
    assertPositiveInteger(ttlSeconds, `${subject} (a replay window in whole seconds)`);
};
/** A per-API replay window, falling back to the configured default. */
const resolveWindowSeconds = (config, field, fallback) => (typeof config === "object" ? config[field] : undefined) ?? fallback;
/**
 * Whether a handler's answer is stored for replays. A 5xx is not: the
 * operation may not have happened, and a retry should try it. Nor is a
 * Set-Cookie (replaying another request's session cookies would be wrong),
 * or a binary body.
 */
const isReplayableAnswer = (answer) => answer.statusCode < 500
    && !answer.isBodyBase64
    && getAnswerHeader(answer.headers, "Set-Cookie") === undefined;
/**
 * The refusal for a key that already belongs to a different request. Without
 * it the second request would get the first one's stored answer: a corrected
 * order (qty 2 after a refused qty 10) would get the stale refusal for a day,
 * and an edited retry after a timeout (qty 4 after a processed qty 3) would
 * get the first order's success though only the first was placed.
 */
const keyReusedRefusal = (apiName) => new LambderApiRefusal(`Idempotency key reused for a different request to "${apiName}".`, {
    statusCode: 409,
    errorMessage: {
        type: "error",
        code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused,
        content: "This request key was already used for a different request. Start the operation again.",
    },
});
/**
 * A request's fingerprint: what makes two requests under one key the same
 * request. The payload as it was posted, as canonical JSON so key order does
 * not matter, digested so a record keeps 64 characters rather than the
 * payload. Guard inputs stay out: a captcha or proof token is single use, so
 * a genuine retry carries a new one, and a fingerprint over it would refuse
 * that retry as another request. A runtime without
 * WebCrypto (the mock on a page served over plain http, a phone on the LAN)
 * keeps the canonical JSON itself: a fingerprint is only compared with ones
 * the same runtime took, so its form does not matter, only that one payload
 * always gives the same one. Either form is non-empty (canonical JSON is at
 * least `null`), which is what lets a store report the empty string for a
 * record it cannot tie to any request.
 */
const requestFingerprintOf = async (payload) => {
    let canonical;
    try {
        canonical = canonicalJson(payload ?? null);
    }
    catch {
        // Sorting the keys recurses once per nesting level, so a payload
        // nested deep enough to exhaust the stack is refused as the caller's
        // error rather than answered as a crash: nothing an app posts nests
        // that deep, and the schema would refuse it a step later anyway.
        const content = "Invalid request payload: nested too deep to fingerprint.";
        throw new LambderApiRefusal(content, {
            statusCode: 400,
            errorMessage: { type: "error", code: LAMBDER_REFUSAL_CODES.invalidRequestPayload, content },
        });
    }
    try {
        return await sha256HexOf(canonical);
    }
    catch {
        return canonical;
    }
};
/**
 * A store failure the engine decided to ignore, said out loud. Failing open
 * is the right default, but silently it looks exactly like working: permanent
 * failures (a missing table, a missing IAM action, an SDK that would not
 * install) could have an app execute every retry twice for months with
 * nothing in its logs. The scope key is left out, since it carries the
 * caller's identity and posted key.
 */
const reportFailOpen = (apiName, attempted, err) => {
    console.error(`Lambder idempotency: "${apiName}" could not ${attempted}; the request is being executed as if it carried no idempotency key. ` +
        "Set idempotency.failOpen: false to refuse instead.", err);
};
/**
 * Runtime side of the idempotency subsystem: claims a per-operation scope
 * around handler execution, replays stored answers, and settles claims.
 * Held by LambderApiPipeline. Works on plain answers, so it runs
 * unchanged under the server and the mock runtime.
 */
export class LambderApiIdempotencyEngine {
    /** Stamped on the crash answer the engine records for an answer that broke its output schema. */
    apiVersion;
    store = null;
    defaultTtlSeconds = 24 * 3600;
    defaultPendingTtlSeconds = DEFAULT_IDEMPOTENCY_PENDING_TTL_SECONDS;
    failOpen = true;
    callerIdentity = undefined;
    constructor(apiVersion) {
        this.apiVersion = apiVersion;
    }
    configure(config) {
        if (this.store)
            throw new Error("Lambder: idempotency was already configured.");
        assertReplayTtl("the idempotency option's defaultTtlSeconds", config.defaultTtlSeconds);
        assertReplayTtl("the idempotency option's defaultPendingTtlSeconds", config.defaultPendingTtlSeconds);
        this.store = config.store;
        this.defaultTtlSeconds = config.defaultTtlSeconds ?? 24 * 3600;
        this.defaultPendingTtlSeconds = config.defaultPendingTtlSeconds ?? DEFAULT_IDEMPOTENCY_PENDING_TTL_SECONDS;
        this.failOpen = config.failOpen ?? true;
        this.callerIdentity = config.callerIdentity;
    }
    /**
     * Puts the engine over another store, for `lambder/testing`; the replay
     * TTLs, failOpen and callerIdentity stay as configured. False when
     * idempotency was never configured.
     */
    [LAMBDER_BACKEND_SWAP](store) {
        if (!this.store)
            return false;
        this.store = store;
        return true;
    }
    /** Startup validation of one API registration's idempotency option. */
    assertRegistration(apiName, config) {
        if (typeof config !== "object")
            return;
        assertReplayTtl(`API "${apiName}" idempotency ttlSeconds`, config.ttlSeconds);
        assertReplayTtl(`API "${apiName}" idempotency pendingTtlSeconds`, config.pendingTtlSeconds);
    }
    /** True once the idempotency option was configured; registration asserts check it. */
    get isConfigured() { return this.store !== null; }
    /**
     * The request's idempotencyKey: null when absent, the key when valid, a
     * 400 refusal when malformed. The minimum length matters for security:
     * see IDEMPOTENCY_MIN_KEY_LENGTH.
     */
    readKey(request) {
        const rawKey = request.idempotencyKey;
        if (rawKey === undefined || rawKey === null)
            return null;
        if (typeof rawKey !== "string" || rawKey.length < IDEMPOTENCY_MIN_KEY_LENGTH || rawKey.length > IDEMPOTENCY_MAX_KEY_LENGTH) {
            const content = `Invalid idempotency key: must be a string of ${IDEMPOTENCY_MIN_KEY_LENGTH}-${IDEMPOTENCY_MAX_KEY_LENGTH} characters.`;
            throw new LambderApiRefusal(content, {
                statusCode: 400,
                errorMessage: { type: "error", code: LAMBDER_REFUSAL_CODES.invalidIdempotencyKey, content },
            });
        }
        return rawKey;
    }
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
    async scopeOf(apiName, ctx, request, key) {
        const sessionKey = ctx.session?.sessionKey;
        if (sessionKey)
            return joinKeyFields(await boundKeyField("s", sessionKey), apiName, key);
        // No session to scope by. The app may still say who this is, through
        // callerIdentity; without one the key alone is the scope, which is
        // what makes it a bearer token for its own answer.
        const identity = this.callerIdentity ? await this.callerIdentity(ctx, request) : null;
        return identity
            ? joinKeyFields(await boundKeyField("i", identity), apiName, key)
            : joinKeyFields("k", apiName, key);
    }
    /**
     * The call's key worked out, once per call: its scope and its request's
     * fingerprint, for findReplay and withIdempotency. Null for a call that
     * sends no key, or when idempotency is not configured; a malformed key
     * refuses with a 400. Taken at the replay lookup, before input validation
     * replaces the payload with its parsed form, so the fingerprint is of the
     * request as it was posted, and callerIdentity (app code that may verify
     * a token or read a store) runs once.
     */
    async resolveKeyedCall(apiName, request, ctx) {
        if (!this.store)
            return null;
        const key = this.readKey(request);
        if (key === null)
            return null;
        return {
            scopeKey: await this.scopeOf(apiName, ctx, request, key),
            fingerprint: await requestFingerprintOf(request.payload),
        };
    }
    /**
     * Replay fast path, run before guards and all rate limits except
     * `per: "ip"`: a completed record returns its stored answer, so a
     * legitimate retry neither burns quota nor re-runs guards (the original
     * passed them, and no handler executes). The IP limits run first because
     * the store read a replay costs is one of the things they bound. Misses
     * fall through to the normal pipeline; store errors follow failOpen.
     */
    async findReplay(apiName, call, trace) {
        const store = this.store;
        if (!store)
            return null;
        let done;
        try {
            done = await store.peek(call.scopeKey);
        }
        catch (err) {
            if (!this.failOpen)
                throw err;
            reportFailOpen(apiName, "look its replay record up", err);
            return null;
        }
        if (!done)
            return null;
        if (done.fingerprint !== call.fingerprint)
            throw keyReusedRefusal(apiName);
        trace.replayed = true;
        return answerFromRecord(done);
    }
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
    async withIdempotency(apiName, { scopeKey, fingerprint }, config, trace, exec) {
        const store = this.store;
        if (!store)
            return await exec();
        const ttlSeconds = resolveWindowSeconds(config, "ttlSeconds", this.defaultTtlSeconds);
        const pendingTtlSeconds = resolveWindowSeconds(config, "pendingTtlSeconds", this.defaultPendingTtlSeconds);
        let begun;
        try {
            begun = await store.begin(scopeKey, { pendingTtlSeconds, fingerprint });
        }
        catch (err) {
            if (!this.failOpen)
                throw err;
            reportFailOpen(apiName, "claim its scope", err);
            return await exec();
        }
        if (begun.state !== "new" && begun.fingerprint !== fingerprint)
            throw keyReusedRefusal(apiName);
        if (begun.state === "pending") {
            throw new LambderApiRefusal(`Duplicate request for "${apiName}": the original is still processing.`, {
                statusCode: 409,
                errorMessage: { type: "warning", code: LAMBDER_REFUSAL_CODES.duplicateInFlight, content: "This request is already being processed." },
            });
        }
        // The other replay path: the original settled between this request's
        // peek and its claim. No handler runs, so it is a replay like any
        // other.
        if (begun.state === "done") {
            trace.replayed = true;
            return answerFromRecord(begun);
        }
        const ownerToken = begun.ownerToken;
        // Store the answer for replays when it qualifies, release the claim
        // otherwise.
        //
        // A settle failure is reported and swallowed, not subject to
        // failOpen: the work is done and the answer is owed to the caller.
        // failOpen governs begin(), where refusing still means not acting.
        // Here it would turn a completed operation into a 500 and hand the
        // retry a released claim, which is the double execution idempotency
        // exists to prevent.
        const settleClaim = async (answer, replayable) => {
            try {
                if (replayable) {
                    // The store owns the size decision: it may compress bodies,
                    // and answers "too-large" only when even that exceeds its
                    // budget.
                    const completion = await store.complete(scopeKey, ownerToken, {
                        statusCode: answer.statusCode,
                        // Copied: see copyAnswerHeaders.
                        headers: copyAnswerHeaders(answer.headers),
                        body: answer.body,
                        fingerprint,
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
                // The failed call may have landed anyway (a complete() whose
                // answer was lost), and abandon() releases only a claim still
                // pending, so one more release settles every case. A
                // complete() that never landed frees the scope, where the
                // pending claim would 409 genuine retries until
                // pendingTtlSeconds ran out; one that landed keeps its record,
                // and the retry replays it rather than running the operation
                // a second time.
                try {
                    await store.abandon(scopeKey, ownerToken);
                }
                catch { /* claim expires on its own */ }
                console.warn(`Lambder idempotency: "${apiName}" ran and answered, but storing its record failed. ` +
                    "The caller keeps this answer; a retry under the same key replays it if the write landed after all, and executes again if it did not.", storeErr);
            }
        };
        try {
            const answer = await exec();
            await settleClaim(answer, isReplayableAnswer(answer));
            return answer;
        }
        catch (err) {
            // The handler ran to its answer, and the answer broke its output
            // schema: whatever the operation wrote or charged is done, so a
            // released claim would run it again on every retry. The
            // framework's crash answer is recorded as the key's answer
            // instead, and a retry is told the same thing.
            if (err instanceof LambderApiOutputValidationError) {
                await settleClaim(crashAnswer(this.apiVersion), true);
                throw err;
            }
            // A crash or a thrown refusal (LambderApiRefusal, refuse())
            // releases the claim so a retry retries. The rule is deliberate:
            // ANSWERS are stored and replayed, returned refusal envelopes
            // included; EXCEPTIONS are not, so a thrown refusal re-executes
            // on retry and the handler decides afresh. (On the server,
            // res.die.api() is an answer: the adapter catches it before it
            // reaches here.) The handler's own error is what gets rethrown,
            // since a cleanup error in its place would hide why the call
            // failed.
            try {
                await store.abandon(scopeKey, ownerToken);
            }
            catch (cleanupErr) {
                console.warn(`Lambder idempotency: releasing the claim for "${apiName}" failed; it expires on its own.`, cleanupErr);
            }
            throw err;
        }
    }
}

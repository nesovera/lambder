import type { LambderApiRequest } from "./LambderApiRequest.js";
import type { LambderApiCallContext, LambderApiCallTrace } from "./LambderApiCallContext.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import type { LambderApiAnswer } from "./LambderApiAnswer.js";
import { LambderApiRefusal, LAMBDER_REFUSAL_CODES, type LambderRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import type { LambderIdempotencyDoneRecord, LambderIdempotencyBeginResult, LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import type { LambderApiIdempotencyOption } from "../shared/wire/LambderApiOptionValues.js";
import { joinKeyFields } from "../shared/util/LambderKeyFields.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";

/**
 * A crashed original must not block retries forever, so a pending claim
 * expires on its own. The default is five minutes, which covers the great
 * majority of handlers.
 *
 * It has to outlive the handler, though, and that is the app's business to
 * know: a Lambda may run for fifteen minutes, and a claim that expires while
 * its own handler is still working hands the next retry a free scope, so the
 * operation runs a second time, which is the one thing idempotency exists to
 * prevent. An app whose handlers can run long should raise it to just past
 * its own timeout through `idempotency: { pendingTtlSeconds }`, or per API.
 */
const DEFAULT_IDEMPOTENCY_PENDING_TTL_SECONDS = 300;
/**
 * Keys must be unguessable: without a session, the replay scope is the key
 * itself, so a guessable key would let one client read another's stored
 * response. LambderCaller.createIdempotencyKey() returns 36 chars.
 */
const IDEMPOTENCY_MIN_KEY_LENGTH = 16;
const IDEMPOTENCY_MAX_KEY_LENGTH = 200;

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

/** A stored record as an answer: the three fields, nothing else. */
const answerFromRecord = (record: LambderIdempotencyDoneRecord): LambderApiAnswer => ({
    statusCode: record.statusCode,
    headers: record.headers,
    body: record.body,
});

/**
 * A replay window a store can act on, checked where the rate limiter checks
 * its own windows. NaN was the one that mattered: it survives every
 * comparison an expiry test makes, so an in-memory record with a NaN expiry
 * outlives every sweep, while DynamoDB rejects the same number outright. Zero
 * is rejected too, because a record that expires the instant it is written
 * silently turns replay off for the API that asked for it.
 */
const assertReplayTtl = (subject: string, ttlSeconds: number | undefined): void => {
    if(ttlSeconds === undefined) return;
    // The shared positive-integer check, with the subject naming the option;
    // the wording "a replay window is a positive whole number of seconds"
    // lived here alone and said the same thing in different words.
    assertPositiveInteger(ttlSeconds, `${subject} (a replay window in whole seconds)`);
};

/** A per-API replay window, falling back to the configured default. Written once: the two windows resolve the same way. */
const resolveWindowSeconds = (config: LambderApiIdempotencyOption, field: "ttlSeconds" | "pendingTtlSeconds", fallback: number): number =>
    (typeof config === "object" ? config[field] : undefined) ?? fallback;

/**
 * Headers the store may keep: the map and every value list copied, so what
 * the engine hands complete() cannot be rewritten afterwards.
 *
 * The pipeline applies the CALL's headers onto the answer on the way out,
 * into the very object handed here. A store that keeps the reference it was
 * given (the interface asks for a copy, and the shipped stores make one, but
 * a custom store is under no compiler's supervision) would have this call's
 * Set-Cookie become part of the stored record and replay to everyone.
 */
const copyAnswerHeaders = (headers: Record<string, string[]>): Record<string, string[]> =>
    Object.fromEntries(Object.entries(headers).map(([name, values]) => [name, [...values]]));

/**
 * A store failure the engine decided to ignore, said out loud. Failing open
 * is the right default (a store outage should not take the app down with it),
 * but it is also indistinguishable from working: the failure class includes
 * permanent ones (a missing table, a missing IAM action, an SDK that would
 * not install), and an app can run for months executing every retry twice
 * with nothing in its logs. The scope key never appears, since it carries the
 * caller's identity and their posted key.
 */
const reportFailOpen = (apiName: string, attempted: string, err: unknown): void => {
    console.error(
        `Lambder idempotency: "${apiName}" could not ${attempted}; the request is being executed as if it carried no idempotency key. ` +
        "Set idempotency.failOpen: false to refuse instead.",
        err,
    );
};

/**
 * Runtime side of the idempotency subsystem: claims a per-operation scope
 * around handler execution, replays stored answers, and settles claims.
 * Composed into LambderApiPolicyEngine. Works on plain answers, so it runs
 * unchanged under the server and the mock runtime.
 */
export class LambderApiIdempotencyEngine {
    private store: LambderIdempotencyStore | null = null;
    private defaultTtlSeconds = 24 * 3600;
    private defaultPendingTtlSeconds = DEFAULT_IDEMPOTENCY_PENDING_TTL_SECONDS;
    private failOpen = true;
    private callerIdentity: LambderApiIdempotencyConfig["callerIdentity"] = undefined;
    /**
     * The scope this call resolved to, keyed by its context, which is the one
     * object per call the engine is handed. A keyed request asks for it
     * twice, at the replay lookup and at the claim, and callerIdentity is app
     * code that may verify a token or read a store: running it twice per
     * request is a cost the app never asked for, and one it cannot see.
     * Entries go when the call's context does.
     */
    private readonly scopeByCall = new WeakMap<LambderApiCallContext, Promise<string>>();

    configure(config: LambderApiIdempotencyConfig): void {
        if(this.store) throw new Error("Lambder: idempotency was already configured.");
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
    [LAMBDER_BACKEND_SWAP](store: LambderIdempotencyStore): boolean {
        if(!this.store) return false;
        this.store = store;
        return true;
    }

    /** Startup validation of one API registration's idempotency option. */
    assertRegistration(apiName: string, config: LambderApiIdempotencyOption): void {
        if(typeof config !== "object") return;
        assertReplayTtl(`API "${apiName}" idempotency ttlSeconds`, config.ttlSeconds);
        assertReplayTtl(`API "${apiName}" idempotency pendingTtlSeconds`, config.pendingTtlSeconds);
    }

    /** True once the idempotency option was configured; registration asserts check it. */
    get isConfigured(): boolean { return this.store !== null; }

    /**
     * The request's idempotencyKey: null when absent, the key when valid, a
     * 400 refusal when malformed. The minimum length matters for security:
     * see IDEMPOTENCY_MIN_KEY_LENGTH.
     */
    private readKey(request: LambderApiRequest): string | null {
        const rawKey = request.idempotencyKey;
        if(rawKey === undefined || rawKey === null) return null;
        if(typeof rawKey !== "string" || rawKey.length < IDEMPOTENCY_MIN_KEY_LENGTH || rawKey.length > IDEMPOTENCY_MAX_KEY_LENGTH){
            const content = `Invalid idempotency key: must be a string of ${IDEMPOTENCY_MIN_KEY_LENGTH}-${IDEMPOTENCY_MAX_KEY_LENGTH} characters.`;
            throw new LambderApiRefusal(content, {
                statusCode: 400,
                errorMessage: { type: "error", code: LAMBDER_REFUSAL_CODES.invalidIdempotencyKey, content } satisfies LambderRefusalMessage,
            });
        }
        return rawKey;
    }

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
    private async scopeOf(apiName: string, ctx: LambderApiCallContext, request: LambderApiRequest, key: string): Promise<string> {
        const cached = this.scopeByCall.get(ctx);
        if(cached) return await cached;
        const computed = this.computeScope(apiName, ctx, request, key);
        this.scopeByCall.set(ctx, computed);
        return await computed;
    }

    private async computeScope(apiName: string, ctx: LambderApiCallContext, request: LambderApiRequest, key: string): Promise<string> {
        const sessionKey = ctx.session?.sessionKey;
        if(sessionKey) return joinKeyFields(`s:${sessionKey}`, apiName, key);
        // No session to scope by. The app may still say who this is, through
        // callerIdentity; without one the key alone is the scope, which is
        // what makes it a bearer token for its own answer.
        const identity = this.callerIdentity ? await this.callerIdentity(ctx, request) : null;
        return identity
            ? joinKeyFields(`i:${identity}`, apiName, key)
            : joinKeyFields("k", apiName, key);
    }

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
    async findReplay(apiName: string, request: LambderApiRequest, ctx: LambderApiCallContext, trace: LambderApiCallTrace): Promise<LambderApiAnswer | null> {
        const store = this.store;
        if(!store) return null;
        const key = this.readKey(request);
        if(key === null) return null;
        try {
            const done = await store.peek(await this.scopeOf(apiName, ctx, request, key));
            if(!done) return null;
            trace.replayed = true;
            return answerFromRecord(done);
        }catch(err){
            if(!this.failOpen) throw err;
            reportFailOpen(apiName, "look its replay record up", err);
            return null;
        }
    }

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
    async withIdempotency(
        apiName: string,
        request: LambderApiRequest,
        ctx: LambderApiCallContext,
        config: LambderApiIdempotencyOption,
        trace: LambderApiCallTrace,
        exec: () => Promise<LambderApiAnswer>,
    ): Promise<LambderApiAnswer> {
        const store = this.store;
        if(!store) return await exec();
        const rawKey = this.readKey(request);
        if(rawKey === null) return await exec();
        const ttlSeconds = resolveWindowSeconds(config, "ttlSeconds", this.defaultTtlSeconds);
        const pendingTtlSeconds = resolveWindowSeconds(config, "pendingTtlSeconds", this.defaultPendingTtlSeconds);
        const scopeKey = await this.scopeOf(apiName, ctx, request, rawKey);

        let begun: LambderIdempotencyBeginResult;
        try {
            begun = await store.begin(scopeKey, { pendingTtlSeconds });
        }catch(err){
            if(!this.failOpen) throw err;
            reportFailOpen(apiName, "claim its scope", err);
            return await exec();
        }
        if(begun.state === "pending"){
            throw new LambderApiRefusal(`Duplicate request for "${apiName}": the original is still processing.`, {
                statusCode: 409,
                errorMessage: { type: "warning", code: LAMBDER_REFUSAL_CODES.duplicateInFlight, content: "This request is already being processed." } satisfies LambderRefusalMessage,
            });
        }
        // The other replay path: the original settled between this request's
        // peek and its claim, which is the race the "done" answer exists for.
        // No handler runs here either, so it is a replay like any other.
        if(begun.state === "done"){
            trace.replayed = true;
            return answerFromRecord(begun);
        }
        const ownerToken = begun.ownerToken;

        // Store the answer for replays when it qualifies, release the claim
        // otherwise. A Set-Cookie makes an answer uncacheable (replaying
        // another request's cookies, e.g. session tokens, would be wrong), and
        // so does a binary body.
        //
        // Settling happens after the handler has already run, so a store
        // failure here can no longer prevent anything: the work is done and
        // the answer is owed to the caller. failOpen governs the decision
        // BEFORE execution, at begin(), where refusing still means refusing to
        // act. Applying it here would turn a completed operation into a 500
        // and hand the retry a released claim, which is exactly the double
        // execution idempotency exists to prevent, so a settle failure is
        // reported and swallowed.
        const settleClaim = async (answer: LambderApiAnswer) => {
            const cacheable = answer.statusCode < 500
                && !answer.isBodyBase64
                && getAnswerHeader(answer.headers, "Set-Cookie") === undefined;
            try {
                if(cacheable){
                    // The store owns the size decision: bodies may be compressed
                    // there, and only ones exceeding its budget even compressed
                    // come back as "too-large".
                    const completion = await store.complete(scopeKey, ownerToken, {
                        statusCode: answer.statusCode,
                        // Copied, not handed over: the pipeline is about to
                        // apply this call's own headers into answer.headers,
                        // and a store that kept the reference would have them
                        // in the record.
                        headers: copyAnswerHeaders(answer.headers),
                        body: answer.body,
                        ttlSeconds,
                    });
                    if(completion !== "too-large") return;
                    // Too large to replay: fall through to release the claim
                    // so retries re-execute instead of 409ing.
                }
                await store.abandon(scopeKey, ownerToken);
            }catch(storeErr){
                // Two cases, one release. A complete() that never landed must
                // not leave the pending claim dangling: it would 409 the
                // caller's genuine retries until the pending TTL runs out. A
                // complete() whose write DID land and then timed out is
                // released too, so the record stops replaying and a retry
                // re-executes rather than replaying. That is the safe
                // direction of the two: the work has already been done once
                // and its answer is with the caller, so a retry that runs
                // again costs an execution, while a claim nobody can clear is
                // a caller who cannot get through at all.
                try { await store.abandon(scopeKey, ownerToken); } catch { /* claim expires on its own */ }
                console.warn(
                    `Lambder idempotency: "${apiName}" ran and answered, but its record could not be stored. ` +
                    "The caller keeps this answer; a retry under the same key will execute again.",
                    storeErr,
                );
            }
        };

        try {
            const answer = await exec();
            await settleClaim(answer);
            return answer;
        }catch(err){
            // A real crash, or a thrown refusal (LambderApiRefusal, refuse()),
            // releases the claim so a retry actually retries. This is the
            // deliberate rule: ANSWERS are stored and replayed, refusals
            // delivered as returned envelopes included; EXCEPTIONS are not, so
            // a thrown refusal re-executes on retry and the handler decides
            // afresh. Pick the idiom accordingly. (On the server, a response
            // delivered by throwing, res.die.api(), is an answer: the adapter
            // catches it before it reaches here.)
            // Whatever happens to the claim, the handler's own failure is the
            // one worth reporting: replacing it with a cleanup error would
            // hide the reason the call failed.
            try { await store.abandon(scopeKey, ownerToken); }
            catch(cleanupErr){ console.warn(`Lambder idempotency: releasing the claim for "${apiName}" failed; it expires on its own.`, cleanupErr); }
            throw err;
        }
    }
}

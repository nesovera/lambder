import Cookies from 'js-cookie';
import { compressPayloadGzip, isRequestCompressionAvailable, resolveRequestCompressionMinBytes, DEFAULT_REQUEST_COMPRESSION_SETTINGS, } from '../shared/wire/LambderRequestPayload.js';
import { resolveCompressionOption } from '../shared/wire/LambderCompressionOption.js';
import { resolveApiOutcome } from '../shared/wire/LambderApiOutcome.js';
import { mergeGuardInputs, } from '../shared/wire/LambderCallOptions.js';
import { createCallAbort } from '../shared/util/LambderCallAbort.js';
import { coerceToError } from '../shared/wire/LambderCrashDetail.js';
import { isLambderTransportFailure } from '../shared/transport/LambderApiTransport.js';
import { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from '../shared/wire/LambderSessionCookieNames.js';
import { lambderFetchTransport } from './lambderFetchTransport.js';
/**
 * @typeParam TContract - The API contract, for typed names, payloads and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderCaller {
    isCorsEnabled;
    apiPath;
    apiVersion;
    timeoutMs;
    /** The calls currently in flight, in the order they started. */
    fetchTrackerList = [];
    /** Whether any call is in flight. Derived, so it cannot drift from the list the way a separate flag did. */
    get isLoading() { return this.fetchTrackerList.length > 0; }
    versionExpiredHandler;
    sessionExpiredHandler;
    messageHandler;
    errorMessageHandler;
    notAuthorizedHandler;
    errorHandler;
    apiInputValidationErrorHandler;
    logListHandler;
    fetchStartedHandler;
    fetchEndedHandler;
    guardInputsProvider;
    sessionTokenCookieKey = DEFAULT_SESSION_TOKEN_COOKIE_KEY;
    sessionCsrfCookieKey = DEFAULT_SESSION_CSRF_COOKIE_KEY;
    sessionCookieDomain;
    requestCompression;
    transport;
    constructor(options) {
        // The conditional provider option is resolved per instantiation;
        // inside the class it is read through the plain shape.
        const { apiPath, apiVersion, isCorsEnabled, timeoutMs, versionExpiredHandler, sessionExpiredHandler, messageHandler, errorMessageHandler, notAuthorizedHandler, errorHandler, logListHandler, fetchStartedHandler, fetchEndedHandler, apiInputValidationErrorHandler, sessionCookieDomain, requestCompression, guardInputsProvider, transport, } = options;
        this.apiPath = apiPath;
        this.apiVersion = apiVersion;
        this.isCorsEnabled = isCorsEnabled;
        this.timeoutMs = timeoutMs;
        this.sessionCookieDomain = sessionCookieDomain;
        // `?? false`: unlike the at-rest stores, this one is off unless asked for.
        this.requestCompression = resolveCompressionOption(requestCompression ?? false, DEFAULT_REQUEST_COMPRESSION_SETTINGS);
        this.transport = transport ?? lambderFetchTransport({ cors: this.isCorsEnabled });
        this.versionExpiredHandler = versionExpiredHandler;
        this.sessionExpiredHandler = sessionExpiredHandler;
        this.messageHandler = messageHandler;
        this.errorMessageHandler = errorMessageHandler;
        this.notAuthorizedHandler = notAuthorizedHandler;
        this.errorHandler = errorHandler;
        this.apiInputValidationErrorHandler = apiInputValidationErrorHandler;
        this.logListHandler = logListHandler;
        this.fetchStartedHandler = fetchStartedHandler;
        this.fetchEndedHandler = fetchEndedHandler;
        this.guardInputsProvider = guardInputsProvider;
    }
    ;
    setSessionCookieKey(sessionTokenCookieKey, sessionCsrfCookieKey) {
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
    }
    /** Replaces how calls reach the server: a mock runtime, an in-process handler, a decorated transport. */
    setTransport(transport) {
        this.transport = transport;
        return this;
    }
    /**
     * A self-rotating idempotency key for a component or form that performs
     * the same logical operation repeatedly. `current` is the key for the
     * operation in progress: send it with every attempt (first try, retry
     * after a failure, double-tap) so the server collapses them. Call
     * `rotate()` after a confirmed success so the next operation is a new
     * intent with its own key.
     *
     * ```typescript
     * const submitKey = LambderCaller.createIdempotencyKeyScope();
     * await caller.api("order.create", payload, { idempotencyKey: submitKey.current });
     * submitKey.rotate();
     * ```
     */
    static createIdempotencyKeyScope() {
        let key = LambderCaller.createIdempotencyKey();
        return {
            get current() { return key; },
            rotate() { key = LambderCaller.createIdempotencyKey(); return key; },
        };
    }
    /**
     * Generate an idempotency key for one logical operation. Create it when
     * the operation begins (a form opens, a draft starts), send the same key
     * on every attempt of that operation, and generate a new one after a
     * confirmed success. Uses crypto.randomUUID when available and falls back
     * to a v4 UUID from getRandomValues, because randomUUID only exists in
     * secure contexts (plain-http LAN device testing lacks it).
     *
     * A runtime with neither throws rather than reaching for Math.random: the
     * key must be UNGUESSABLE, since it is what scopes the replay record for a
     * logged-out client, and a guessable one hands that client's stored
     * response to whoever guesses it.
     */
    static createIdempotencyKey() {
        const cryptoObj = globalThis.crypto;
        if (cryptoObj?.randomUUID)
            return cryptoObj.randomUUID();
        if (!cryptoObj?.getRandomValues)
            throw new Error("LambderCaller.createIdempotencyKey needs crypto.getRandomValues: an idempotency key must be unguessable, and this runtime offers no random source that is.");
        const bytes = new Uint8Array(16);
        cryptoObj.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    clearSessionCookies() {
        const domainOption = this.sessionCookieDomain;
        const hostname = globalThis.location?.hostname ?? "";
        const resolvedDomain = typeof domainOption === "function" ? domainOption(hostname) : domainOption;
        for (const key of [this.sessionTokenCookieKey, this.sessionCsrfCookieKey]) {
            // Host-only and domain-scoped cookies are distinct entries; clear both.
            // Only the CSRF cookie is reachable from here: the token cookie is
            // HttpOnly, so its removal is the server's (a Set-Cookie on the
            // session-expired or logout response).
            Cookies.remove(key);
            if (resolvedDomain)
                Cookies.remove(key, { domain: resolvedDomain, path: "/" });
        }
    }
    /** One call, one outcome. Never throws; every failure path resolves to { ok: false }. */
    async dispatch(apiName, payload, options) {
        // Per-call overrides win over the constructor handlers.
        const versionExpiredHandler = options?.versionExpiredHandler ?? this.versionExpiredHandler;
        const sessionExpiredHandler = options?.sessionExpiredHandler ?? this.sessionExpiredHandler;
        const messageHandler = options?.messageHandler ?? this.messageHandler;
        const errorMessageHandler = options?.errorMessageHandler ?? this.errorMessageHandler;
        const notAuthorizedHandler = options?.notAuthorizedHandler ?? this.notAuthorizedHandler;
        const errorHandler = options?.errorHandler ?? this.errorHandler;
        const apiInputValidationErrorHandler = options?.apiInputValidationErrorHandler ?? this.apiInputValidationErrorHandler;
        const logListHandler = options?.logListHandler ?? this.logListHandler;
        const fetchStartedHandler = options?.fetchStartedHandler ?? this.fetchStartedHandler;
        const fetchEndedHandler = options?.fetchEndedHandler ?? this.fetchEndedHandler;
        const headers = options?.headers;
        const fetchTracker = { apiName };
        // Dropped the moment the call settles, and idempotently, since the
        // finally block below runs for the paths fetchEnded never reaches.
        // Left in, the list grew by one per call forever, and every handler
        // call scanned all of it: a long-lived page paid more per call the
        // longer it had been open.
        const dropFetchTracker = () => {
            const at = this.fetchTrackerList.indexOf(fetchTracker);
            if (at !== -1)
                this.fetchTrackerList.splice(at, 1);
        };
        let fetchEndCalled = false;
        const fetchEnded = async (fetchResult) => {
            dropFetchTracker();
            if (fetchEndCalled || !fetchEndedHandler)
                return;
            fetchEndCalled = true;
            await fetchEndedHandler({
                fetchParams: { apiName, payload, headers },
                fetchResult,
                activeFetchList: [...this.fetchTrackerList],
            });
        };
        let errorHandlerCalled = false;
        const reportError = async (err) => {
            if (errorHandlerCalled || !errorHandler)
                return;
            errorHandlerCalled = true;
            await errorHandler(err);
        };
        // Timeout and abort wiring, shared with LambderInvokeCaller so the two
        // cannot drift on what a late or abandoned call means.
        const abort = createCallAbort({ timeoutMs: options?.timeoutMs ?? this.timeoutMs, signal: options?.signal });
        const signal = abort.signal;
        /** Reports a call that was given up on, or null while it still stands. */
        const abandonedOutcome = async (stage) => {
            const failure = abort.abortFailure(stage);
            if (!failure)
                return null;
            await fetchEnded(failure.error);
            await reportError(failure.error);
            const outcome = { ok: false, reason: failure.reason, error: failure.error };
            return outcome;
        };
        try {
            this.fetchTrackerList.push(fetchTracker);
            if (fetchStartedHandler)
                await fetchStartedHandler({
                    fetchParams: { apiName, payload, headers, },
                    activeFetchList: [...this.fetchTrackerList],
                });
            const version = this.apiVersion;
            // js-cookie reads nothing without a document, and there is no
            // location outside a page: both are "" then, and a transport that
            // carries a cookie jar fills the token in from it.
            const token = Cookies.get(this.sessionCsrfCookieKey) || "";
            const siteHost = globalThis.location?.hostname ?? "";
            // Provider values underneath, per-call values on top.
            const providedGuardInputs = this.guardInputsProvider
                ? await this.guardInputsProvider(apiName)
                : undefined;
            const guardInputs = mergeGuardInputs(providedGuardInputs, options?.guardInputs);
            // Compressed when enabled and the payload's JSON reaches the
            // threshold; `compressRequest` overrides both ways, and a runtime
            // without CompressionStream always sends the payload plainly.
            // Nothing here runs (the extra stringify included) unless
            // compression is actually a possibility for this call.
            const compressionMinBytes = resolveRequestCompressionMinBytes(options?.compressRequest, this.requestCompression);
            const compressedPayload = compressionMinBytes !== null && payload !== undefined && isRequestCompressionAvailable()
                ? await compressPayloadGzip(JSON.stringify(payload), compressionMinBytes)
                : null;
            // A call the site has already given up on does not reach the
            // transport at all: honouring request.signal is the transport's
            // obligation, and not every transport does.
            const refused = await abandonedOutcome("beforeSending");
            if (refused)
                return refused;
            let answer;
            try {
                answer = await this.transport({
                    apiPath: this.apiPath,
                    apiName, version, token, siteHost,
                    csrfCookieKey: this.sessionCsrfCookieKey,
                    ...(compressedPayload ? { compressed: compressedPayload } : { payload }),
                    ...(guardInputs !== undefined ? { guardInputs } : {}),
                    ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
                    ...(headers ? { headers } : {}),
                    ...(signal ? { signal } : {}),
                });
            }
            catch (err) {
                const wrappedError = coerceToError(err, "Request failed");
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
                // The caller's own abort wins, since only it knows about that.
                // Otherwise a transport that named its reason is believed:
                // "protocol" means something came back and was not an answer,
                // which is what this caller already calls `server`.
                const reason = abort.timedOut() ? 'timeout'
                    : isLambderTransportFailure(err) && err.reason === 'protocol' ? 'server'
                        : 'network';
                return { ok: false, reason, error: wrappedError };
            }
            // An answer that arrives after the call was given up on is not a
            // success. A transport that ignores request.signal resolves late,
            // and believing it would report ok on a 20ms timeoutMs 300ms in,
            // handing the call site data it had already abandoned.
            const late = await abandonedOutcome("afterAnswering");
            if (late)
                return late;
            // The reading of the answer is shared with LambderInvokeCaller;
            // only what to do about each outcome is this caller's.
            const outcome = await resolveApiOutcome(answer);
            // Every answer's logs, surfaced once and before any branch that
            // returns: the 500 whose global error handler attached a crash and
            // a logList is the answer whose log trail is worth the most, and
            // surfacing them under the envelope reads meant it was the one
            // answer that never reached logListHandler at all.
            const logList = outcome.logList;
            if (logList?.length) {
                if (logListHandler)
                    await logListHandler(apiName, logList);
                else
                    for (const record of logList)
                        console.log("[lambder]", record);
            }
            if (!outcome.ok && outcome.reason === 'server') {
                await fetchEnded(outcome.error);
                await reportError(outcome.error);
                return outcome;
            }
            if (!outcome.ok && outcome.reason === 'validation') {
                await fetchEnded(null);
                if (apiInputValidationErrorHandler) {
                    await apiInputValidationErrorHandler(outcome.zodError);
                }
                else {
                    await reportError(new Error("API Input Validation Error", { cause: outcome.zodError }));
                }
                return outcome;
            }
            // Whatever is left carries the envelope: a success or one of the
            // envelope's own refusals, which is why no assertion is needed.
            const data = outcome.response;
            await fetchEnded(data);
            if (!outcome.ok && outcome.reason === 'versionExpired') {
                if (versionExpiredHandler) {
                    await versionExpiredHandler();
                }
                else {
                    await reportError(new Error("Version Expired; Please refresh;"));
                }
                return outcome;
            }
            if (!outcome.ok && outcome.reason === 'sessionExpired') {
                this.clearSessionCookies();
                if (sessionExpiredHandler) {
                    await sessionExpiredHandler();
                }
                else {
                    await reportError(new Error("Session Expired; Please log in again;"));
                }
                return outcome;
            }
            if (!outcome.ok && outcome.reason === 'notAuthorized') {
                if (notAuthorizedHandler) {
                    await notAuthorizedHandler();
                }
                else {
                    await reportError(new Error("Not Authorized;"));
                }
                return outcome;
            }
            // Presence, not truthiness: the envelope keeps a message an app
            // spelled out as the empty string, so the handler runs for it.
            if (data.message !== undefined && messageHandler) {
                await messageHandler(data.message);
            }
            if (!outcome.ok && outcome.reason === 'errorMessage') {
                if (errorMessageHandler && data.errorMessage !== undefined) {
                    await errorMessageHandler(data.errorMessage);
                }
                return outcome;
            }
            return outcome;
        }
        catch (err) {
            // Escape hatch for anything above (typically an app handler throwing):
            // dispatch never throws, so api()/apiOutcome() call sites never do.
            const wrappedError = coerceToError(err, "The call failed before it produced an outcome");
            try {
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
            }
            catch { /* an app handler threw again; never propagate */ }
            return { ok: false, reason: 'unknown', error: wrappedError };
        }
        finally {
            dropFetchTracker();
            abort.detach();
        }
    }
    ;
    /**
     * Full-fidelity call: resolves to a discriminated LambderApiOutcome
     * instead of collapsing every failure to undefined. Never throws.
     *
     * The output is computed from the contract in the return type rather than
     * taken as a type parameter, so a call site cannot replace it by
     * annotating what it assigns to.
     */
    async apiOutcome(apiName, ...rest) {
        // The tuple is a conditional type on an unresolved TApiName, so its
        // elements read as unknown from inside; the contract shaped them on
        // the way in, which is where the guarantee belongs.
        const [payload, options] = rest;
        return await this.dispatch(apiName, payload, options);
    }
    ;
    /**
     * The payload on success, `undefined` on every failure except a
     * structured refusal, which hands back whatever payload the envelope
     * carried (usually null). Neither is distinguishable from a legitimately
     * null or undefined payload: use apiOutcome() when that matters.
     */
    async api(apiName, ...rest) {
        const [payload, options] = rest;
        const outcome = await this.dispatch(apiName, payload, options);
        if (outcome.ok)
            return outcome.payload;
        return outcome.reason === 'errorMessage' ? outcome.response.payload : undefined;
    }
}

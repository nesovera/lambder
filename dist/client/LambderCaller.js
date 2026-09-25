import Cookies from 'js-cookie';
import { compressPayloadGzip, isRequestCompressionAvailable, resolveRequestCompressionMinBytes, DEFAULT_REQUEST_COMPRESSION_SETTINGS, } from '../shared/wire/LambderRequestPayload.js';
import { resolveCompressionOption } from '../shared/wire/LambderCompressionOption.js';
import { resolveApiOutcome } from '../shared/wire/LambderApiOutcome.js';
import { mergeGuardInputs, } from '../shared/wire/LambderCallOptions.js';
import { beginIdempotentAttempt, IDEMPOTENT_ATTEMPT_NOT_SENT } from '../shared/wire/LambderIdempotencyKeyScope.js';
import { createCallAbort } from '../shared/util/LambderCallAbort.js';
import { coerceToError } from '../shared/wire/LambderCrashDetail.js';
import { isLambderTransportFailure } from '../shared/transport/LambderApiTransport.js';
import { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from '../shared/wire/LambderSessionCookieNames.js';
import { readApiSignature } from '../shared/wire/LambderApiSignature.js';
import { LambderReloadLoopBreaker, RELOAD_LOOP_WINDOW_MS } from './LambderReloadLoopBreaker.js';
import { lambderFetchTransport } from './lambderFetchTransport.js';
/**
 * What keeps a stale bundle from reloading itself forever (see the class):
 * one for the page, shared by every caller it builds, since a reload is the
 * page's. Held per caller, two callers would each run an ask of their own at
 * the same time.
 */
const pageReloadLoopBreaker = new LambderReloadLoopBreaker();
/**
 * @typeParam TContract - The API contract, for typed names, payloads and guard inputs.
 * @typeParam TProvidedGuards - Guard names guardInputsProvider covers; those APIs' options argument becomes optional.
 */
export default class LambderCaller {
    apiPath;
    apiVersion;
    apiSignatures;
    timeoutMs;
    /** The calls currently in flight, in the order they started. */
    fetchTrackerList = [];
    /** Whether any call is in flight. Derived from the list, so the two cannot drift apart. */
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
        const { apiPath, apiVersion, apiSignatures, isCorsEnabled, timeoutMs, versionExpiredHandler, sessionExpiredHandler, messageHandler, errorMessageHandler, notAuthorizedHandler, errorHandler, logListHandler, fetchStartedHandler, fetchEndedHandler, apiInputValidationErrorHandler, sessionCookieDomain, requestCompression, guardInputsProvider, transport, } = options;
        this.apiPath = apiPath;
        this.apiVersion = apiVersion;
        this.apiSignatures = apiSignatures;
        this.timeoutMs = timeoutMs;
        this.sessionCookieDomain = sessionCookieDomain;
        // `?? false`: unlike the at-rest stores, this one is off unless asked for.
        this.requestCompression = resolveCompressionOption(requestCompression ?? false, DEFAULT_REQUEST_COMPRESSION_SETTINGS);
        this.transport = transport ?? lambderFetchTransport({ cors: isCorsEnabled });
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
        // A key scope sends its current key and is told how the attempt
        // ended, before any handler runs: a handler that throws must not
        // leave an unanswered attempt untold. A plain key is sent as it is.
        const idempotentAttempt = beginIdempotentAttempt(options?.idempotencyKey);
        const idempotencyKey = idempotentAttempt.key;
        let sent = false;
        // Dropped the moment the call settles, idempotently, since the finally
        // block below also runs it for the paths fetchEnded never reaches. A
        // tracker left in would grow the list by one per call, and every
        // handler call copies the list, so a long-lived page would pay more
        // per call the longer it stayed open.
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
            idempotentAttempt.settle(stage === "beforeSending" ? IDEMPOTENT_ATTEMPT_NOT_SENT : { ok: false, reason: failure.reason });
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
            // The server's signature for this endpoint, when this build
            // carries the map. A name the map lacks fails the call here, as a
            // provider that threw would: the map predates the endpoint.
            const signature = this.apiSignatures ? await readApiSignature(this.apiSignatures, apiName) : undefined;
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
            // Read last, right before the send: the browser attaches the
            // cookies as the request leaves, and a rotation answered while a
            // provider above was awaited would otherwise pair the new session
            // cookie with the old token. js-cookie reads nothing without a
            // document: the token is "" then, and a transport that carries a
            // cookie jar fills it in from there.
            const token = Cookies.get(this.sessionCsrfCookieKey) || "";
            let answer;
            try {
                sent = true;
                answer = await this.transport({
                    apiPath: this.apiPath,
                    apiName, version, token, siteHost,
                    ...(signature !== undefined ? { signature } : {}),
                    csrfCookieKey: this.sessionCsrfCookieKey,
                    ...(compressedPayload ? { compressed: compressedPayload } : { payload }),
                    ...(guardInputs !== undefined ? { guardInputs } : {}),
                    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
                    ...(headers ? { headers } : {}),
                    ...(signal ? { signal } : {}),
                });
            }
            catch (err) {
                const wrappedError = coerceToError(err, "Request failed");
                // The caller's own abort wins, since only it knows about that.
                // Otherwise a transport that named its reason is believed:
                // "protocol" means something came back and was not an answer,
                // which is what this caller already calls `server`.
                const reason = abort.timedOut() ? 'timeout'
                    : isLambderTransportFailure(err) && err.reason === 'protocol' ? 'server'
                        : 'network';
                idempotentAttempt.settle({ ok: false, reason });
                await fetchEnded(wrappedError);
                await reportError(wrappedError);
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
            idempotentAttempt.settle(outcome);
            // Every answer's logs, surfaced once and before any branch that
            // returns: a 500 whose global error handler attached a crash and a
            // logList has the log trail worth the most, and it returns early
            // on the `server` branch below.
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
                // A page asks for one reload at a time, however many of its
                // calls are refused. A call refused again after a reload
                // means it brought the same bundle back, and reloading again
                // would loop: the failure is reported instead of calling the
                // handler. The outcome says versionExpired either way.
                const decision = pageReloadLoopBreaker.recordVersionExpired(apiName, signature ?? "", version ?? "");
                if (decision === "alreadyAsked")
                    return outcome;
                if (decision === "loopConfirmed") {
                    await reportError(new Error(`Version expired again for API "${apiName}" within ${RELOAD_LOOP_WINDOW_MS / 60000} minutes of a reload: the bundle being served is still the stale one, so versionExpiredHandler was not called again.`));
                    return outcome;
                }
                await pageReloadLoopBreaker.runReloadAsk(async () => {
                    if (versionExpiredHandler) {
                        await versionExpiredHandler();
                    }
                    else {
                        await reportError(new Error("Version Expired; Please refresh;"));
                    }
                });
                return outcome;
            }
            if (!outcome.ok && outcome.reason === 'sessionExpired') {
                // Only when the session this answer is about is still the one
                // the page holds. A call sent before a login or a rotation (a
                // poll, another tab) can answer sessionExpired after it, and
                // acting on it would delete the CSRF cookie the login just set
                // and sign the person out again. A stale answer is returned
                // with nothing touched. A cookie that is gone is no newer
                // session: the server clears both cookies when it refuses an
                // ambiguous pair, and a logout in another tab clears it too.
                // A transport that keeps its own cookies (a jar) names the
                // token it posted and the one it holds, since the page's
                // cookie is not where that session lives.
                const postedToken = answer.csrfTokens?.posted ?? token;
                const heldToken = answer.csrfTokens ? answer.csrfTokens.held() : Cookies.get(this.sessionCsrfCookieKey) || "";
                if (heldToken !== "" && heldToken !== postedToken)
                    return outcome;
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
                if (errorMessageHandler && outcome.errorMessage !== undefined) {
                    await errorMessageHandler(outcome.errorMessage);
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
            // Whatever ended the call before its attempt was told (a provider
            // or a handler that threw): nothing sent tried nothing, and a
            // request that left may have run.
            idempotentAttempt.settle(sent ? { ok: false, reason: 'unknown' } : IDEMPOTENT_ATTEMPT_NOT_SENT);
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

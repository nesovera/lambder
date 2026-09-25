import type { LambderApiHttpAnswer } from "../wire/LambderApiOutcome.js";
import type { LambderCompressedGzipPayload, LambderCompressedBrotliPayload } from "../wire/LambderRequestPayload.js";
/**
 * What LambderCaller hands its transport: the envelope fields of one call
 * plus what a transport may need beside them. Cookies and the client IP are
 * for transports that build the request themselves (in-process, mock); the
 * browser's fetch attaches its own cookies and ignores both.
 */
export type LambderApiTransportRequest = {
    apiPath: string;
    apiName: string;
    version?: string;
    /** The caller's signature for this endpoint, out of its LambderApiSignatureMap; absent when it carries no map. */
    signature?: string;
    /** The CSRF token the caller read from its cookie; "" when it holds none. */
    token: string;
    /**
     * The cookie name the caller reads that token from. A transport that
     * fills the token in itself (the cookie-jar decorator, with no document
     * to read) needs the same name; taking it from the caller keeps the two
     * from being configured apart.
     */
    csrfCookieKey?: string;
    siteHost: string;
    /** The payload, when it goes plainly. */
    payload?: unknown;
    /** The compressed pair, when it goes compressed instead of `payload`. */
    compressed?: LambderCompressedGzipPayload | LambderCompressedBrotliPayload;
    guardInputs?: Record<string, unknown>;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    /** Cookie header pairs, `name=value`. */
    cookies?: string[];
    clientIp?: string;
    signal?: AbortSignal;
};
/**
 * Why a transport could not deliver a call. `network` is the default reading
 * of a rejection: nothing came back. `protocol` means the call reached the
 * callee but produced no answer (what came back was not one, or the callee
 * threw): a server or wiring fault, not to be reported as flaky
 * connectivity. `timeout` belongs to the caller, which knows whether its own
 * abort fired.
 */
export type LambderTransportFailureReason = "network" | "protocol";
/**
 * A transport saying why it failed, instead of leaving the caller to assume.
 * Thrown by a transport; the caller reads `reason` and keeps `cause`, so the
 * thing that actually went wrong survives the trip.
 */
export declare class LambderTransportFailure extends Error {
    readonly isLambderTransportFailure: true;
    readonly reason: LambderTransportFailureReason;
    constructor(reason: LambderTransportFailureReason, message: string, options?: {
        cause?: unknown;
    });
}
/** Brand-based type guard, so a duplicate install of the package still matches. */
export declare const isLambderTransportFailure: (err: unknown) => err is LambderTransportFailure;
/**
 * Delivers one call and hands back the answer in the accessor form
 * resolveApiOutcome() reads. What a transport owes its caller:
 *
 * - **Any HTTP status is an answer.** A 4xx or 5xx resolves, status and body
 *   included, because resolveApiOutcome() is the one place that reads what a
 *   status means. Rejecting on a status would throw away the envelope a
 *   refusal, a validation failure or a crash arrived in.
 * - **A rejection is a transport failure.** The caller reports it as
 *   `network`, as `timeout` when its own abort fired, or as the reason a
 *   thrown LambderTransportFailure names. That failure's `cause` carries the
 *   real error through to the caller's `outcome.error`.
 * - **`request.signal` must be honoured**, by rejecting as soon as it aborts.
 *   Without that, the caller's `timeoutMs` and per-call `signal` mean
 *   nothing and a call waits as long as the callee takes. Work already begun
 *   need not be cancellable (an in-process handler is not); the obligation
 *   is to stop waiting, not to stop the callee.
 * - **Timeouts and retries belong to the caller.** A transport starts no
 *   clock of its own and retries nothing, so one call is one delivery
 *   attempt and an idempotency key means what it says.
 * - **A transport that keeps the session's cookies itself reports its CSRF
 *   tokens** on the answer (`csrfTokens`), the one it posted and a read of the
 *   one it holds, since the caller otherwise judges a sessionExpired by
 *   document.cookie, which such a transport never writes.
 *
 * Four transports ship: fetch (lambderFetchTransport, the browser default),
 * an in-process Lambder handler (lambderHandlerTransport, for tests), the
 * mock runtime (LambderMockApp.transport), and a cookie-jar decorator over
 * any of them (lambderCookieJarTransport).
 */
export type LambderApiTransport = (request: LambderApiTransportRequest) => Promise<LambderApiHttpAnswer>;
/**
 * The fields of the request envelope, in wire order: the one statement of
 * what a call sends, for every sender.
 *
 * Two senders write it. A transport hands the payload over as a value
 * (buildTransportEnvelope, below); LambderInvokeCaller has already serialized
 * its payload to decide on compression, and splices that JSON onto the end
 * rather than parsing and stringifying it again (buildEnvelopeJson, in
 * invoke/LambderLambdaEvent.ts). The splice builds on this function so a new
 * envelope field cannot reach one sender and miss the other, which nothing on
 * the wire would catch.
 */
export declare const buildEnvelopeFields: (fields: {
    apiName: string;
    version?: string;
    signature?: string;
    /** The CSRF token, as the envelope names it. */
    token: string;
    siteHost: string;
    /**
     * The plain payload's slot: `{ payload }` from a sender holding the value,
     * and nothing from one that splices its own JSON in afterwards. A
     * compressed payload replaces it.
     */
    payloadSlot?: {
        payload: unknown;
    };
    compressed?: LambderCompressedGzipPayload | LambderCompressedBrotliPayload | null;
    guardInputs?: Record<string, unknown>;
    idempotencyKey?: string;
}) => Record<string, unknown>;
/**
 * The body envelope every transport posts, as a plain object: the same
 * fields whichever transport carries them, so the server and the mock
 * runtime read one shape.
 */
export declare const buildTransportEnvelope: (request: LambderApiTransportRequest) => Record<string, unknown>;
/**
 * Where a call is actually going, read off its apiPath: an absolute one names
 * the host and the scheme the request reaches, a relative one only its path.
 * Both the cookie-jar decorator (a cookie's scope is the host and path of the
 * request, not of the page) and the in-process handler transport (whose event
 * needs a path, not a URL, or no route matches) split it this way.
 */
type LambderApiPathTarget = {
    host?: string;
    path: string;
    /** Whether the target speaks https; undefined when the apiPath names no scheme. */
    secure?: boolean;
};
export declare const resolveApiPathTarget: (apiPath: string) => LambderApiPathTarget;
export {};

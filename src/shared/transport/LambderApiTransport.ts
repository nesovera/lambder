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
    /** The CSRF token the caller read from its cookie; "" when it holds none. */
    token: string;
    /**
     * The cookie name the caller reads that token from. A transport that
     * fills the token in itself (the cookie-jar decorator, where there is no
     * document to read) needs the same name, and taking it from the caller is
     * what keeps the two from being configured apart.
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
 * of a rejection: nothing came back. `protocol` says the call reached the
 * callee and no answer came of it, either because what came back was not one
 * or because the callee threw instead of answering, which is a server or
 * wiring fault and should not be reported to a developer as flaky
 * connectivity. `timeout` belongs to the caller, which knows whether its own
 * abort fired.
 */
export type LambderTransportFailureReason = "network" | "protocol";

/**
 * A transport saying why it failed, instead of leaving the caller to assume.
 * Thrown by a transport; the caller reads `reason` and keeps `cause`, so the
 * thing that actually went wrong survives the trip.
 */
export class LambderTransportFailure extends Error {
    readonly isLambderTransportFailure = true as const;
    readonly reason: LambderTransportFailureReason;

    constructor(reason: LambderTransportFailureReason, message: string, options: { cause?: unknown } = {}){
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "LambderTransportFailure";
        this.reason = reason;
    }
}

/** Brand-based type guard, so a duplicate install of the package still matches. */
export const isLambderTransportFailure = (err: unknown): err is LambderTransportFailure =>
    err instanceof Error && (err as LambderTransportFailure).isLambderTransportFailure === true;

/**
 * Delivers one call and hands back the answer in the accessor form
 * resolveApiOutcome() reads. What a transport owes its caller, since nothing
 * but this contract stands between a call and a wrong outcome:
 *
 * - **Any HTTP status is an answer.** A 4xx or 5xx resolves, status and body
 *   included, because resolveApiOutcome() is the one place that reads what a
 *   status means. A transport that rejects on a status throws away the
 *   envelope a refusal, a validation failure or a crash arrived in.
 * - **A rejection is a transport failure.** The caller reports it as
 *   `network` unless the transport threw a LambderTransportFailure naming
 *   another reason, or `timeout` when the caller's own abort fired. That is
 *   the channel for the real cause too: a LambderTransportFailure keeps it as
 *   `cause`, where the caller's `outcome.error` carries it.
 * - **`request.signal` must be honoured**, by rejecting as soon as it aborts.
 *   It is the only thing that makes the caller's `timeoutMs` and its per-call
 *   `signal` mean anything: a transport that ignores it leaves a call waiting
 *   for as long as the callee takes, whatever the caller asked for. Work
 *   already begun need not be cancellable (an in-process handler is not); the
 *   obligation is to stop waiting, not to stop the callee.
 * - **Timeouts and retries belong to the caller.** A transport starts no
 *   clock of its own and retries nothing, so one call is one delivery
 *   attempt and an idempotency key means what it says.
 *
 * Four transports ship: fetch (lambderFetchTransport, the browser default),
 * an in-process Lambder handler (lambderHandlerTransport, for tests), the
 * mock runtime (LambderMockApp.transport), and a cookie-jar decorator over
 * any of them (lambderCookieJarTransport).
 */
export type LambderApiTransport = (request: LambderApiTransportRequest) => Promise<LambderApiHttpAnswer>;

/**
 * The fields of the request envelope, in the order they go on the wire: the
 * one statement of what a call sends, for every sender there is.
 *
 * Two senders write it. A transport hands the payload over as a value
 * (buildTransportEnvelope, below); LambderInvokeCaller has already serialized
 * its payload to decide whether to compress it, and splices that JSON onto the
 * end rather than parsing and stringifying it a second time
 * (buildEnvelopeJson, in invoke/LambderLambdaEvent.ts). The splice sits on top
 * of this function precisely so that a new envelope field cannot be added to
 * one sender and missed by the other, which nothing on the wire would catch.
 */
export const buildEnvelopeFields = (fields: {
    apiName: string;
    version?: string;
    /** The CSRF token, as the envelope names it. */
    token: string;
    siteHost: string;
    /**
     * The plain payload's slot: `{ payload }` from a sender holding the value,
     * and nothing from one that splices its own JSON in afterwards. A
     * compressed payload replaces it.
     */
    payloadSlot?: { payload: unknown };
    compressed?: LambderCompressedGzipPayload | LambderCompressedBrotliPayload | null;
    guardInputs?: Record<string, unknown>;
    idempotencyKey?: string;
}): Record<string, unknown> => ({
    apiName: fields.apiName,
    version: fields.version,
    token: fields.token,
    siteHost: fields.siteHost,
    ...(fields.compressed ?? fields.payloadSlot ?? {}),
    ...(fields.guardInputs !== undefined ? { guardInputs: fields.guardInputs } : {}),
    ...(fields.idempotencyKey !== undefined ? { idempotencyKey: fields.idempotencyKey } : {}),
});

/**
 * The body envelope every transport posts, as a plain object: the same
 * fields whichever transport carries them, so the server and the mock
 * runtime read one shape.
 */
export const buildTransportEnvelope = (request: LambderApiTransportRequest): Record<string, unknown> => buildEnvelopeFields({
    apiName: request.apiName,
    version: request.version,
    token: request.token,
    siteHost: request.siteHost,
    payloadSlot: { payload: request.payload },
    compressed: request.compressed,
    guardInputs: request.guardInputs,
    idempotencyKey: request.idempotencyKey,
});

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

export const resolveApiPathTarget = (apiPath: string): LambderApiPathTarget => {
    // Only an absolute URL carries a host. Parsing "/api" would need a base,
    // and inventing one invents a host to go with it.
    if(!/^https?:\/\//i.test(apiPath)) return { path: apiPath };
    try {
        const url = new URL(apiPath);
        return { host: url.hostname, path: url.pathname, secure: url.protocol === "https:" };
    } catch {
        return { path: apiPath };
    }
};

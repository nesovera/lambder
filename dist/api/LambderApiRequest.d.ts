/**
 * Cookie header pairs (`name=value`) as every value per name, in header
 * order. Parsed pair by pair, because a whole-header parse keeps only the
 * first value of a name the browser holds at two scopes, and the session
 * controller weighs every copy. The map has no prototype: a cookie named
 * `__proto__` or `constructor` must land as its own key rather than resolve
 * to Object.prototype, or one planted cookie would 500 every request. Every
 * adapter builds its request's cookies through this one function.
 */
export declare const cookieValuesByName: (pairs: readonly string[]) => Record<string, string[]>;
/** Request headers under lowercased names, so a lookup never depends on how the gateway spelled them. */
export declare const lowercaseHeaderNames: (headers: Record<string, string | undefined> | undefined) => Record<string, string>;
/**
 * One API call as the core sees it, whichever adapter parsed it: the fields
 * of the envelope a caller posts (LambderCaller and LambderInvokeCaller send
 * the same one), plus what the transport knew about the request. The server
 * builds it from the Lambda event, the mock runtime from a caller's
 * transport request, and from here on nothing in the pipeline knows which.
 */
export type LambderApiRequest = {
    /** The endpoint called: `group.action`, read off the path the call was posted to (`{apiPath}/{group}/{action}`). */
    apiName: string;
    /**
     * Set on a call posted to apiPath itself with the endpoint named in the
     * body, the way callers did before endpoints had paths: such a caller is a
     * page loaded from an older build, and it is answered that its version
     * expired, which reloads it.
     */
    retiredPath?: true;
    /**
     * Set when the call's body is no envelope: not a JSON object (a number,
     * a string, a boolean, null, an array) or not JSON at all. The
     * client-facing reason, which the pipeline answers with the
     * invalid-payload refusal (prepare) before anything reads the call.
     */
    invalidEnvelope?: string;
    /** The caller's apiVersion, informational; null when it sent none. */
    version: string | null;
    /** The signature the caller carries for this endpoint (see LambderApiSignatureMap), for the signature gate; null when it sent none. */
    signature: string | null;
    /** The CSRF token the caller posted in the envelope; "" when it holds none. */
    token: string;
    siteHost: string;
    /** The payload as posted, or as restored from its compressed form; the validated payload once the pipeline has parsed it. */
    payload: unknown;
    /** The compressed form the caller sent instead of `payload`, until restoreCompressedPayload replaces it; null when it sent the payload plainly. */
    compressedPayload: LambderCompressedPayloadFields | null;
    guardInputs: Record<string, unknown> | undefined;
    /**
     * The idempotency key exactly as posted, so `unknown`: it is client data,
     * and the shape check and its client-facing 400 belong to the idempotency
     * engine. A string type here would entitle every reader to treat a
     * posted number or object as a key.
     */
    idempotencyKey: unknown;
    /** Request headers, names lowercased. */
    headers: Record<string, string>;
    /** Every value the request carried per cookie name, in header order (see LambderRenderContext.cookieList). */
    cookies: Record<string, string[]>;
    /** Client IP as the adapter resolved it; "" when unknown. */
    ip: string;
    /** The Host the request was made to. */
    host: string;
    /**
     * The caller's abort signal, for adapters that have one (the mock runtime
     * aborts its latency wait with it). The pipeline ignores it: a Lambda
     * invocation has no signal, and only the adapter knows what abandoning a
     * half-run call means for it.
     */
    signal?: AbortSignal;
};
/** The compressed-payload fields exactly as posted; validated by restoreCompressedPayload. */
export type LambderCompressedPayloadFields = {
    gzip: unknown;
    brotli: unknown;
    declaredBytes: unknown;
};
/** What the transport knew about the request, beside the envelope. */
export type LambderApiRequestInfo = {
    headers: Record<string, string>;
    cookies: Record<string, string[]>;
    ip: string;
    host: string;
    signal?: AbortSignal;
};
/**
 * Whether a POST's Content-Type makes it an API call: application/json,
 * which a browser sends cross-origin only after a CORS preflight. A form
 * (text/plain, urlencoded, multipart) needs none, so any website could post
 * one and, read as an API call, call a public login and plant the
 * attacker's session cookies in a visitor's browser. Every Lambder caller
 * sends application/json; the server and the mock's HTTP-shaped adapters
 * read the same rule here.
 */
export declare const isApiCallContentType: (lowercasedHeaders: Record<string, string | undefined>) => boolean;
/**
 * Reads the posted envelope of a call to `apiName` into a request; the name
 * comes from where the call was posted, never from the body. Everything is
 * taken as posted: a malformed idempotencyKey or guardInputs value is the
 * engines' to refuse, with the client-facing message they already give.
 *
 * `posted` is the body as JSON parsed it; undefined (no body) reads as an
 * empty envelope. A body that is not a JSON object, or one the adapter could
 * not parse (`bodyNotJson`), is flagged on the request as invalidEnvelope
 * and read as an empty envelope, so every adapter refuses it alike, in the
 * pipeline, rather than each deciding what such a body means.
 */
export declare const readApiEnvelope: (posted: unknown, info: LambderApiRequestInfo, apiName: string, flags?: {
    retiredPath?: true;
    bodyNotJson?: true;
}) => LambderApiRequest;
/**
 * readApiEnvelope over a body's text, for an adapter that holds the text and
 * nothing parsed from it: an empty body reads as an empty envelope, and text
 * that is not JSON is flagged as no envelope, as the server flags it.
 */
export declare const readApiEnvelopeText: (text: string, info: LambderApiRequestInfo, apiName: string) => LambderApiRequest;
/** Outcome of restoring a compressed request payload; the message is client-facing. */
export type LambderRestorePayloadResult = {
    ok: true;
} | {
    ok: false;
    message: string;
};
/**
 * Restores a payload the caller sent compressed (`payloadGz` or `payloadBr`,
 * beside `payloadBytes`) onto request.payload, so every later stage
 * (rate-limit key slices, guards, input validation, the handler) reads an
 * ordinary payload. The field names the encoding; a request carrying both is
 * refused. A plain payload passes through untouched.
 *
 * Failures return a message instead of throwing: a malformed body is a
 * client error, not a crash. The declared byte length both bounds and
 * verifies the decompression, so an over-large or tampered body is refused
 * rather than expanded. Runs on Node (zlib) and in a browser
 * (DecompressionStream) under the same bound.
 */
export declare const restoreCompressedPayload: (request: LambderApiRequest, maxPayloadBytes: number) => Promise<LambderRestorePayloadResult>;

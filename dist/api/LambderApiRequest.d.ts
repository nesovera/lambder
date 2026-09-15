/**
 * Cookie header pairs (`name=value`) as every value per name, in header
 * order. Parsed pair by pair, because a whole-header parse keeps only the
 * first value of a name the browser holds at two scopes, and the session
 * controller weighs every copy. The map has no prototype: a cookie is client
 * data, and a name such as `__proto__` or `constructor` must land as a key
 * of its own rather than resolve to Object.prototype, which is what turned
 * one planted cookie into a 500 on every request. Every adapter builds its
 * request's cookies through this one function.
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
    apiName: string;
    /** The caller's apiVersion, for the version gate; null when it sent none. */
    version: string | null;
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
     * and the shape check plus the client-facing 400 belong to the
     * idempotency engine. Typed `string | undefined` here, every reader was
     * entitled to treat a number or an object as a key, and the only one
     * there is had to widen it back before it could check anything.
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
     * The caller's abort signal, carried for adapters that have one (the mock
     * runtime aborts its own latency wait with it). The pipeline itself
     * neither reads nor honours it: a Lambda invocation has no signal, and an
     * adapter that does own one is the layer that knows what abandoning a
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
 * Reads the posted envelope into a request. Null when the body carries no
 * apiName, which is how the server tells an API call from a route with a
 * JSON body. Everything is taken as posted: a malformed idempotencyKey or
 * guardInputs value is the engines' to refuse, with the client-facing
 * message they already give.
 */
export declare const readApiEnvelope: (post: Record<string, unknown> | null | undefined, info: LambderApiRequestInfo) => LambderApiRequest | null;
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
 * ordinary payload and needs no awareness of the wire format. The field
 * names the encoding; a request carrying both is refused. A request that
 * sent a plain payload passes through untouched.
 *
 * Every failure answers with a message instead of throwing: a malformed body
 * is a client error, not a crash. The declared byte length both bounds the
 * decompression and verifies it, so an over-large or tampered body is
 * refused rather than expanded. Runs on Node through zlib and in a browser
 * through DecompressionStream, under the same bound.
 */
export declare const restoreCompressedPayload: (request: LambderApiRequest, maxPayloadBytes: number) => Promise<LambderRestorePayloadResult>;

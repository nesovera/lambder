import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import type { Context } from "aws-lambda";
import type { LambderApiTransport } from "../shared/transport/LambderApiTransport.js";
import { buildTransportEnvelope, LambderTransportFailure, resolveApiPathTarget } from "../shared/transport/LambderApiTransport.js";
import { DEFAULT_MAX_RESTORED_PAYLOAD_BYTES } from "../shared/wire/LambderRequestPayload.js";
import { stopWaitingWhenAborted } from "../shared/util/LambderCallAbort.js";
import { LOOPBACK_CLIENT_IP } from "../shared/util/LambderClientIp.js";
// invoke/ is an adapter above core/: it synthesizes events for a Lambder
// server and decodes its results, so naming the handler it calls is the layer
// working as intended. Type-only, and neither directory is browser-reachable.
import type { LambderHandler } from "../core/LambderCreateOptions.js";
import type { LambderHttpEventFormat } from "../core/LambderContext.js";
import { decodeLambdaHttpResult, localLambdaContext, synthesizeLambdaHttpEvent } from "./LambderLambdaEvent.js";

export type LambderHandlerTransportOptions = {
    /** The Host the handler sees (ctx.host), and the siteHost the envelope carries when the caller has none. Default: the apiPath's own host when it is absolute, otherwise "localhost". */
    host?: string;
    /** The client IP the handler sees (ctx.ip). Default: "127.0.0.1". */
    clientIp?: string;
    /** Ceiling on what a compressed answer may restore to. Default: 20,000,000. */
    maxResponseBytes?: number;
    /** Fields of the Lambda context the handler receives. */
    context?: Partial<Context>;
    /** The gateway shape the handler is called with: "v2" (an HTTP API, a Function URL) or "v1" (a REST API). Default: "v2". A handler answers both alike; name the one your deployment delivers when the difference is what you are testing. */
    eventFormat?: LambderHttpEventFormat;
};

/** The rejection an abort produces here: the signal's own reason, which is a DOMException("AbortError") unless the aborting code named another. */
const isAbortError = (err: unknown, signal: AbortSignal | undefined): boolean =>
    signal !== undefined && signal.aborted && err === signal.reason;

/**
 * A transport that calls a Lambder handler in this process, the way a
 * browser's request would reach it: a browser-shaped API Gateway event (no
 * invoke marker), the real handler, and its answer decoded back, compressed
 * bodies included. With the memory stores, that is an integration test of a
 * real app through the typed caller with no HTTP and no AWS. Wrap it in
 * lambderCookieJarTransport to hold a session across calls.
 *
 * A handler that throws (which a Lambder app never does on the HTTP path,
 * since render() answers its own last-resort 500) produced no answer, so the
 * call fails as `protocol` with the handler's own error as its cause. API
 * Gateway would turn it into a bare 502, but synthesizing one here would
 * throw the error away, and keeping it is the point of an in-process
 * transport. An HTTP answer's only place for it would be the user-facing
 * `message` field, the wrong channel for an internal fault.
 *
 * `request.signal` ends the wait, as the transport contract requires. The
 * handler still runs to completion, because a function call in this process
 * cannot be cancelled: a timeout buys the caller its answer, not the
 * callee's attention.
 */
export const lambderHandlerTransport = (
    handler: LambderHandler,
    options: LambderHandlerTransportOptions = {},
): LambderApiTransport => {
    const clientIp = options.clientIp ?? LOOPBACK_CLIENT_IP;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESTORED_PAYLOAD_BYTES;
    return async (request) => {
        // Before anything is built or called: a call the caller has already
        // given up on should not reach the handler at all, and an abort must
        // travel as the signal's own reason rather than as a transport fault.
        request.signal?.throwIfAborted();
        // An absolute apiPath (what lambderFetchTransport tells a caller
        // outside a browser to configure) is a URL, and a URL as the event's
        // rawPath matches no route: every call would 404 on an app that is
        // wired correctly.
        const target = resolveApiPathTarget(request.apiPath);
        const host = options.host ?? target.host ?? "localhost";
        const event = synthesizeLambdaHttpEvent({
            method: "POST",
            path: target.path,
            host,
            headers: request.headers,
            contentType: "application/json",
            clientIp: request.clientIp ?? clientIp,
            cookies: request.cookies,
            body: JSON.stringify(buildTransportEnvelope({ ...request, siteHost: request.siteHost || host })),
        }, { invoke: false, eventFormat: options.eventFormat });
        let result: unknown;
        try {
            result = await stopWaitingWhenAborted(
                handler(event, localLambdaContext("lambder-local", options.context)),
                request.signal,
            );
        } catch(err) {
            if(isAbortError(err, request.signal)) throw err;
            // A transport failure is the one channel that carries a cause. A
            // synthetic 502 would leave the caller an outcome.error reading
            // "Request failed: 502" and no way to reach what actually threw.
            throw new LambderTransportFailure(
                "protocol",
                `the handler threw instead of answering: ${coerceToError(err).message}`,
                { cause: err },
            );
        }
        // Decoding failures are the callee answering with something that is
        // not an HTTP result, or with more than the ceiling allows. Neither is
        // a network failure, and reporting one as such would send whoever is
        // debugging an integration test to look at their connection.
        let http: Awaited<ReturnType<typeof decodeLambdaHttpResult>>;
        try {
            http = await decodeLambdaHttpResult(result, maxResponseBytes);
        } catch(err) {
            throw new LambderTransportFailure("protocol", coerceToError(err).message, { cause: err });
        }
        return {
            status: http.statusCode,
            statusText: "",
            header: (name) => http.headers[name.toLowerCase()] ?? null,
            json: async () => http.json(),
            text: async () => http.text(),
            setCookies: http.cookies,
        };
    };
};

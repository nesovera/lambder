import { coerceToError } from "../shared/wire/LambderCrashDetail.js";
import { buildTransportEnvelope, LambderTransportFailure, resolveApiPathTarget } from "../shared/transport/LambderApiTransport.js";
import { DEFAULT_MAX_RESTORED_PAYLOAD_BYTES } from "../shared/wire/LambderRequestPayload.js";
import { stopWaitingWhenAborted } from "../shared/util/LambderCallAbort.js";
import { LOOPBACK_CLIENT_IP } from "../shared/util/LambderClientIp.js";
import { decodeLambdaHttpResult, localLambdaContext, synthesizeLambdaHttpEvent } from "./LambderLambdaEvent.js";
/** The rejection an abort produces here: the signal's own reason, which is a DOMException("AbortError") unless the aborting code named another. */
const isAbortError = (err, signal) => signal !== undefined && signal.aborted && err === signal.reason;
/**
 * A transport that calls a Lambder handler in this process, the way a
 * browser's request would reach it: a browser-shaped API Gateway event (no
 * invoke marker), the real handler, and its answer decoded back, compressed
 * bodies included. With the memory stores, that is an integration test of a
 * real app through the typed caller with no HTTP and no AWS. Wrap it in
 * lambderCookieJarTransport to hold a session across calls.
 *
 * A handler that throws (which a Lambder app never does on the HTTP path,
 * since render() answers its own last-resort 500) produced no answer at all,
 * so the call fails as `protocol` carrying the handler's own error as its
 * cause. API Gateway would have turned it into a bare 502, and synthesizing
 * one here would throw the error away; keeping it is the point of an
 * in-process transport, and there is nowhere in an HTTP answer to put one
 * except the user-facing `message` field, which is the wrong channel for an
 * internal fault.
 *
 * `request.signal` ends the wait, as the transport contract requires. The
 * handler keeps running to completion either way, because a function call in
 * this process cannot be cancelled: what a timeout buys here is the caller's
 * answer, not the callee's attention.
 */
export const lambderHandlerTransport = (handler, options = {}) => {
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
            clientIp: request.clientIp ?? clientIp,
            cookies: request.cookies,
            body: JSON.stringify(buildTransportEnvelope({ ...request, siteHost: request.siteHost || host })),
        }, { invoke: false });
        let result;
        try {
            result = await stopWaitingWhenAborted(handler(event, localLambdaContext("lambder-local", options.context)), request.signal);
        }
        catch (err) {
            if (isAbortError(err, request.signal))
                throw err;
            // The whole point of this transport is in-process integration
            // testing, so the handler's own error is the useful part. A thrown
            // handler answered nothing, and a transport failure is the one
            // channel that carries a cause: swallowing it into a synthetic 502
            // left the caller an outcome.error reading "Request failed: 502"
            // and no way to reach what actually threw.
            throw new LambderTransportFailure("protocol", `the handler threw instead of answering: ${coerceToError(err).message}`, { cause: err });
        }
        // Decoding failures are the callee answering with something that is
        // not an HTTP result, or with more than the ceiling allows. Neither is
        // a network failure, and reporting them as one sends whoever is
        // debugging an integration test looking at their connection.
        let http;
        try {
            http = await decodeLambdaHttpResult(result, maxResponseBytes);
        }
        catch (err) {
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

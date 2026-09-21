import type { Context } from "aws-lambda";
import type { LambderApiTransport } from "../shared/transport/LambderApiTransport.js";
import type { LambderHandler } from "../core/LambderCreateOptions.js";
import type { LambderHttpEventFormat } from "../core/LambderContext.js";
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
export declare const lambderHandlerTransport: (handler: LambderHandler, options?: LambderHandlerTransportOptions) => LambderApiTransport;

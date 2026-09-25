import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderCrashOptions, LambderCrashSite } from "./LambderCreateOptions.js";
import { LambderResponse } from "./LambderResponse.js";
/**
 * The `crashes` option applied: what the instance does with a crash beyond
 * handing it to the app's global error handler.
 *
 * Kept apart from the request path, like CORS and file serving: a crash is
 * reported wherever it happened (an API call, a route, an event, a `created`
 * hook) and answered by the framework only when nothing the app wrote
 * answered it, so neither is a step of rendering a request.
 */
export declare class LambderCrashHandling {
    private readonly options;
    private readonly apiVersion;
    private readonly reportTimeoutMs;
    constructor(options: LambderCrashOptions, apiVersion: string | null);
    /**
     * Hands a crash to the app's reporter and waits for it, for up to
     * reportTimeoutMs. Never throws: a reporter that fails is logged beside
     * the crash it was given, one that has not finished by then is logged
     * with it as unfinished, and either way the request goes on to be
     * answered. The report itself cannot be cancelled and runs on; only the
     * wait ends.
     */
    report(error: Error, site: LambderCrashSite): Promise<void>;
    /**
     * The framework's own 500, for a crash nothing the app wrote answered:
     * API calls get the core's crash envelope so clients can parse a
     * structured failure, everything else plain text. It carries the crash in
     * full only for a caller `crashes.reveal` trusts.
     *
     * Without a reporter it also logs the crash (and a global error handler
     * that threw on it): the invocation answered, so Lambda counts no error,
     * and this log line is the only trace the crash leaves.
     */
    frameworkResponse(error: Error, ctx: LambderRenderContext | null, errorHandlerCrash: Error | null): Promise<LambderResponse>;
    /** Whether this request's caller may read the crash; a reveal rule that throws answers no. */
    private mayReveal;
}

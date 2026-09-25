import { crashAnswer } from "../api/LambderApiEnvelope.js";
import { describeCrash } from "../shared/wire/LambderCrashDetail.js";
import { stopWaitingWhenAborted } from "../shared/util/LambderCallAbort.js";
import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderCrashOptions, LambderCrashSite } from "./LambderCreateOptions.js";
import { LambderResponse, responseFromAnswer } from "./LambderResponse.js";

/**
 * How long a crash's answer waits for the reporter by default: long enough
 * for a network write to a log or an error tracker, short enough that a
 * stalled one leaves most of a function's timeout to answer in.
 */
const DEFAULT_CRASH_REPORT_TIMEOUT_MS = 3_000;

/**
 * The `crashes` option applied: what the instance does with a crash beyond
 * handing it to the app's global error handler.
 *
 * Kept apart from the request path, like CORS and file serving: a crash is
 * reported wherever it happened (an API call, a route, an event, a `created`
 * hook) and answered by the framework only when nothing the app wrote
 * answered it, so neither is a step of rendering a request.
 */
export class LambderCrashHandling {
    private readonly options: LambderCrashOptions;
    private readonly apiVersion: string | null;
    private readonly reportTimeoutMs: number;

    constructor(options: LambderCrashOptions, apiVersion: string | null){
        this.options = options;
        this.apiVersion = apiVersion;
        this.reportTimeoutMs = options.reportTimeoutMs ?? DEFAULT_CRASH_REPORT_TIMEOUT_MS;
    }

    /**
     * Hands a crash to the app's reporter and waits for it, for up to
     * reportTimeoutMs. Never throws: a reporter that fails is logged beside
     * the crash it was given, one that has not finished by then is logged
     * with it as unfinished, and either way the request goes on to be
     * answered. The report itself cannot be cancelled and runs on; only the
     * wait ends.
     */
    async report(error: Error, site: LambderCrashSite): Promise<void> {
        const report = this.options.report;
        if(!report) return;
        const deadline = AbortSignal.timeout(this.reportTimeoutMs);
        try {
            // Started inside the promise chain, so a reporter that throws
            // before its first await lands in the catch below like one that
            // rejects.
            await stopWaitingWhenAborted(Promise.resolve().then(() => report(error, site)), deadline);
        } catch(reportErr){
            if(deadline.aborted && reportErr === deadline.reason){
                console.error(`Lambder: crashes.report did not finish within ${this.reportTimeoutMs} ms and is no longer waited for. The crash:`, error);
            } else {
                console.error("Lambder: crashes.report threw while reporting a crash. The crash:", error, "What the reporter threw:", reportErr);
            }
        }
    }

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
    async frameworkResponse(error: Error, ctx: LambderRenderContext | null, errorHandlerCrash: Error | null): Promise<LambderResponse> {
        if(!this.options.report){
            console.error(`Lambder: ${ctx ? `${ctx.method} ${ctx.path}` : "a request"} crashed and was answered with the framework's 500.`, error);
            if(errorHandlerCrash) console.error(errorHandlerCrash);
        }
        const revealed = ctx && await this.mayReveal(ctx) ? describeCrash(error, ctx) : null;
        if(ctx?.api){
            return responseFromAnswer(crashAnswer(this.apiVersion, revealed ? { crash: revealed, logList: ctx.logList } : undefined));
        }
        return new LambderResponse({
            statusCode: 500,
            body: revealed
                ? ["Internal Server Error.", "", revealed.stack ?? `${revealed.name}: ${revealed.message}`,
                    ...(revealed.causeList ?? []).map((cause) => `Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`)].join("\n")
                : "Internal Server Error.",
        });
    }

    /** Whether this request's caller may read the crash; a reveal rule that throws answers no. */
    private async mayReveal(ctx: LambderRenderContext): Promise<boolean> {
        if(!this.options.reveal) return false;
        try {
            return (await this.options.reveal(ctx)) === true;
        } catch(revealErr){
            console.error("Lambder: crashes.reveal threw; the crash was not revealed.", revealErr);
            return false;
        }
    }
}

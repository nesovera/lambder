import type { LambderMockCallEvent, LambderMockListener } from "./LambderMockTypes.js";

export type LambderMockConsoleLoggerOptions = {
    /** Log the request payload and the answer's envelope beside each line. Default: false. */
    payloads?: boolean;
    /** With payloads on, group each call's detail under a collapsed console group. Default: true. */
    collapsed?: boolean;
    /** Where to write. Default: console. */
    console?: Pick<Console, "log" | "group" | "groupCollapsed" | "groupEnd">;
};

/**
 * A ready-made subscriber: one line per completed call, naming the endpoint,
 * how it ended, the status and the time it took; with `payloads` on, the
 * request payload and the answer's envelope under a collapsed group. So
 * `mockApp.subscribe("console", lambderMockConsoleLogger())` logs everything.
 */
export const lambderMockConsoleLogger = (options: LambderMockConsoleLoggerOptions = {}): LambderMockListener => {
    const output = options.console ?? console;
    const collapsed = options.collapsed ?? true;
    const payloads = new Map<number, unknown>();
    return (event: LambderMockCallEvent) => {
        if(event.phase === "request"){
            if(options.payloads) payloads.set(event.id, event.payload);
            return;
        }
        const status = event.statusCode === null ? "no answer" : String(event.statusCode);
        const line = `[lambder mock] ${event.apiName} → ${event.outcome} (${status}, ${event.durationMs}ms)`;
        if(!options.payloads){
            output.log(line);
            return;
        }
        const payload = payloads.get(event.id);
        payloads.delete(event.id);
        (collapsed ? output.groupCollapsed : output.group).call(output, line);
        output.log("payload", payload);
        if(event.envelope) output.log("envelope", event.envelope);
        if(event.guardsRun.length) output.log("guards", event.guardsRun.join(", "));
        if(event.error) output.log("error", event.error);
        output.groupEnd();
    };
};

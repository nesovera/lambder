/**
 * A ready-made subscriber: one line per completed call, naming the endpoint,
 * how it ended, the status and the time it took; with `payloads` on, the
 * request payload and the answer's envelope under a collapsed group. So
 * `mockApp.subscribe("console", lambderMockConsoleLogger())` logs everything.
 */
export const lambderMockConsoleLogger = (options = {}) => {
    const output = options.console ?? console;
    const collapsed = options.collapsed ?? true;
    const payloads = new Map();
    return (event) => {
        if (event.phase === "request") {
            if (options.payloads)
                payloads.set(event.id, event.payload);
            return;
        }
        const status = event.statusCode === null ? "no answer" : String(event.statusCode);
        const line = `[lambder mock] ${event.apiName} → ${event.outcome} (${status}, ${event.durationMs}ms)`;
        if (!options.payloads) {
            output.log(line);
            return;
        }
        const payload = payloads.get(event.id);
        payloads.delete(event.id);
        (collapsed ? output.groupCollapsed : output.group).call(output, line);
        output.log("payload", payload);
        if (event.envelope)
            output.log("envelope", event.envelope);
        if (event.guardsRun.length)
            output.log("guards", event.guardsRun.join(", "));
        if (event.error)
            output.log("error", event.error);
        output.groupEnd();
    };
};

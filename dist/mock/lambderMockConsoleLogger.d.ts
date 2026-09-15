import type { LambderMockListener } from "./LambderMockTypes.js";
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
export declare const lambderMockConsoleLogger: (options?: LambderMockConsoleLoggerOptions) => LambderMockListener;

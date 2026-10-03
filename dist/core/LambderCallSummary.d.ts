import type { LambderCallOutcome } from "../shared/wire/LambderCallOutcome.js";
/**
 * One API call, or one request a route answered, as its summary line records
 * it: what was called, how it ended, how long it took, and the ids that join
 * it to the rest of the logs. Nothing from the call's input, its path, its
 * session, its cookies or its caller's address is in it, so the line can be
 * kept and queried as long as the app likes.
 */
export type LambderCallSummary = {
    /** Always "lambder.call": what a log query picks the lines out by. */
    kind: "lambder.call";
    /** The endpoint an API call's path named (`group.action`), whether or not one is registered under it; null for a route. */
    api: string | null;
    /** The route that answered, as it was registered: its matcher's name, or its method and path pattern; null for an API call, for a predicate route given no name, and for an addAction that answered an HTTP request. */
    route: string | null;
    /** How the call ended; see LambderCallOutcome. A route's is read from its status: success below 400, crash from 500, other between. */
    outcome: LambderCallOutcome;
    /** The refusal's code, the framework's (`lambder/rate-limited`) or the app's; null when the answer carries none. */
    code: string | null;
    /** The HTTP status the call was answered with. */
    status: number;
    /** From the invocation's start to the answer, in milliseconds. */
    durationMs: number;
    /** How long the API handler, or the route's handler, itself ran, in milliseconds; null when it did not run (refused before it, replayed, or answered by a hook). */
    handlerMs: number | null;
    /** True when a stored idempotent answer was replayed and no handler ran. */
    replayed: boolean;
    /** True on the first invocation of this process, whose duration includes loading the app. */
    coldStart: boolean;
    /** The invocation's request id, the one Lambda's own log lines for it carry. */
    requestId: string | null;
    /** The request id of the invocation that called this one over a Lambda invoke (LambderInvokeCaller), which carries it; null otherwise. */
    parentRequestId: string | null;
};
/**
 * Where the summaries go: the default writes each as one JSON line on
 * stdout, where a Lambda function's log group keeps it and CloudWatch Logs
 * Insights reads its fields without a parse step; a function receives each
 * instead; false writes none.
 */
export type LambderCallSummaryOption = false | ((summary: LambderCallSummary) => void);
/** One JSON line on stdout, written directly rather than through console.log, which on Lambda prefixes a timestamp and a level that would stop the line reading as JSON. */
export declare const writeCallSummaryLine: (summary: LambderCallSummary) => void;
/** Milliseconds as the line records them: to a tenth, which is finer than a call can be told apart by and keeps the line short. */
export declare const roundedMilliseconds: (milliseconds: number) => number;

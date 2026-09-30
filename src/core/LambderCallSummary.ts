import type { LambderCallOutcome } from "../shared/wire/LambderCallOutcome.js";

/**
 * One API call as its summary line records it: what was called, how it
 * ended, how long it took, and the ids that join it to the rest of the
 * logs. Nothing from the call's input, its session, its cookies or its
 * caller's address is in it, so the line can be kept and queried as long as
 * the app likes.
 */
export type LambderCallSummary = {
    /** Always "lambder.call": what a log query picks the lines out by. */
    kind: "lambder.call";
    /** The endpoint the call's path named (`group.action`), whether or not one is registered under it. */
    api: string;
    /** How the call ended; see LambderCallOutcome. */
    outcome: LambderCallOutcome;
    /** The refusal's code, the framework's (`lambder/rate-limited`) or the app's; null when the answer carries none. */
    code: string | null;
    /** The HTTP status the call was answered with. */
    status: number;
    /** From the invocation's start to the answer, in milliseconds. */
    durationMs: number;
    /** How long the API handler itself ran, in milliseconds; null when it did not run (refused before it, or replayed). */
    handlerMs: number | null;
    /** True when a stored idempotent answer was replayed and no handler ran. */
    replayed: boolean;
    /** True on the first invocation of this process, whose duration includes loading the app. */
    coldStart: boolean;
    /** The invocation's request id, the one Lambda's own log lines for it carry. */
    requestId: string | null;
    /** The request id of the invocation that called this one over a direct invoke (LambderInvokeCaller), which carries it; null otherwise. */
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
export const writeCallSummaryLine = (summary: LambderCallSummary): void => {
    const line = `${JSON.stringify(summary)}\n`;
    if(typeof process !== "undefined" && typeof process.stdout?.write === "function") process.stdout.write(line);
    else console.log(line.trimEnd());
};

/** Milliseconds as the line records them: to a tenth, which is finer than a call can be told apart by and keeps the line short. */
export const roundedMilliseconds = (milliseconds: number): number => Math.round(milliseconds * 10) / 10;

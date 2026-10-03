import type { Context } from "aws-lambda";
import type { LambderCallOutcomeHint } from "../shared/wire/LambderCallOutcome.js";
import { invocationScope, type LambderInvocation } from "../shared/util/LambderInvocationScope.js";

/*
 * The server's side of the invocation scope (shared/util/LambderInvocationScope):
 * the record an invocation keeps about itself while it runs, which its call
 * summary line is written from once the response is final.
 */

/** What one invocation records about itself while it runs, for its call summary and for the calls it makes. */
export type LambderInvocationRecord = LambderInvocation & {
    /** When the invocation started, on performance.now()'s clock. */
    readonly startedAt: number;
    /** Whether this is the first invocation this process has run. */
    readonly coldStart: boolean;
    /** How long the API handler, or the route's handler, itself ran, in milliseconds; null until it has. */
    handlerMs: number | null;
    /** Whether an idempotent answer was replayed, so no handler ran. */
    replayed: boolean;
    /**
     * What the invocation serves, named: an API call by the endpoint its path
     * named, or a request a route answered by the route as registered (null
     * for a route with no name), with the invocation that invoked it, when
     * one did. Null for anything else: a file, the index page, an event.
     */
    call: { api: string | null; route: string | null; parentRequestId: string | null } | null;
    /** What the answer is, once the call has one. */
    outcome: LambderCallOutcomeHint | null;
};

/** Whether this process has started an invocation yet: the first one is its cold start. */
let processStarted = false;

/** Runs one invocation under a record of its own, which `currentInvocation()` finds from anything it runs. */
export const runInvocation = <T>(lambdaContext: Context | null | undefined, run: (record: LambderInvocationRecord) => Promise<T>): Promise<T> => {
    const record: LambderInvocationRecord = {
        requestId: typeof lambdaContext?.awsRequestId === "string" && lambdaContext.awsRequestId ? lambdaContext.awsRequestId : null,
        startedAt: performance.now(),
        coldStart: !processStarted,
        handlerMs: null,
        replayed: false,
        call: null,
        outcome: null,
    };
    processStarted = true;
    return invocationScope.run(record, () => run(record));
};

/** The invocation the calling code runs under, or null outside one (a script, a test calling a library directly). */
export const currentInvocation = (): LambderInvocationRecord | null =>
    // Only runInvocation opens the scope, and always with a whole record.
    (invocationScope.getStore() as LambderInvocationRecord | undefined) ?? null;

import { AsyncLocalStorage } from "async_hooks";

/*
 * The invocation a piece of server code runs under, found from wherever it
 * runs: an API handler, a hook, a library it calls, an invoke caller making
 * a call of its own. The server's handler opens one per invocation (see
 * core/LambderInvocationScope, which records the rest of what a call
 * summary needs), and the async context carries it through every await, so
 * nothing has to pass it along.
 *
 * Here, below both core/ and invoke/, because the server opens the scope and
 * the invoke event builder reads it. Node-only: neither browser entry
 * reaches this module.
 */

/** What any layer may ask of the invocation it runs under. */
export type LambderInvocation = {
    /** The invocation's own request id (the Lambda context's awsRequestId); null when the context has none. */
    readonly requestId: string | null;
};

/** The async context the server's handler opens once per invocation. */
export const invocationScope = new AsyncLocalStorage<LambderInvocation>();

/** The request id of the invocation the calling code runs under, or null outside one (a script, a test calling a library directly). */
export const currentRequestId = (): string | null => invocationScope.getStore()?.requestId ?? null;

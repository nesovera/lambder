import { invocationScope } from "../shared/util/LambderInvocationScope.js";
/** Whether this process has started an invocation yet: the first one is its cold start. */
let processStarted = false;
/** Runs one invocation under a record of its own, which `currentInvocation()` finds from anything it runs. */
export const runInvocation = (lambdaContext, run) => {
    const record = {
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
export const currentInvocation = () => 
// Only runInvocation opens the scope, and always with a whole record.
invocationScope.getStore() ?? null;

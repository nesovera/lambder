/**
 * A crash, described for a caller that is allowed to see it.
 *
 * A global error handler decides what a failed request learns about the
 * failure. A browser gets a generic message; a trusted caller (another
 * lambda invoking this one, a developer holding a debug cookie) can be
 * handed the whole thing: the error's name, message and stack, its cause
 * chain, and where it happened, so the caller can store it in its own
 * error log and point at the right CloudWatch stream. The envelope carries
 * it in the `crash` field beside errorMessage; LambderInvokeCaller reads it
 * back and rebuilds an Error from it as the `cause` of the error it throws,
 * so an error reporter that walks causes sees the callee's stack without
 * being taught anything.
 *
 * Dependency-free and isomorphic: the type is part of the envelope both
 * entries export, and describeCrash needs nothing from Node.
 */

export type LambderCrashCause = {
    name: string;
    message: string;
    stack?: string | null;
};

export type LambderCrashDetail = LambderCrashCause & {
    /** The Error `cause` chain, outermost first, a few levels deep. */
    causeList?: LambderCrashCause[];
    /** The failed invocation's own awsRequestId, from the render context's lambdaContext. */
    requestId?: string | null;
    /** The function it happened in, from the same place. */
    functionName?: string | null;
};

const MAX_NAME_CHARS = 200;
const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_CHARS = 8000;
const MAX_CAUSE_DEPTH = 3;

const clamp = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

const describeCause = (error: Error): LambderCrashCause => ({
    name: clamp(error.name || "Error", MAX_NAME_CHARS),
    message: clamp(error.message || String(error), MAX_MESSAGE_CHARS),
    stack: error.stack ? clamp(error.stack, MAX_STACK_CHARS) : null,
});

/**
 * Describes whatever was thrown. Pass the render context (the global error
 * handler's second argument) so the detail names the invocation it came
 * from; it is optional because the handler receives null when the context
 * itself could not be built.
 */
export const describeCrash = (
    error: unknown,
    ctx?: { lambdaContext?: { awsRequestId?: string; functionName?: string } | null } | null,
): LambderCrashDetail => {
    const where = {
        requestId: ctx?.lambdaContext?.awsRequestId ?? null,
        functionName: ctx?.lambdaContext?.functionName ?? null,
    };
    if(error instanceof Error){
        const causeList: LambderCrashCause[] = [];
        let cause: unknown = (error as Error & { cause?: unknown }).cause;
        let depth = 0;
        while(cause instanceof Error && depth < MAX_CAUSE_DEPTH){
            causeList.push(describeCause(cause));
            cause = (cause as Error & { cause?: unknown }).cause;
            depth += 1;
        }
        return { ...describeCause(error), ...(causeList.length ? { causeList } : {}), ...where };
    }
    if(typeof error === "string"){
        return { name: "Error", message: clamp(error, MAX_MESSAGE_CHARS), stack: null, ...where };
    }
    let message: string;
    try { message = JSON.stringify(error) ?? String(error); } catch { message = String(error); }
    return { name: "UnknownError", message: clamp(message, MAX_MESSAGE_CHARS), stack: null, ...where };
};

/**
 * Rebuilds an Error (with its cause chain) from a crash detail, so a caller
 * can chain it as the `cause` of its own error and reporters that walk
 * causes see the callee's stack as it was.
 */
export const errorFromCrashDetail = (crash: LambderCrashDetail): Error => {
    const build = (entry: LambderCrashCause, cause?: Error): Error => {
        const error = new Error(entry.message, cause ? { cause } : undefined);
        error.name = entry.name;
        error.stack = entry.stack ?? `${entry.name}: ${entry.message}`;
        return error;
    };
    let cause: Error | undefined;
    for(const entry of [...(crash.causeList ?? [])].reverse()) cause = build(entry, cause);
    return build(crash, cause);
};

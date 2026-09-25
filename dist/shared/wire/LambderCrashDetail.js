/**
 * A crash, described for a caller that is allowed to see it.
 *
 * A global error handler decides what a failed request learns. A browser
 * gets a generic message; a trusted caller (another lambda invoking this
 * one, a developer holding a debug cookie) can get the error's name, message,
 * stack, cause chain and where it happened, to store in its own error log
 * and find the right CloudWatch stream. The envelope carries it in `crash`
 * beside errorMessage; LambderInvokeCaller rebuilds an Error from it as the
 * `cause` of the error it throws, so a reporter that walks causes sees the
 * callee's stack unaided.
 *
 * Dependency-free and isomorphic: the type is part of the envelope both
 * entries export, and describeCrash needs nothing from Node.
 */
const MAX_NAME_CHARS = 200;
const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_CHARS = 8000;
const MAX_CAUSE_DEPTH = 3;
const clamp = (value, max) => (value.length > max ? value.slice(0, max) : value);
const describeCause = (error) => ({
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
export const describeCrash = (error, ctx) => {
    const where = {
        requestId: ctx?.lambdaContext?.awsRequestId ?? null,
        functionName: ctx?.lambdaContext?.functionName ?? null,
    };
    if (error instanceof Error) {
        const causeList = [];
        let cause = error.cause;
        let depth = 0;
        while (cause instanceof Error && depth < MAX_CAUSE_DEPTH) {
            causeList.push(describeCause(cause));
            cause = cause.cause;
            depth += 1;
        }
        return { ...describeCause(error), ...(causeList.length ? { causeList } : {}), ...where };
    }
    if (typeof error === "string") {
        return { name: "Error", message: clamp(error, MAX_MESSAGE_CHARS), stack: null, ...where };
    }
    let message;
    try {
        message = JSON.stringify(error) ?? String(error);
    }
    catch {
        message = String(error);
    }
    return { name: "UnknownError", message: clamp(message, MAX_MESSAGE_CHARS), stack: null, ...where };
};
/**
 * Rebuilds an Error (with its cause chain) from a crash detail, so a caller
 * can chain it as the `cause` of its own error and reporters that walk
 * causes see the callee's stack as it was.
 */
export const errorFromCrashDetail = (crash) => {
    const build = (entry, cause) => {
        const error = new Error(entry.message, cause ? { cause } : undefined);
        error.name = entry.name;
        error.stack = entry.stack ?? `${entry.name}: ${entry.message}`;
        return error;
    };
    let cause;
    for (const entry of [...(crash.causeList ?? [])].reverse())
        cause = build(entry, cause);
    return build(crash, cause);
};
/**
 * A thrown value as an Error, so a reporter or a `cause` chain always holds
 * one. An Error passes through; anything else becomes an Error whose message
 * describes the value as describeCrash does, JSON before String() (a
 * null-prototype object or a throwing toString must not make the coercion
 * itself throw). Use it instead of spelling
 * `err instanceof Error ? err : new Error(...)` with a fallback per site.
 */
export const coerceToError = (value, fallbackMessage = "Unknown error") => {
    if (value instanceof Error)
        return value;
    let message;
    if (typeof value === "string")
        message = value;
    else {
        try {
            message = JSON.stringify(value);
        }
        catch {
            try {
                message = String(value);
            }
            catch {
                message = undefined;
            }
        }
    }
    return new Error(message || fallbackMessage);
};

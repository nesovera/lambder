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
/**
 * Describes whatever was thrown. Pass the render context (the global error
 * handler's second argument) so the detail names the invocation it came
 * from; it is optional because the handler receives null when the context
 * itself could not be built.
 */
export declare const describeCrash: (error: unknown, ctx?: {
    lambdaContext?: {
        awsRequestId?: string;
        functionName?: string;
    } | null;
} | null) => LambderCrashDetail;
/**
 * Rebuilds an Error (with its cause chain) from a crash detail, so a caller
 * can chain it as the `cause` of its own error and reporters that walk
 * causes see the callee's stack as it was.
 */
export declare const errorFromCrashDetail: (crash: LambderCrashDetail) => Error;
/**
 * A thrown value as an Error, so a reporter or a `cause` chain always holds
 * one. An Error passes through; anything else becomes an Error whose message
 * describes the value as describeCrash does, JSON before String() (a
 * null-prototype object or a throwing toString must not make the coercion
 * itself throw). Use it instead of spelling
 * `err instanceof Error ? err : new Error(...)` with a fallback per site.
 */
export declare const coerceToError: (value: unknown, fallbackMessage?: string) => Error;

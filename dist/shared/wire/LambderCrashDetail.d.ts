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
 * describes the value the way describeCrash does, JSON where String() cannot
 * (a null-prototype object or a throwing toString must not make the
 * coercion itself throw). One implementation, rather than
 * `err instanceof Error ? err : new Error(...)` spelled at every site with a
 * fallback of its own.
 */
export declare const coerceToError: (value: unknown, fallbackMessage?: string) => Error;

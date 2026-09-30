import { AsyncLocalStorage } from "async_hooks";
/** What any layer may ask of the invocation it runs under. */
export type LambderInvocation = {
    /** The invocation's own request id (the Lambda context's awsRequestId); null when the context has none. */
    readonly requestId: string | null;
};
/** The async context the server's handler opens once per invocation. */
export declare const invocationScope: AsyncLocalStorage<LambderInvocation>;
/** The request id of the invocation the calling code runs under, or null outside one (a script, a test calling a library directly). */
export declare const currentRequestId: () => string | null;

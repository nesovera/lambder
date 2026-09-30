import { AsyncLocalStorage } from "async_hooks";
/** The async context the server's handler opens once per invocation. */
export const invocationScope = new AsyncLocalStorage();
/** The request id of the invocation the calling code runs under, or null outside one (a script, a test calling a library directly). */
export const currentRequestId = () => invocationScope.getStore()?.requestId ?? null;

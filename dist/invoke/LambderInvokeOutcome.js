/**
 * What an invoke call reports: the failure reasons, the outcome union, the
 * error api() throws, and the pure functions that read a failure (what a
 * rejected delivery means, what Lambda's error payload says, the one-line
 * detail an error message ends with).
 *
 * Split out of LambderInvokeCaller for the reason shared/wire/LambderApiOutcome.ts
 * is split out of the browser caller: this is the vocabulary a CALLER of the
 * caller reads, and a site that only annotates an outcome or narrows an error
 * should not have to read a 700-line class to find it. The functions here
 * touch none of the caller's state, so every "what went wrong on an invoke"
 * answer is in one file.
 */
import { isLambderTransportFailure } from "../shared/transport/LambderApiTransport.js";
/**
 * What api() throws. Its message names the function, the API and the reason,
 * so an error reporter that fingerprints on the message groups one broken
 * API into one row; its cause is the callee's own error rebuilt from the
 * crash detail (or Lambda's FunctionError, or the SDK's rejection), so a
 * reporter that walks causes stores the callee's stack.
 */
export class LambderInvokeError extends Error {
    /** Brand for detection across duplicate lambder installs, like LambderApiRefusal. */
    isLambderInvokeError = true;
    reason;
    apiName;
    functionName;
    status;
    errorMessage;
    crash;
    functionError;
    logList;
    zodError;
    retryAfterSeconds;
    bytes;
    /** The full failure outcome; it carries this error and this error carries it. */
    outcome;
    constructor(init) {
        super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
        this.name = "LambderInvokeError";
        this.reason = init.reason;
        this.apiName = init.apiName;
        this.functionName = init.functionName;
        this.status = init.status;
        this.errorMessage = init.errorMessage;
        this.crash = init.crash;
        this.functionError = init.functionError;
        this.logList = init.logList;
        this.zodError = init.zodError;
        this.retryAfterSeconds = init.retryAfterSeconds;
        this.bytes = init.bytes;
    }
}
/** Brand-based type guard (see LambderInvokeError.isLambderInvokeError). */
export const isLambderInvokeError = (err) => err instanceof Error && err.isLambderInvokeError === true;
// ---------------------------------------------------------------------------
// Reading a failure: pure functions over what came back, used by the caller.
// ---------------------------------------------------------------------------
/**
 * What a rejected delivery means, as far as the rejection itself says.
 *
 * A transport that named its own reason is believed. Otherwise: the Lambda
 * SDK throws its service exceptions (AccessDeniedException,
 * ResourceNotFoundException, RequestEntityTooLargeException and the rest)
 * with a $fault mark and a name ending in "Exception", while a connectivity
 * failure arrives as a plain Error or TypeError carrying neither. The first
 * kind is the Lambda service answering the invoke, which is a permission,
 * wiring or size fault to go and fix; calling it `network` sent whoever read
 * it to look at their connection instead.
 */
export const classifyDeliveryFailure = (error) => {
    if (isLambderTransportFailure(error))
        return error.reason;
    const fault = error.$fault;
    if (fault === "client" || fault === "server")
        return 'protocol';
    return error.name.endsWith("Exception") ? 'protocol' : 'network';
};
/** Lambda's error payload as an Error, with the callee's own name and trace. */
export const errorFromFunctionError = (functionError) => {
    const error = new Error(functionError.errorMessage ?? "the function failed");
    error.name = functionError.errorType ?? "FunctionError";
    if (functionError.trace?.length)
        error.stack = functionError.trace.join("\n");
    return error;
};
/** Lambda's error payload as it actually arrives: an object with the three fields, or whatever else the runtime sent. */
export const parseFunctionError = (result) => {
    if (result && typeof result === "object") {
        const { errorType, errorMessage, trace } = result;
        return {
            ...(typeof errorType === "string" ? { errorType } : {}),
            ...(typeof errorMessage === "string" ? { errorMessage } : {}),
            ...(Array.isArray(trace) ? { trace: trace.map(String) } : {}),
        };
    }
    return { errorMessage: typeof result === "string" ? result : undefined };
};
/** The one-line detail a failure's message ends with. */
export const describeFailure = (init) => {
    if (init.crash)
        return init.crash.message;
    if (init.functionError)
        return `${init.functionError.errorType ?? "FunctionError"}: ${init.functionError.errorMessage ?? "the function failed"}`;
    if (init.errorMessage !== undefined) {
        const content = init.errorMessage?.content;
        if (typeof content === "string")
            return content;
        if (typeof init.errorMessage === "string")
            return init.errorMessage;
        try {
            return JSON.stringify(init.errorMessage);
        }
        catch {
            return String(init.errorMessage);
        }
    }
    if (init.reason === 'validation')
        return "the callee rejected the input";
    if (init.reason === 'versionExpired')
        return "the callee answered versionExpired";
    if (init.reason === 'sessionExpired')
        return "the callee answered sessionExpired";
    if (init.reason === 'notAuthorized')
        return "the callee answered notAuthorized";
    if (init.cause instanceof Error)
        return init.cause.message;
    return init.status !== undefined ? `HTTP ${init.status}` : "no answer";
};

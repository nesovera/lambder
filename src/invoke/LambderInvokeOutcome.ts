/**
 * What an invoke call reports: the failure reasons, the outcome union, the
 * error api() throws, and the pure functions that read a failure (what a
 * rejected delivery means, what Lambda's error payload says, the one-line
 * detail an error message ends with).
 *
 * Kept apart from LambderInvokeCaller, as shared/wire/LambderApiOutcome.ts is
 * kept apart from the browser caller: this is the vocabulary a CALLER of the
 * caller reads, and a site that only annotates an outcome or narrows an error
 * should not have to read the whole class to find it. None of these functions
 * touch the caller's state.
 */

import type { LambderApiEnvelopeBody } from "../shared/wire/LambderApiContract.js";
import type { LambderApiFailureReason, LambderValidationError } from "../shared/wire/LambderApiOutcome.js";
import { isLambderTransportFailure } from "../shared/transport/LambderApiTransport.js";
import type { LambderCrashDetail } from "../shared/wire/LambderCrashDetail.js";
import type { LambderAppRefusalMessage } from "../shared/wire/LambderApiRefusal.js";

export type LambderInvokeFailureReason =
    | LambderApiFailureReason
    | 'crash'            // Lambda reported a FunctionError: the callee failed outside the framework (init, timeout, memory)
    | 'protocol'         // the answer is not a Lambda HTTP response object, or its compressed body could not be restored
    | 'payloadTooLarge'; // refused before sending: the event exceeds the invoke cap

/** Lambda's own error payload for a FunctionError invocation. */
export type LambderInvokeFunctionError = { errorType?: string; errorMessage?: string; trace?: string[] };

/** What every invoke failure carries, whatever went wrong. */
type LambderInvokeFailureFields = {
    ok: false;
    /** HTTP status, when the callee answered. */
    status?: number;
    /** Envelope errorMessage, when the callee provided one: always the message object, a plain string having been read as one (refusalMessageOf). */
    errorMessage?: LambderAppRefusalMessage;
    /** Seconds to wait before retrying, from the answer's Retry-After header. */
    retryAfterSeconds?: number;
    /** Always present: the error api() throws for this failure, with the callee's error as its cause when one is known. */
    error: LambderInvokeError;
    /** The answer's logList; empty when no envelope came back. */
    logList: unknown[];
    /** The answer's Set-Cookie values; empty when no answer came back. */
    cookies: string[];
};

/** HTTP 422: the callee rejected the input against the API's schema. Always carries the issues. */
export type LambderInvokeValidationFailure = LambderInvokeFailureFields & {
    reason: 'validation';
    zodError: LambderValidationError;
};

/** Lambda reported a FunctionError: the callee failed outside the framework (an init failure, a timeout, out of memory). Always carries the runtime's error payload. */
export type LambderInvokeCrashFailure = LambderInvokeFailureFields & {
    reason: 'crash';
    functionError: LambderInvokeFunctionError;
};

/** Refused before sending: the serialized event is over the invoke cap. Always carries its size. */
export type LambderInvokePayloadTooLargeFailure = LambderInvokeFailureFields & {
    reason: 'payloadTooLarge';
    /** The event's byte size, so a caller can say by how much it is over. */
    bytes: number;
};

/** The callee answered, and the envelope itself says the call is refused. Always carries that envelope, and an `errorMessage` refusal always carries its message. */
export type LambderInvokeEnvelopeFailure = LambderInvokeFailureFields & {
    response: LambderApiEnvelopeBody<any>;
    /** The callee's crash detail, when its global error handler sent one (the envelope's `crash` field). */
    crash?: LambderCrashDetail;
} & (
    | { reason: 'versionExpired' | 'sessionExpired' | 'notAuthorized' }
    | { reason: 'errorMessage'; errorMessage: LambderAppRefusalMessage }
);

/**
 * Nothing usable came back: the invoke never arrived or was given up on, the
 * Lambda service answered instead of the callee, the callee answered 5xx, or
 * something around the call threw. A 5xx carries `response` when the callee
 * answered with Lambder's own envelope, which is how a crash detail and a
 * logList arrive with it.
 */
export type LambderInvokeDeliveryFailure = LambderInvokeFailureFields & {
    reason: 'network' | 'timeout' | 'server' | 'protocol' | 'unknown';
    response?: LambderApiEnvelopeBody<any>;
    /** The callee's crash detail, when its global error handler sent one (the envelope's `crash` field). */
    crash?: LambderCrashDetail;
};

/**
 * A failed invoke, discriminated by `reason` so narrowing to a reason narrows
 * to what it carries: `zodError` after `validation`, `functionError` after
 * `crash`, `bytes` after `payloadTooLarge`, `response` after an envelope
 * reason, with no optional chain or `!` for a guaranteed field. The browser
 * caller's LambderApiOutcome is discriminated the same way.
 *
 * `error`, `logList` and `cookies` are on every arm, and `status`,
 * `errorMessage` and `retryAfterSeconds` are there whenever an answer came
 * back to read them from.
 */
export type LambderInvokeFailure =
    | LambderInvokeValidationFailure
    | LambderInvokeCrashFailure
    | LambderInvokePayloadTooLargeFailure
    | LambderInvokeEnvelopeFailure
    | LambderInvokeDeliveryFailure;

export type LambderInvokeOutcome<T> =
    | {
        ok: true;
        payload: T;
        response: LambderApiEnvelopeBody<T>;
        logList: unknown[];
        /**
         * The answer's Set-Cookie values. A caller carrying a user's session
         * is the browser for that call: a callee that rotated or cleared the
         * session cookies says so here, and a caller that ignores them keeps
         * sending the old token. See reissueSession() on the callee for the
         * tokens themselves.
         */
        cookies: string[];
    }
    | LambderInvokeFailure;

export type LambderInvokeErrorInit = {
    message: string;
    reason: LambderInvokeFailureReason;
    apiName: string;
    functionName: string;
    status?: number;
    errorMessage?: LambderAppRefusalMessage;
    crash?: LambderCrashDetail;
    functionError?: LambderInvokeFunctionError;
    logList: unknown[];
    zodError?: LambderValidationError;
    retryAfterSeconds?: number;
    bytes?: number;
    cause?: unknown;
};

/**
 * What api() throws. Its message names the function, the API and the reason,
 * so an error reporter that fingerprints on the message groups one broken
 * API into one row; its cause is the callee's own error rebuilt from the
 * crash detail (or Lambda's FunctionError, or the SDK's rejection), so a
 * reporter that walks causes stores the callee's stack.
 */
export class LambderInvokeError extends Error {
    /** Brand for detection across duplicate lambder installs, like LambderApiRefusal. */
    readonly isLambderInvokeError = true;
    readonly reason: LambderInvokeFailureReason;
    readonly apiName: string;
    readonly functionName: string;
    readonly status?: number;
    readonly errorMessage?: LambderAppRefusalMessage;
    readonly crash?: LambderCrashDetail;
    readonly functionError?: LambderInvokeFunctionError;
    readonly logList: unknown[];
    readonly zodError?: LambderValidationError;
    readonly retryAfterSeconds?: number;
    readonly bytes?: number;
    /** The full failure outcome; it carries this error and this error carries it. */
    outcome!: LambderInvokeFailure;

    constructor(init: LambderInvokeErrorInit){
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
export const isLambderInvokeError = (err: unknown): err is LambderInvokeError =>
    err instanceof Error && (err as LambderInvokeError).isLambderInvokeError === true;

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
 * failure is a plain Error or TypeError with neither. A service exception is
 * a permission, wiring or size fault to fix; calling it `network` would send
 * the reader to check their connection instead.
 */
export const classifyDeliveryFailure = (error: Error): 'network' | 'protocol' => {
    if(isLambderTransportFailure(error)) return error.reason;
    const fault = (error as { $fault?: unknown }).$fault;
    if(fault === "client" || fault === "server") return 'protocol';
    return error.name.endsWith("Exception") ? 'protocol' : 'network';
};

/** Lambda's error payload as an Error, with the callee's own name and trace. */
export const errorFromFunctionError = (functionError: LambderInvokeFunctionError): Error => {
    const error = new Error(functionError.errorMessage ?? "the function failed");
    error.name = functionError.errorType ?? "FunctionError";
    if(functionError.trace?.length) error.stack = functionError.trace.join("\n");
    return error;
};

/** Lambda's error payload as it actually arrives: an object with the three fields, or whatever else the runtime sent. */
export const parseFunctionError = (result: unknown): LambderInvokeFunctionError => {
    if(result && typeof result === "object"){
        const { errorType, errorMessage, trace } = result as Record<string, unknown>;
        return {
            ...(typeof errorType === "string" ? { errorType } : {}),
            ...(typeof errorMessage === "string" ? { errorMessage } : {}),
            ...(Array.isArray(trace) ? { trace: trace.map(String) } : {}),
        };
    }
    return { errorMessage: typeof result === "string" ? result : undefined };
};

/** The one-line detail a failure's message ends with. */
export const describeFailure = (init: Omit<LambderInvokeErrorInit, "message" | "apiName" | "functionName" | "logList">): string => {
    if(init.crash) return init.crash.message;
    if(init.functionError) return `${init.functionError.errorType ?? "FunctionError"}: ${init.functionError.errorMessage ?? "the function failed"}`;
    if(init.errorMessage !== undefined) return init.errorMessage.content;
    if(init.reason === 'validation') return "the callee rejected the input";
    if(init.reason === 'versionExpired') return "the callee answered versionExpired";
    if(init.reason === 'sessionExpired') return "the callee answered sessionExpired";
    if(init.reason === 'notAuthorized') return "the callee answered notAuthorized";
    if(init.cause instanceof Error) return init.cause.message;
    return init.status !== undefined ? `HTTP ${init.status}` : "no answer";
};

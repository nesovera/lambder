import type { LambderHttpStatusCode } from "./LambderHttpStatus.js";

export type LambderApiRefusalOptions = {
    /**
     * User-facing failure detail placed on the API envelope's `refusal`
     * field: a refusal message (`{ type: "warning", content: "..." }`, with
     * an app's own `code`) or a plain string, which becomes an "error"
     * message with that content. Defaults to the error message, so a bare
     * `throw new LambderApiRefusal("...")` is still visible to the client.
     */
    refusal?: LambderUncheckedRefusalMessage | string;
    /** Sets the envelope's `notAuthorized` flag (routed to the caller's notAuthorizedHandler). */
    notAuthorized?: boolean;
    /** Sets the envelope's `sessionExpired` flag (the caller clears session cookies and calls sessionExpiredHandler); on an API call, the server also ends the session the call held. */
    sessionExpired?: boolean;
    /**
     * HTTP status of the refusal response. Default 200: the envelope is the
     * semantic channel. Avoid 5xx (LambderCaller treats those as crashes) and
     * 422 (reserved for input validation).
     */
    statusCode?: LambderHttpStatusCode;
    /** Extra response headers on the refusal (e.g. Retry-After on a rate limit). */
    headers?: Record<string, string>;
    /** Underlying cause, preserved on the standard Error `cause` property. */
    cause?: unknown;
};

/**
 * A typed refusal: "this request is denied/invalid" as opposed to "the server
 * crashed". Throw it from anywhere in an API call's call stack (handlers,
 * hooks, guards or nested helpers) and the render pipeline maps it onto the
 * structured API envelope (its refusal, notAuthorized and
 * sessionExpired) instead of routing it through setGlobalErrorHandler, so refusals never reach crash
 * logging and clients receive a parseable response.
 *
 * Thrown outside an API call (e.g. in a route handler) it behaves like any
 * other error: global error handler, then the default 500.
 *
 * Isomorphic and dependency-free, so shared code (validators, permission
 * checks) used by both server and browser builds may throw it; in the
 * browser it is just an Error.
 */
export class LambderApiRefusal extends Error {
    /**
     * Brand for detection across duplicate lambder installs: when two copies
     * of the package coexist in one bundle, `instanceof LambderApiRefusal` fails
     * across them while this marker does not. The pipeline checks the brand.
     */
    readonly isLambderApiRefusal = true;

    /** What the envelope's refusal carries: always a message object, a plain string given to the options made into one. */
    readonly refusal: LambderUncheckedRefusalMessage;
    readonly notAuthorized?: boolean;
    readonly sessionExpired?: boolean;
    readonly statusCode?: LambderHttpStatusCode;
    readonly headers?: Record<string, string>;

    constructor(message: string, options: LambderApiRefusalOptions = {}){
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "LambderApiRefusal";
        this.refusal = refusalMessageOf(options.refusal ?? message);
        this.notAuthorized = options.notAuthorized;
        this.sessionExpired = options.sessionExpired;
        this.statusCode = options.statusCode;
        this.headers = options.headers;
    }
}

/** Brand-based type guard (see LambderApiRefusal.isLambderApiRefusal). */
export const isLambderApiRefusal = (err: unknown): err is LambderApiRefusal =>
    err instanceof Error && (err as LambderApiRefusal).isLambderApiRefusal === true;

/** What every refusal message carries, whatever its code. */
type LambderRefusalMessageFields = {
    /** Rendering intent for the client: how loud to be about it. */
    type: "warning" | "error" | "info";
    /** Optional heading shown above the content. */
    title?: string;
    /**
     * The human-readable text: what a client shows when it has nothing better.
     * A client that translates reads the code and the data instead, and falls
     * back to this for a code it does not know.
     */
    content: string;
};

/**
 * A refusal no app declared: one the framework wrote itself (a
 * LambderRefusalCode), or an app's `refuse("...")` without a code. It never
 * carries data.
 */
export type LambderPlainRefusalMessage = LambderRefusalMessageFields & {
    code?: LambderRefusalCode;
    data?: undefined;
};

/**
 * One declared code's message: the code, and its data when the code declares
 * data. TDeclaration is the code's value in a contract entry's `refusals`:
 * `{ data: D }` or `{}`.
 */
type LambderDeclaredRefusalMessage<TCode extends string, TDeclaration> =
    LambderRefusalMessageFields & { code: TCode }
    & (TDeclaration extends { data: infer TData } ? { data: TData } : { data?: undefined });

/**
 * The refusal message a reader receives, discriminated by `code`.
 *
 * TRefusals maps each code the endpoint declares to its contract value
 * (`{ data: D }` or `{}`; see LambderContractRefusalsOf). Every declared code
 * is one arm, carrying its own data type, and the framework's codes and the
 * uncoded refusal are one more arm with no data. A `switch (message.code)`
 * therefore narrows `data` in each case, and a `default: never` holds: the
 * server refuses to send a code the endpoint did not declare (see
 * LambderApiRefusalValidationError), so no other code can arrive.
 *
 * Left without an argument it is the framework's own vocabulary alone.
 */
export type LambderRefusalMessage<TRefusals = {}> =
    0 extends 1 & TRefusals ? LambderUncheckedRefusalMessage
    : LambderPlainRefusalMessage
    | { [TCode in keyof TRefusals & string]: LambderDeclaredRefusalMessage<TCode, TRefusals[TCode]> }[keyof TRefusals & string];

/**
 * The refusal shape an app writes, and the widest a reader can be handed:
 * any code (the framework's still autocomplete) and any data. What
 * LambderApiRefusal carries and refusalMessageOf reads; a reader that knows
 * the endpoint reads the narrower LambderRefusalMessage instead.
 */
export type LambderUncheckedRefusalMessage = LambderRefusalMessageFields & {
    code?: LambderRefusalCode | (string & {});
    data?: unknown;
};

const REFUSAL_MESSAGE_TYPES: readonly string[] = ["warning", "error", "info"] satisfies LambderRefusalMessage["type"][];

/**
 * An refusal as the one shape a reader handles: a plain string becomes
 * an "error" message with that content, and a value that is not a message
 * at all becomes one describing it. The envelope writer applies it, so a
 * Lambder server only ever sends the object. A reader applies it too,
 * because what it reads is wire input no server vouches for: a hand-built
 * mock answer (an MSW handler, a test double) or a proxy that wrote its own
 * body can put anything there.
 */
export const refusalMessageOf = (message: unknown): LambderUncheckedRefusalMessage => {
    if(message !== null && typeof message === "object" && typeof (message as { content?: unknown }).content === "string"){
        const candidate = message as LambderUncheckedRefusalMessage;
        return REFUSAL_MESSAGE_TYPES.includes(candidate.type) ? candidate : { ...candidate, type: "error" };
    }
    if(typeof message === "string") return { type: "error", content: message };
    let content: string;
    try { content = JSON.stringify(message) ?? String(message); } catch { content = String(message); }
    return { type: "error", content };
};

/**
 * Codes the framework stamps on the refusals it authors itself, under the
 * reserved `lambder/` prefix so app codes never collide. Compare against
 * these constants on the client (exported from `lambder/client` too) rather
 * than retyping the strings.
 */
export const LAMBDER_REFUSAL_CODES = {
    /** A rate-limit policy refused (429). A policy's own message carries it. */
    rateLimited: "lambder/rate-limited",
    /** The original of an idempotent request is still processing (409). */
    duplicateInFlight: "lambder/duplicate-in-flight",
    /** The idempotencyKey was already used for a request with a different payload (409). */
    idempotencyKeyReused: "lambder/idempotency-key-reused",
    /** The idempotencyKey is malformed (400). */
    invalidIdempotencyKey: "lambder/invalid-idempotency-key",
    /** No API is registered under the requested name. */
    apiNotFound: "lambder/api-not-found",
    /** The request's compressed payload is malformed or over the size limit (400). */
    invalidRequestPayload: "lambder/invalid-request-payload",
    /** Only the mock runtime emits it: the endpoint is registered as not mocked, with a reason. */
    notMocked: "lambder/not-mocked",
    /** An upload bucket would not sign a ticket for a file with no bytes. */
    uploadEmpty: "lambder/upload-empty",
    /** An upload bucket would not sign a ticket for a content type the rule does not accept. */
    uploadTypeRejected: "lambder/upload-type-rejected",
    /** An upload bucket would not sign a ticket for a file larger than the rule accepts. */
    uploadTooLarge: "lambder/upload-too-large",
} as const;
export type LambderRefusalCode = (typeof LAMBDER_REFUSAL_CODES)[keyof typeof LAMBDER_REFUSAL_CODES];

const FRAMEWORK_REFUSAL_CODES: ReadonlySet<string> = new Set(Object.values(LAMBDER_REFUSAL_CODES));

/** Whether a code is one the framework stamps on its own refusals. */
export const isLambderRefusalCode = (code: unknown): code is LambderRefusalCode =>
    typeof code === "string" && FRAMEWORK_REFUSAL_CODES.has(code);

export type LambderRefuseOptions = {
    /** Rendering intent for the client's refusalHandler. Default: "warning". */
    type?: LambderRefusalMessage["type"];
    /**
     * Machine-readable identity of the refusal, for clients to branch and
     * translate on: a code the endpoint declares in its `refusals` option (or
     * through one of its guards). A code it does not declare is a crash, not
     * a refusal; see LambderApiRefusalValidationError.
     */
    code?: string;
    /**
     * The code's data, when the code declares data: parsed through the
     * declared schema before it is sent, as an output is. A refusal without
     * a declared code carries none.
     */
    data?: unknown;
    /** Optional heading shown above the content. */
    title?: string;
    /** Sets the envelope's notAuthorized flag (routed to the caller's notAuthorizedHandler). A declared code's flag is its declaration's, and a refusal with such a code that sets it here is a crash. */
    notAuthorized?: boolean;
    /** Sets the envelope's sessionExpired flag, and the server ends the session the call held. Not for a refusal with a declared code, whose flags are its declaration's. */
    sessionExpired?: boolean;
    /** HTTP status of the refusal. Default 200; avoid 5xx (caller treats as crash) and 422 (reserved for validation). A declared code's status is its declaration's, and a refusal with such a code that sets one here is a crash. */
    statusCode?: LambderHttpStatusCode;
    /** Extra response headers on the refusal (e.g. Retry-After). */
    headers?: Record<string, string>;
    /** Underlying cause, preserved on the Error cause property. */
    cause?: unknown;
};

/**
 * Refuse the current API call: a routine business "no" (not found, invalid
 * input, not allowed) with a user-facing message. Throws a LambderApiRefusal
 * carrying the standard LambderRefusalMessage shape, so the pipeline maps it
 * onto the structured envelope instead of a 500, and crash logging never
 * sees it. Callable from anywhere in the call stack: handlers, hooks,
 * guards, shared helpers with no resolver access.
 *
 * The const carries the annotation so TypeScript applies never-return
 * control-flow narrowing at call sites (`if (!row) refuse(...)` implies
 * `row` is defined afterwards).
 *
 * Its `code` and `data` are checked when the refusal is rendered, against the
 * endpoint it answers. Inside an API handler, `ctx.refuse` takes the same
 * arguments typed to that endpoint's declared codes (LambderDeclaredRefuse).
 */
export const refuse: (content: string, options?: LambderRefuseOptions) => never = (content, options = {}) => {
    throw new LambderApiRefusal(content, {
        refusal: {
            type: options.type ?? "warning",
            ...(options.code !== undefined ? { code: options.code } : {}),
            ...(options.title !== undefined ? { title: options.title } : {}),
            content,
            ...(options.data !== undefined ? { data: options.data } : {}),
        } satisfies LambderUncheckedRefusalMessage,
        notAuthorized: options.notAuthorized,
        sessionExpired: options.sessionExpired,
        statusCode: options.statusCode,
        headers: options.headers,
        cause: options.cause,
    });
};

/** refuse()'s options other than the refusal's identity. */
type LambderRefuseFlagOptions = Omit<LambderRefuseOptions, "code" | "data">;

/** What a raise site of a declared code still chooses: the code's declaration owns its status and its flags. */
type LambderDeclaredCodeOptions = Omit<LambderRefuseFlagOptions, "statusCode" | "notAuthorized" | "sessionExpired">;

/**
 * refuse()'s options where the endpoint's declarations are known: `code` is
 * one of TRefusals' codes, `data` is required when that code declares data
 * and absent otherwise, and the status and flags are the code's
 * declaration's, so they cannot be set here. TRefusals maps each code to
 * `{ data: D }` or `{}`, D being what the handler hands over (the schema's
 * input form on the server, the wire form in the mock). A discriminated
 * union rather than a generic over the code, so a code widened to a union
 * cannot loosen `data`. With TCodeRequired (declareRefusals's requireCodes)
 * the uncoded arm is gone: every refusal names a code.
 */
export type LambderDeclaredRefuseOptions<TRefusals, TCodeRequired extends boolean = false> =
    | (TCodeRequired extends true ? never : LambderRefuseFlagOptions & { code?: undefined; data?: undefined })
    | { [TCode in keyof TRefusals & string]: LambderDeclaredCodeOptions & { code: TCode } & (TRefusals[TCode] extends { data: infer TData } ? { data: TData } : { data?: undefined }) }[keyof TRefusals & string];

/**
 * The refuse an API handler's context carries, typed to the endpoint's
 * declared codes (a guard's to the guard's, the init's to the whole
 * vocabulary). It throws what refuse() throws. Where the app requires codes,
 * the options are not optional: a refusal is a code.
 *
 * TypeScript narrows after a never-returning call only when every name in it
 * carries an explicit annotation, which a handler's contextually typed `ctx`
 * does not. Where the code after it relies on the refusal, write
 * `return ctx.refuse(...)`; the free refuse() narrows on its own.
 */
export type LambderDeclaredRefuse<TRefusals, TCodeRequired extends boolean = false> = TCodeRequired extends true
    ? (content: string, options: LambderDeclaredRefuseOptions<TRefusals, true>) => never
    : (content: string, options?: LambderDeclaredRefuseOptions<TRefusals, false>) => never;

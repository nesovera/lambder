import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
import { type LambderCookieOptions, type LambderClearCookieOptions } from "../shared/wire/LambderCookie.js";
/**
 * The context the API core needs from whoever runs it. The server's render
 * context and the mock runtime's handler context both extend it; the
 * pipeline, policy engines and session controller touch nothing else, so
 * they never learn which adapter they run under.
 *
 * - `session` is set by the pipeline on session APIs (and by the session
 *   controller when a handler creates or ends one).
 * - `guardData` receives the return values of the guards that ran.
 * - `responseHeaders` collects headers written during the call, applied
 *   onto the answer by the pipeline.
 * - `logList` collects entries for the envelope's logList channel
 *   (`ctx.logList.push(entry)` from a handler).
 */
export type LambderApiCallContext<TSessionData = any> = {
    session: LambderSessionRecord<TSessionData> | null;
    guardData: Record<string, unknown>;
    responseHeaders: LambderAnswerHeaders;
    logList: unknown[];
};
/** A fresh call context: no session, no guard data, nothing pending. */
export declare const createApiCallContext: <TSessionData = any>() => LambderApiCallContext<TSessionData>;
/**
 * What a handler writes onto its answer beside the body: headers and cookies,
 * collected on `responseHeaders` and applied to whatever answer the request
 * ends with. On every context a handler receives, the server's and the
 * mock's alike, since an API handler returns its output and has no response
 * builder to write them on.
 */
export type LambderResponseTools = {
    /** Replaces a response header. */
    setResponseHeader(key: string, value: string | string[]): void;
    /** Appends a response header value (repeatable for one key). */
    addResponseHeader(key: string, value: string): void;
    /**
     * Adds a Set-Cookie header. A function-form `domain` is resolved against
     * the request host. Defaults: Path=/, SameSite=Lax, Secure, not HttpOnly,
     * browser-session lifetime.
     */
    setCookie(name: string, value: string, options?: LambderCookieOptions): void;
    /**
     * Adds a Set-Cookie header that deletes the cookie. Pass the `domain` and
     * `path` it was set with: a cookie's identity is (name, domain, path), and
     * a deletion under another scope deletes nothing.
     */
    clearCookie(name: string, options?: LambderClearCookieOptions): void;
};
/** The response tools of one context, writing into its own responseHeaders; `host` resolves a function-form cookie domain. */
export declare const responseToolsOf: (ctx: {
    responseHeaders: LambderAnswerHeaders;
}, host: string) => LambderResponseTools;
/**
 * Binds an adapter's tools onto one call context: `getters` run when read
 * (`ctx.sessionController` is built over the object it was read from),
 * `methods` are plain functions, and each is non-enumerable and bound to that
 * object.
 *
 * Non-enumerable keeps a tool on the right object: a copy of the context (a
 * server hook's `{ ...ctx, extra }`) carries none of them, rather than tools
 * still bound to the original and its session. The adapter binds them again
 * on a copy it continues with; configurable lets that replace them.
 */
export declare const bindCallTools: (ctx: object, tools: {
    getters?: Record<string, () => unknown>;
    methods?: Record<string, (...args: never[]) => unknown>;
}) => void;
/**
 * What one call recorded about itself while it ran, in order. Written as the
 * call goes rather than assembled from each step's return, so a call refused
 * partway still reports the guards that had already run (the mock's call log
 * shows them for exactly the calls a developer is debugging).
 */
export type LambderApiCallTrace = {
    /** The guards that ran, in order, including on a call that a later one refused. */
    guardsRun: string[];
    /** True when a stored idempotent answer was replayed and no handler ran. */
    replayed: boolean;
};

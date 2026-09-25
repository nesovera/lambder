import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";

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
 *   (`res.logToApiResponse` on the server).
 */
export type LambderApiCallContext<TSessionData = any> = {
    session: LambderSessionRecord<TSessionData> | null;
    guardData: Record<string, unknown>;
    responseHeaders: LambderAnswerHeaders;
    logList: unknown[];
};

/** A fresh call context: no session, no guard data, nothing pending. */
export const createApiCallContext = <TSessionData = any>(): LambderApiCallContext<TSessionData> => ({
    session: null,
    // No prototype: guard names are the app's to choose, and on a plain
    // object a guard named "toString" or "constructor" would read back as an
    // inherited function to a handler checking whether that guard returned
    // anything.
    guardData: Object.create(null) as Record<string, unknown>,
    responseHeaders: new LambderAnswerHeaders(),
    logList: [],
});

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
export const bindCallTools = (
    ctx: object,
    tools: { getters?: Record<string, () => unknown>; methods?: Record<string, (...args: never[]) => unknown> },
): void => {
    for(const [name, get] of Object.entries(tools.getters ?? {})){
        Object.defineProperty(ctx, name, { get, enumerable: false, configurable: true });
    }
    for(const [name, value] of Object.entries(tools.methods ?? {})){
        Object.defineProperty(ctx, name, { value, enumerable: false, configurable: true, writable: true });
    }
};

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

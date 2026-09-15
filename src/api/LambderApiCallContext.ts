import type { LambderSessionRecord } from "../shared/contracts/LambderSessionStore.js";
import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";

/**
 * The context the API core needs from whoever runs it. The server's render
 * context and the mock runtime's handler context both extend it; the
 * pipeline, the policy engines and the session controller read and write
 * nothing else on a context, so they never learn which adapter they run
 * under.
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
    // No prototype, for the reason the guard and policy registries are Maps:
    // guard names are the app's to choose, and on a plain object a guard
    // named "toString" or "constructor" reads back as an inherited function
    // for a handler that only wanted to know whether the guard returned
    // anything.
    guardData: Object.create(null) as Record<string, unknown>,
    responseHeaders: new LambderAnswerHeaders(),
    logList: [],
});

/**
 * What one call recorded about itself while it ran, in the order things
 * happened. Written as the call goes rather than assembled from what each
 * step returned, so a refusal partway through still reports the guards that
 * had already run: the mock's call log shows exactly the calls a developer is
 * looking at when something denied them.
 */
export type LambderApiCallTrace = {
    /** The guards that ran, in order, including on a call that a later one refused. */
    guardsRun: string[];
    /** True when a stored idempotent answer was replayed and no handler ran. */
    replayed: boolean;
};

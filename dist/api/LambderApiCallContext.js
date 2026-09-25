import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
/** A fresh call context: no session, no guard data, nothing pending. */
export const createApiCallContext = () => ({
    session: null,
    // No prototype: guard names are the app's to choose, and on a plain
    // object a guard named "toString" or "constructor" would read back as an
    // inherited function to a handler checking whether that guard returned
    // anything.
    guardData: Object.create(null),
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
export const bindCallTools = (ctx, tools) => {
    for (const [name, get] of Object.entries(tools.getters ?? {})) {
        Object.defineProperty(ctx, name, { get, enumerable: false, configurable: true });
    }
    for (const [name, value] of Object.entries(tools.methods ?? {})) {
        Object.defineProperty(ctx, name, { value, enumerable: false, configurable: true, writable: true });
    }
};

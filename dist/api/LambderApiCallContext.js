import { LambderAnswerHeaders } from "../shared/wire/LambderAnswerHeaders.js";
/** A fresh call context: no session, no guard data, nothing pending. */
export const createApiCallContext = () => ({
    session: null,
    // No prototype, for the reason the guard and policy registries are Maps:
    // guard names are the app's to choose, and on a plain object a guard
    // named "toString" or "constructor" reads back as an inherited function
    // for a handler that only wanted to know whether the guard returned
    // anything.
    guardData: Object.create(null),
    responseHeaders: new LambderAnswerHeaders(),
    logList: [],
});

/**
 * The mark on an error that has already been reported, so the crash
 * reporting it reaches next does not report it a second time.
 *
 * LambderInvokeCaller marks the error of a failure its onFailure handler
 * took: api() then throws that same error, and an app that lets it propagate
 * hands it to the instance's crash reporting, which skips a marked error and
 * still answers it as a crash. The two ends live in invoke/ and core/, which
 * may not import each other, so the mark sits below both.
 *
 * A key from the global symbol registry rather than a WeakSet kept here: a
 * caller and a server from two copies of the package (an app's and a
 * dependency's) agree on it, as they do on every Lambder brand. It is set
 * non-enumerable, so it never shows up in a serialized error or a log line.
 */
const LAMBDER_ERROR_REPORTED: unique symbol = Symbol.for("lambder.errorReported");

/** Marks an error as reported where it arose. */
export const markErrorReported = (error: Error): void => {
    Object.defineProperty(error, LAMBDER_ERROR_REPORTED, { value: true, configurable: true });
};

/** Whether an error was marked as reported where it arose. Read by brand, so it holds across realms and package copies. */
export const isErrorReported = (error: unknown): boolean =>
    typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[LAMBDER_ERROR_REPORTED] === true;

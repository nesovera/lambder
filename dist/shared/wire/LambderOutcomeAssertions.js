/**
 * Two assertions over a call's outcome, for tests.
 *
 * An outcome is a discriminated union, so a test that expects a refusal must
 * narrow before it can read what the refusal carries: check `ok`, branch on
 * it, check `reason`. Written by hand, the failing case prints "expected
 * false to be true" and says nothing about what came back, the one thing
 * worth knowing when a call that should have been refused went through, or
 * crashed instead.
 *
 * These narrow through an `asserts` signature, so the lines after one read
 * the arm it proved, and they throw a plain Error naming what the outcome
 * was. No test runner is imported: the same two functions serve vitest, jest
 * and node:test, from `lambder/testing` over a real server and from
 * `lambder/mock` over a mock one. Pure and dependency-free, like the outcome
 * vocabulary they read.
 *
 * Typed structurally over `ok` and `reason` rather than over
 * LambderApiOutcome, so a LambderInvokeOutcome, whose failure side names
 * other reasons, is narrowed by the same functions and a misspelled reason is
 * a compile error against whichever union was passed.
 */
const MAX_DESCRIBED_VALUE_LENGTH = 300;
/** A value as it can be printed in an assertion message: JSON, cut short, never throwing over a cyclic one. */
const describeValue = (value) => {
    let text;
    try {
        text = JSON.stringify(value) ?? String(value);
    }
    catch {
        text = String(value);
    }
    return text.length > MAX_DESCRIBED_VALUE_LENGTH ? `${text.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}...` : text;
};
/**
 * The error a failure carries, which becomes the cause of the assertion's
 * own: a test runner prints the chain, so an app that crashed under
 * `lambder/testing` shows the handler's stack under the failed assertion.
 */
const errorOf = (outcome) => {
    const error = outcome.error;
    return error instanceof Error ? error : undefined;
};
/** One line saying what an outcome was, for the message of an assertion it failed. */
const describeOutcome = (outcome) => {
    if (outcome.ok)
        return `a success carrying ${describeValue(outcome.payload)}`;
    const failure = outcome;
    const details = [];
    if (failure.status !== undefined)
        details.push(`status ${failure.status}`);
    if (failure.errorMessage !== undefined)
        details.push(`errorMessage ${describeValue(failure.errorMessage)}`);
    if (failure.zodError !== undefined)
        details.push(`zodError ${describeValue(failure.zodError.message)}`);
    // The error's own message, and its cause when it has one: an in-process
    // transport reports a handler that threw as a failure whose cause is
    // what actually threw, and that is the line a test author needs.
    if (failure.error instanceof Error) {
        const cause = failure.error.cause instanceof Error ? ` (cause: ${failure.error.cause.message})` : "";
        details.push(`error "${failure.error.message}"${cause}`);
    }
    return `a failure with reason "${failure.reason}"${details.length ? `, ${details.join(", ")}` : ""}`;
};
/**
 * Asserts that a call succeeded, and narrows the outcome to its success arm,
 * so `outcome.payload` reads directly on the next line.
 *
 * ```typescript
 * const outcome = await visitor.apiOutcome("order.create", { sku });
 * assertApiSuccess(outcome);
 * expect(outcome.payload?.orderId).toBeDefined();
 * ```
 */
export function assertApiSuccess(outcome) {
    if (!outcome.ok)
        throw new Error(`Expected the call to succeed, but it was ${describeOutcome(outcome)}.`, { cause: errorOf(outcome) });
}
/**
 * Asserts that a call failed, with the given reason when one is named, and
 * narrows the outcome to the arms that reason can be, so what it carries
 * (`zodError` after "validation", `response` after an envelope reason,
 * `error` after the rest) reads directly on the next line.
 *
 * ```typescript
 * assertApiFailure(await member.apiOutcome("org.delete", { id }), "notAuthorized");
 * assertApiFailure(await guest.apiOutcome("signup", form), "errorMessage", { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
 * ```
 */
export function assertApiFailure(outcome, reason, expected = {}) {
    const wanted = [
        reason !== undefined ? `reason "${String(reason)}"` : null,
        expected.code !== undefined ? `code "${expected.code}"` : null,
        expected.status !== undefined ? `status ${expected.status}` : null,
    ].filter((part) => part !== null).join(", ");
    const refuse = () => {
        throw new Error(`Expected the call to fail${wanted ? ` with ${wanted}` : ""}, but it was ${describeOutcome(outcome)}.`, { cause: errorOf(outcome) });
    };
    if (outcome.ok)
        return refuse();
    if (reason !== undefined && outcome.reason !== reason)
        return refuse();
    if (expected.code !== undefined) {
        // Only the structured errorMessage carries a code; a plain string has none to match.
        const errorMessage = outcome.errorMessage;
        const code = errorMessage && typeof errorMessage === "object" ? errorMessage.code : undefined;
        if (code !== expected.code)
            return refuse();
    }
    if (expected.status !== undefined && outcome.status !== expected.status)
        return refuse();
}

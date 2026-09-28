/**
 * Three assertions over a call's outcome, for tests.
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
 * was. No test runner is imported: the same functions serve vitest, jest
 * and node:test, from `lambder/testing` over a real server and from
 * `lambder/mock` over a mock one. Pure and dependency-free, like the outcome
 * vocabulary they read.
 *
 * Typed structurally over `ok` and `reason` rather than over
 * LambderApiOutcome, so a LambderInvokeOutcome, whose failure side names
 * other reasons, is narrowed by the same functions and a misspelled reason is
 * a compile error against whichever union was passed.
 */

/** What both callers' outcomes have in common: the discriminant, and a reason on the failure side. */
type LambderOutcomeShape = { ok: true } | { ok: false; reason: string };

/** Every reason the failure side of an outcome union can carry. */
type LambderFailureReasonOf<TOutcome> = TOutcome extends { ok: false; reason: infer TReason } ? TReason : never;

/**
 * The failure arms that can carry one of the given reasons, each narrowed to
 * it. Per arm rather than through Extract: one arm may carry several reasons
 * (`network`, `timeout`, `server` and `unknown` share theirs), and Extract
 * would drop that arm for any single one of them.
 */
type LambderFailureWithReason<TOutcome, TReason> = TOutcome extends { ok: false; reason: infer TArmReason }
    ? [TReason & TArmReason] extends [never] ? never : TOutcome & { reason: TReason & TArmReason }
    : never;

/** The refusal message a failure of this outcome union carries: the endpoint's, with its declared codes. */
type LambderRefusalMessageOf<TOutcome> = TOutcome extends { ok: false; refusal?: infer TMessage } ? TMessage : never;

/** Every code a failure of this outcome union can be refused with: the endpoint's declared codes and the framework's. */
type LambderRefusalCodeOf<TOutcome> = LambderRefusalMessageOf<TOutcome> extends infer TMessage
    ? TMessage extends { code?: infer TCode } ? Exclude<TCode, undefined> & string : never
    : never;

/**
 * The arm of a refusal message that carries code C: the declared code's own
 * arm, with its data. A framework code has no arm of its own (it shares the
 * uncoded one), and neither does any code of a message typed as any code, so
 * those are the message with the code pinned.
 */
type LambderRefusalWithCode<TMessage, TCode> =
    [Extract<TMessage, { code: TCode }>] extends [never] ? TMessage & { code: TCode } : Extract<TMessage, { code: TCode }>;

/** What else a failure is expected to carry, beside its reason. */
export type LambderExpectedFailure<TCode extends string = string> = {
    /** The refusal's machine-readable code (`refusal.code`): one the endpoint declares, or a LAMBDER_REFUSAL_CODES value. */
    code?: TCode;
    /** The HTTP status the answer came with. */
    status?: number;
};

const MAX_DESCRIBED_VALUE_LENGTH = 300;

/** A value as it can be printed in an assertion message: JSON, cut short, never throwing over a cyclic one. */
const describeValue = (value: unknown): string => {
    let text: string;
    try {
        text = JSON.stringify(value) ?? String(value);
    } catch {
        text = String(value);
    }
    return text.length > MAX_DESCRIBED_VALUE_LENGTH ? `${text.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}...` : text;
};

/**
 * The error a failure carries, which becomes the cause of the assertion's
 * own: a test runner prints the chain, so an app that crashed under
 * `lambder/testing` shows the handler's stack under the failed assertion.
 */
const errorOf = (outcome: LambderOutcomeShape): Error | undefined => {
    const error = (outcome as { error?: unknown }).error;
    return error instanceof Error ? error : undefined;
};

/** One line saying what an outcome was, for the message of an assertion it failed. */
const describeOutcome = (outcome: LambderOutcomeShape): string => {
    if(outcome.ok) return `a success carrying ${describeValue((outcome as { payload?: unknown }).payload)}`;
    const failure = outcome as { reason: string; status?: number; refusal?: unknown; error?: unknown; zodError?: { message?: unknown } };
    const details: string[] = [];
    if(failure.status !== undefined) details.push(`status ${failure.status}`);
    if(failure.refusal !== undefined) details.push(`refusal ${describeValue(failure.refusal)}`);
    if(failure.zodError !== undefined) details.push(`zodError ${describeValue(failure.zodError.message)}`);
    // The error's own message, and its cause when it has one: an in-process
    // transport reports a handler that threw as a failure whose cause is
    // what actually threw, and that is the line a test author needs.
    if(failure.error instanceof Error){
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
export function assertApiSuccess<TOutcome extends LambderOutcomeShape>(outcome: TOutcome): asserts outcome is Extract<TOutcome, { ok: true }> {
    if(!outcome.ok) throw new Error(`Expected the call to succeed, but it was ${describeOutcome(outcome)}.`, { cause: errorOf(outcome) });
}

/**
 * Asserts that a call failed, with the given reason when one is named, and
 * narrows the outcome to the arms that reason can be, so what it carries
 * (`zodError` after "validation", `response` after an envelope reason,
 * `error` after the rest) reads directly on the next line.
 *
 * ```typescript
 * assertApiFailure(await member.apiOutcome("org.delete", { id }), "notAuthorized");
 * assertApiFailure(await guest.apiOutcome("signup", form), "refusal", { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
 * ```
 */
export function assertApiFailure<TOutcome extends LambderOutcomeShape, TReason extends LambderFailureReasonOf<TOutcome> = LambderFailureReasonOf<TOutcome>>(
    outcome: TOutcome,
    reason?: TReason,
    expected: LambderExpectedFailure<LambderRefusalCodeOf<TOutcome>> = {},
): asserts outcome is LambderFailureWithReason<TOutcome, TReason> {
    const wanted = [
        reason !== undefined ? `reason "${String(reason)}"` : null,
        expected.code !== undefined ? `code "${expected.code}"` : null,
        expected.status !== undefined ? `status ${expected.status}` : null,
    ].filter((part) => part !== null).join(", ");
    const refuse = (): never => {
        throw new Error(`Expected the call to fail${wanted ? ` with ${wanted}` : ""}, but it was ${describeOutcome(outcome)}.`, { cause: errorOf(outcome) });
    };
    if(outcome.ok) return refuse();
    if(reason !== undefined && outcome.reason !== reason) return refuse();
    if(expected.code !== undefined){
        // Only the structured refusal carries a code; a plain string has none to match.
        const refusal = (outcome as { refusal?: unknown }).refusal;
        const code = refusal && typeof refusal === "object" ? (refusal as { code?: unknown }).code : undefined;
        if(code !== expected.code) return refuse();
    }
    if(expected.status !== undefined && (outcome as { status?: number }).status !== expected.status) return refuse();
}

/**
 * Asserts that a call was refused with the given code, whichever reason it
 * arrived under (a refusal flagged notAuthorized carries its code too), and
 * narrows the outcome's refusal to that code's message, so its `data`
 * reads with the type the code declares.
 *
 * ```typescript
 * const outcome = await visitor.apiOutcome("order.pay", { orderId });
 * assertApiRefusal(outcome, "wallet-short");
 * expect(outcome.refusal.data.available).toBe(1250);
 * ```
 *
 * The code is checked against the outcome's own codes, so one the endpoint
 * does not declare is a compile error rather than an assertion that can
 * never pass.
 */
// `const`: the constraint depends on TOutcome, and without it the code
// argument widens to that whole constraint instead of staying the literal
// passed, which would narrow to every declared code at once.
export function assertApiRefusal<TOutcome extends LambderOutcomeShape, const TCode extends LambderRefusalCodeOf<TOutcome>>(
    outcome: TOutcome,
    code: TCode,
): asserts outcome is Extract<TOutcome, { ok: false }> & { refusal: LambderRefusalWithCode<LambderRefusalMessageOf<TOutcome>, TCode> } {
    const refusal = outcome.ok ? undefined : (outcome as { refusal?: unknown }).refusal;
    const received = refusal && typeof refusal === "object" ? (refusal as { code?: unknown }).code : undefined;
    if(received !== code){
        throw new Error(`Expected the call to be refused with code "${code}", but it was ${describeOutcome(outcome)}.`, { cause: errorOf(outcome) });
    }
}

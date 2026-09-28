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
type LambderOutcomeShape = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** Every reason the failure side of an outcome union can carry. */
type LambderFailureReasonOf<TOutcome> = TOutcome extends {
    ok: false;
    reason: infer TReason;
} ? TReason : never;
/**
 * The failure arms that can carry one of the given reasons, each narrowed to
 * it. Per arm rather than through Extract: one arm may carry several reasons
 * (`network`, `timeout`, `server` and `unknown` share theirs), and Extract
 * would drop that arm for any single one of them.
 */
type LambderFailureWithReason<TOutcome, TReason> = TOutcome extends {
    ok: false;
    reason: infer TArmReason;
} ? [TReason & TArmReason] extends [never] ? never : TOutcome & {
    reason: TReason & TArmReason;
} : never;
/** The refusal message a failure of this outcome union carries: the endpoint's, with its declared codes. */
type LambderRefusalMessageOf<TOutcome> = TOutcome extends {
    ok: false;
    refusal?: infer TMessage;
} ? TMessage : never;
/** Every code a failure of this outcome union can be refused with: the endpoint's declared codes and the framework's. */
type LambderRefusalCodeOf<TOutcome> = LambderRefusalMessageOf<TOutcome> extends infer TMessage ? TMessage extends {
    code?: infer TCode;
} ? Exclude<TCode, undefined> & string : never : never;
/**
 * The arm of a refusal message that carries code C: the declared code's own
 * arm, with its data. A framework code has no arm of its own (it shares the
 * uncoded one), and neither does any code of a message typed as any code, so
 * those are the message with the code pinned.
 */
type LambderRefusalWithCode<TMessage, TCode> = [
    Extract<TMessage, {
        code: TCode;
    }>
] extends [never] ? TMessage & {
    code: TCode;
} : Extract<TMessage, {
    code: TCode;
}>;
/** What else a failure is expected to carry, beside its reason. */
export type LambderExpectedFailure<TCode extends string = string> = {
    /** The refusal's machine-readable code (`refusal.code`): one the endpoint declares, or a LAMBDER_REFUSAL_CODES value. */
    code?: TCode;
    /** The HTTP status the answer came with. */
    status?: number;
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
export declare function assertApiSuccess<TOutcome extends LambderOutcomeShape>(outcome: TOutcome): asserts outcome is Extract<TOutcome, {
    ok: true;
}>;
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
export declare function assertApiFailure<TOutcome extends LambderOutcomeShape, TReason extends LambderFailureReasonOf<TOutcome> = LambderFailureReasonOf<TOutcome>>(outcome: TOutcome, reason?: TReason, expected?: LambderExpectedFailure<LambderRefusalCodeOf<TOutcome>>): asserts outcome is LambderFailureWithReason<TOutcome, TReason>;
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
export declare function assertApiRefusal<TOutcome extends LambderOutcomeShape, const TCode extends LambderRefusalCodeOf<TOutcome>>(outcome: TOutcome, code: TCode): asserts outcome is Extract<TOutcome, {
    ok: false;
}> & {
    refusal: LambderRefusalWithCode<LambderRefusalMessageOf<TOutcome>, TCode>;
};
export {};

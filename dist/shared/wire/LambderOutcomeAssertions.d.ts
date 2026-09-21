/**
 * Two assertions over a call's outcome, for tests.
 *
 * An outcome is a discriminated union, so a test that expects a refusal has
 * to narrow before it can read what the refusal carries, and the narrowing is
 * the same three lines every time: check `ok`, branch on it, check `reason`.
 * Written by hand, the failing case prints "expected false to be true" and
 * says nothing about what actually came back, which is the one thing worth
 * knowing when a call that should have been refused went through, or crashed
 * instead.
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
/** What else a failure is expected to carry, beside its reason. */
export type LambderExpectedFailure = {
    /** The refusal's machine-readable code (`errorMessage.code`), e.g. a LAMBDER_REFUSAL_CODES value or the app's own. */
    code?: string;
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
 * assertApiFailure(await guest.apiOutcome("signup", form), "errorMessage", { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
 * ```
 */
export declare function assertApiFailure<TOutcome extends LambderOutcomeShape, TReason extends LambderFailureReasonOf<TOutcome> = LambderFailureReasonOf<TOutcome>>(outcome: TOutcome, reason?: TReason, expected?: LambderExpectedFailure): asserts outcome is LambderFailureWithReason<TOutcome, TReason>;
export {};

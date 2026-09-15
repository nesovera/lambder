/**
 * The checks every option that names a count, a size or a duration goes
 * through at creation, so a bad value is one wording and one predicate
 * everywhere rather than seven spellings of the same rule. `name` is the
 * option as the reader wrote it (`maxResponseBytes`, `session.ttlSeconds`),
 * so the error says which one to fix.
 */
/** A safe integer of one or more; returns it so the check reads as an assignment. */
export declare const assertPositiveInteger: (value: unknown, name: string) => number;
/** A safe integer of zero or more; returns it so the check reads as an assignment. */
export declare const assertNonNegativeInteger: (value: unknown, name: string) => number;
/**
 * A finite number at or above `minimum`, fractions included; returns it so
 * the check reads as an assignment. For the options that scale something
 * rather than count it, where 1.5 is a legitimate value.
 */
export declare const assertNumberAtLeast: (value: unknown, minimum: number, name: string) => number;

/**
 * The checks every option that names a count, a size or a duration goes
 * through at creation, so a bad value is one wording and one predicate
 * everywhere rather than seven spellings of the same rule. `name` is the
 * option as the reader wrote it (`maxResponseBytes`, `session.ttlSeconds`),
 * so the error says which one to fix.
 */

const describe = (value: unknown): string => typeof value === "string" ? JSON.stringify(value) : String(value);

/** A safe integer of one or more; returns it so the check reads as an assignment. */
export const assertPositiveInteger = (value: unknown, name: string): number => {
    if(typeof value !== "number" || !Number.isSafeInteger(value) || value < 1){
        throw new Error(`Lambder: ${name} must be a positive integer, got ${describe(value)}.`);
    }
    return value;
};

/** A safe integer of zero or more; returns it so the check reads as an assignment. */
export const assertNonNegativeInteger = (value: unknown, name: string): number => {
    if(typeof value !== "number" || !Number.isSafeInteger(value) || value < 0){
        throw new Error(`Lambder: ${name} must be a non-negative integer, got ${describe(value)}.`);
    }
    return value;
};

/**
 * A finite number at or above `minimum`, fractions included; returns it so
 * the check reads as an assignment. For the options that scale something
 * rather than count it, where 1.5 is a legitimate value.
 */
export const assertNumberAtLeast = (value: unknown, minimum: number, name: string): number => {
    if(typeof value !== "number" || !Number.isFinite(value) || value < minimum){
        throw new Error(`Lambder: ${name} must be a number of ${minimum} or more, got ${describe(value)}.`);
    }
    return value;
};

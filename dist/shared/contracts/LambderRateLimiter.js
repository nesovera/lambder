/**
 * The rate-limit vocabulary every part of Lambder shares: the fixed windows a
 * policy may cap, the policy shape, what an exceeded check reports, and the
 * one method the rate-limit engine asks of a limiter.
 *
 * Kept apart from the DynamoDB limiter on purpose. The engine needs only this
 * table, and importing it from the store would pull the DynamoDB SDK loader
 * into the engine's import graph, which is what kept the policy layer from
 * running anywhere but inside a Lambda. Pure and dependency-free, so the
 * mock runtime and the browser entry can resolve it.
 */
/**
 * The fixed windows a policy may cap, smallest first (the evaluation order),
 * with their length. The policy type derives from this table, so the two can
 * never drift.
 */
export const RATE_LIMIT_WINDOWS = [
    { key: "perMin", seconds: 60 },
    { key: "per10Min", seconds: 10 * 60 },
    { key: "perHour", seconds: 60 * 60 },
    { key: "perDay", seconds: 24 * 60 * 60 },
    { key: "perWeek", seconds: 7 * 24 * 60 * 60 },
    { key: "perMonth", seconds: 30 * 24 * 60 * 60 },
];

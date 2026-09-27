/*
 * What the store conformance suites register their cases with, and the clock
 * each case runs on.
 *
 * A suite is the set of rules one store interface promises, written once and
 * driven through every implementation: Lambder's own memory and DynamoDB
 * stores, and any store an app writes over its own database. The suites take
 * the test runner's `it` and `expect` rather than importing one, so they run
 * under vitest, jest, or any runner with a jest-style `expect`, and the
 * package depends on none of them.
 */
/** Where every case's clock starts: a fixed moment, so the records a case writes are the same on every run. */
export const CONFORMANCE_START_MILLIS = 1_700_000_000_000;
/** The clock of one case: `now` for the store, `set` for the case. */
export const conformanceClock = () => {
    let millis = CONFORMANCE_START_MILLIS;
    return {
        now: () => millis,
        set: (next) => { millis = next; },
    };
};

/** The runner's `it`: registers one case under a name. */
export type LambderConformanceIt = (name: string, run: () => Promise<void>) => unknown;
/** The part of a jest-style assertion the suites use, which vitest's and jest's `expect` both provide. */
export type LambderConformanceAssertion = {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: object): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeTruthy(): void;
    toHaveLength(length: number): void;
    toBeGreaterThan(value: number): void;
    not: {
        toBe(expected: unknown): void;
        toBeNull(): void;
    };
    rejects: {
        toThrow(): Promise<unknown>;
    };
    resolves: {
        toBeNull(): Promise<unknown>;
    };
};
/** The runner's `expect`. */
export type LambderConformanceExpect = (actual: unknown) => LambderConformanceAssertion;
/** The two things every suite takes from the runner. */
export type LambderConformanceRunner = {
    it: LambderConformanceIt;
    expect: LambderConformanceExpect;
};
/**
 * What a store factory is handed for one case: the clock the case moves, in
 * epoch milliseconds. A store that judges time itself (a memory store
 * expiring its entries) must read it from here; the system clock does not
 * move with it, so a store that read Date.now() behind its `now` option
 * would see time standing still and fail the expiry rules.
 */
export type LambderConformanceSetup = {
    now: () => number;
};
/** Where every case's clock starts: a fixed moment, so the records a case writes are the same on every run. */
export declare const CONFORMANCE_START_MILLIS = 1700000000000;
/** The clock of one case: `now` for the store, `set` for the case. */
export declare const conformanceClock: () => LambderConformanceSetup & {
    set(millis: number): void;
};

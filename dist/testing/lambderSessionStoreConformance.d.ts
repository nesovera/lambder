import type { LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import { type LambderConformanceRunner, type LambderConformanceSetup } from "./LambderConformanceRunner.js";
export type LambderSessionStoreConformanceOptions = LambderConformanceRunner & {
    /** A store holding no sessions, built for one case over the case's clock. */
    create: (setup: LambderConformanceSetup) => LambderSessionStore | Promise<LambderSessionStore>;
    /** What the store's `isMemoryOnly` must say: true only for a store nothing outlives the process of. Default: false. */
    isMemoryOnly?: boolean;
};
/**
 * Registers the session store rules as cases of the runner, one `it` each,
 * against the store `create` builds:
 *
 * ```ts
 * import { describe, it, expect } from "vitest";
 * import { lambderSessionStoreConformance } from "lambder/testing";
 *
 * describe("PostgresSessionStore", () => {
 *     lambderSessionStoreConformance({ it, expect, create: async () => { await emptySessions(); return new PostgresSessionStore(pool); } });
 * });
 * ```
 *
 * The records a case writes are dated from the case's clock, which starts at
 * a fixed moment far in the future and stands still unless a case moves it: a
 * store that expires records by the system clock, rather than by `now`, never
 * sees one expire.
 */
export declare const lambderSessionStoreConformance: (options: LambderSessionStoreConformanceOptions) => void;

import type { LambderCache } from "../shared/contracts/LambderCache.js";
import { type LambderConformanceRunner, type LambderConformanceSetup } from "./LambderConformanceRunner.js";
export type LambderCacheConformanceOptions = LambderConformanceRunner & {
    /** A cache holding no entries, built for one case over the case's clock. */
    create: (setup: LambderConformanceSetup) => LambderCache | Promise<LambderCache>;
};
/**
 * Registers the cache rules as cases of the runner, one `it` each, against
 * the cache `create` builds:
 *
 * ```ts
 * import { describe, it, expect } from "vitest";
 * import { lambderCacheConformance } from "lambder/testing";
 *
 * describe("RedisCache", () => {
 *     lambderCacheConformance({ it, expect, create: async ({ now }) => { await emptyCache(); return new RedisCache({ client, now }); } });
 * });
 * ```
 *
 * The entries a case writes expire by the case's clock, which starts at a
 * fixed moment far in the future and stands still unless a case moves it: a
 * cache that expires entries by the system clock, rather than by `now`, never
 * sees one expire. A cache over a storage with a native TTL keeps it on, since
 * nothing a case writes has expired by the world's clock.
 */
export declare const lambderCacheConformance: (options: LambderCacheConformanceOptions) => void;

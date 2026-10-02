import type { LambderCacheStorage } from "../stores/LambderStorageBackedCache.js";
import { type LambderConformanceRunner } from "./LambderConformanceRunner.js";
export type LambderCacheStorageConformanceOptions = LambderConformanceRunner & {
    /**
     * A storage holding no entries, built for one case. A storage over a
     * database empties what the previous case wrote here, since cases reuse
     * the same addresses. It is handed no clock: a storage judges no time
     * itself, the cache hands it the second each question is about.
     */
    create: () => LambderCacheStorage | Promise<LambderCacheStorage>;
};
/**
 * Registers the cache storage rules as cases of the runner, one `it` each,
 * against the storage `create` builds:
 *
 * ```ts
 * import { describe, it, expect } from "vitest";
 * import { lambderCacheStorageConformance } from "lambder/testing";
 *
 * describe("cacheEntryTable", () => {
 *     lambderCacheStorageConformance({ it, expect, create: async () => { await emptyCacheEntries(); return cacheEntryTable; } });
 * });
 * ```
 */
export declare const lambderCacheStorageConformance: (options: LambderCacheStorageConformanceOptions) => void;

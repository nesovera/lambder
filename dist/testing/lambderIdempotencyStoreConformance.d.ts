import type { LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import { type LambderConformanceRunner, type LambderConformanceSetup } from "./LambderConformanceRunner.js";
export type LambderIdempotencyStoreConformanceOptions = LambderConformanceRunner & {
    /** A store holding nothing, built for one case over the case's clock. */
    create: (setup: LambderConformanceSetup) => LambderIdempotencyStore | Promise<LambderIdempotencyStore>;
    /**
     * A body this store will not hold. The budget is the store's own business
     * (a DynamoDB store measures what it writes after compression, a memory
     * store the bytes), so each says what "too big" means for it.
     */
    oversizedBody: string;
    /** The other side of the same budget: the largest body this store does hold, so the boundary is pinned from both directions. */
    largestStorableBody: string;
};
/**
 * Registers the idempotency store rules as cases of the runner, one `it`
 * each, against the store `create` builds:
 *
 * ```ts
 * import { describe, it, expect } from "vitest";
 * import { lambderIdempotencyStoreConformance } from "lambder/testing";
 *
 * describe("OrderIdempotencyStore", () => {
 *     lambderIdempotencyStoreConformance({
 *         it, expect,
 *         create: ({ now }) => new OrderIdempotencyStore({ pool, now }),
 *         oversizedBody: "x".repeat(2_000_000),
 *         largestStorableBody: "x".repeat(1_000_000),
 *     });
 * });
 * ```
 */
export declare const lambderIdempotencyStoreConformance: (options: LambderIdempotencyStoreConformanceOptions) => void;

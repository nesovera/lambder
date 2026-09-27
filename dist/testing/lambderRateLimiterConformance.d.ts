import { type LambderRateLimiter } from "../shared/contracts/LambderRateLimiter.js";
import { type LambderConformanceRunner, type LambderConformanceSetup } from "./LambderConformanceRunner.js";
export type LambderRateLimiterConformanceOptions = LambderConformanceRunner & {
    /** A limiter holding no counts, built for one case over the case's clock. */
    create: (setup: LambderConformanceSetup) => LambderRateLimiter | Promise<LambderRateLimiter>;
};
/**
 * Registers the rate limiter rules as cases of the runner, one `it` each,
 * against the limiter `create` builds:
 *
 * ```ts
 * import { describe, it, expect } from "vitest";
 * import { lambderRateLimiterConformance } from "lambder/testing";
 *
 * describe("RedisRateLimiter", () => {
 *     lambderRateLimiterConformance({ it, expect, create: ({ now }) => new RedisRateLimiter({ client, now }) });
 * });
 * ```
 */
export declare const lambderRateLimiterConformance: (options: LambderRateLimiterConformanceOptions) => void;

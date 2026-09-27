import { RATE_LIMIT_WINDOWS, type LambderRateLimiter } from "../shared/contracts/LambderRateLimiter.js";
import {
    CONFORMANCE_START_MILLIS as START,
    conformanceClock,
    type LambderConformanceRunner,
    type LambderConformanceSetup,
} from "./LambderConformanceRunner.js";

/*
 * The rules a LambderRateLimiter promises the rate-limit engine: attempts
 * counted per key and window, the refusal naming the window it hit, and a
 * fresh count once a fixed window rolls over. Every window in the shared
 * table is driven through each implementation, so a limiter that handled
 * perMin and perHour and ignored the rest cannot pass on the strength of the
 * shared import alone.
 */

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
export const lambderRateLimiterConformance = (options: LambderRateLimiterConformanceOptions): void => {
    const { it, expect } = options;

    const begin = async () => {
        const clock = conformanceClock();
        return { clock, limiter: await options.create(clock) };
    };

    it("counts attempts and refuses the one past the limit, naming the window", async () => {
        const { limiter } = await begin();

        expect(await limiter.isRateLimited("k", { perMin: 2 })).toBe(false);
        expect(await limiter.isRateLimited("k", { perMin: 2 })).toBe(false);

        const refused = await limiter.isRateLimited("k", { perMin: 2 });
        expect(refused).toMatchObject({ window: "perMin", limit: 2 });
        if(refused === false) throw new Error("expected the third attempt to be refused");
        expect(refused.resetAt).toBeGreaterThan(Math.floor(START / 1000));
    });

    it("counts attempts rather than allowed requests, so a refusal does not reset anything", async () => {
        const { limiter } = await begin();
        await limiter.isRateLimited("k", { perMin: 1 });

        expect(await limiter.isRateLimited("k", { perMin: 1 })).not.toBe(false);
        expect(await limiter.isRateLimited("k", { perMin: 1 })).not.toBe(false);
    });

    it("does not enforce a window the policy leaves out or caps at zero", async () => {
        const { limiter } = await begin();

        for(let i = 0; i < 5; i += 1){
            expect(await limiter.isRateLimited("k", { perHour: 0 })).toBe(false);
        }
        expect(await limiter.isRateLimited("k", {})).toBe(false);
    });

    it("reports the smallest exceeded window, since that is the one evaluated first", async () => {
        const { limiter } = await begin();
        await limiter.isRateLimited("k", { perMin: 1, perHour: 10 });

        expect(await limiter.isRateLimited("k", { perMin: 1, perHour: 10 })).toMatchObject({ window: "perMin" });
    });

    it("keeps tracker keys apart", async () => {
        const { limiter } = await begin();
        await limiter.isRateLimited("a", { perMin: 1 });

        expect(await limiter.isRateLimited("b", { perMin: 1 })).toBe(false);
    });

    it("starts a fresh count once the fixed window rolls over", async () => {
        const { clock, limiter } = await begin();
        await limiter.isRateLimited("k", { perMin: 1 });
        expect(await limiter.isRateLimited("k", { perMin: 1 })).not.toBe(false);

        clock.set(START + 61_000);

        expect(await limiter.isRateLimited("k", { perMin: 1 })).toBe(false);
    });

    for(const { key, seconds } of RATE_LIMIT_WINDOWS){
        it(`enforces ${key} and resets after it`, async () => {
            const { clock, limiter } = await begin();
            const policy = { [key]: 1 };

            expect(await limiter.isRateLimited("k", policy)).toBe(false);
            expect(await limiter.isRateLimited("k", policy)).toMatchObject({ window: key, limit: 1 });

            clock.set(START + (seconds + 1) * 1000);
            expect(await limiter.isRateLimited("k", policy)).toBe(false);
        });
    }
};

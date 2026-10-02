import type { LambderCache } from "../shared/contracts/LambderCache.js";
import {
    CONFORMANCE_START_MILLIS as START,
    conformanceClock,
    type LambderConformanceRunner,
    type LambderConformanceSetup,
} from "./LambderConformanceRunner.js";

/*
 * The rules a LambderCache promises the code written against it: the keys
 * every cache refuses, the JSON round trip, expiry on the entry's own second,
 * live-only counts from delete and deletePartition, sort keys listed in the
 * table's order, and getOrSet's single load per key, its answer in the stored
 * JSON's shape, and a write of the key winning over a fill already loading.
 * Code is usually tested over LambderMemoryCache and run over another cache,
 * which is only sound while the two agree on each of these.
 *
 * The rules are the ones getOrSet keeps within one process. A cache that
 * also coordinates fills across processes (LambderDdbCache's lease) keeps
 * these as well; what it does across processes is its own to test.
 */

export type LambderCacheConformanceOptions = LambderConformanceRunner & {
    /** A cache holding no entries, built for one case over the case's clock. */
    create: (setup: LambderConformanceSetup) => LambderCache | Promise<LambderCache>;
};

/** A loader that answers only once the case opens its gate, and lets the case wait until it has been called. */
const gatedLoader = <T>(value: T) => {
    let open = (): void => undefined;
    let markStarted = (): void => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    const loader = async (): Promise<T> => {
        calls += 1;
        markStarted();
        await gate;
        return value;
    };
    return { loader, started, open: () => open(), calls: () => calls };
};

/** A loader that counts its calls. */
const countingLoader = <T>(answer: () => T) => {
    let calls = 0;
    return { loader: async (): Promise<T> => { calls += 1; return answer(); }, calls: () => calls };
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
export const lambderCacheConformance = (options: LambderCacheConformanceOptions): void => {
    const { it, expect } = options;

    const begin = async () => {
        const clock = conformanceClock();
        return { clock, cache: await options.create(clock) };
    };

    it("hands back a parse of what was stored, never the object itself", async () => {
        const { cache } = await begin();
        const value = { list: [1, 2], at: new Date(START) };
        await cache.set("round-trip", value);
        value.list.push(3);

        const read = await cache.get<{ list: number[]; at: string }>("round-trip");
        expect(read).toEqual({ list: [1, 2], at: new Date(START).toISOString() });
        expect(await cache.get("round-trip")).not.toBe(read);
    });

    it("answers undefined for an absent key and false from has()", async () => {
        const { cache } = await begin();
        expect(await cache.get("absent")).toBeUndefined();
        expect(await cache.has("absent")).toBe(false);
    });

    it("replaces an entry on a second set", async () => {
        const { cache } = await begin();
        await cache.set("order:1001", { status: "placed" });
        await cache.set("order:1001", { status: "shipped" });

        expect(await cache.get("order:1001")).toEqual({ status: "shipped" });
        expect(await cache.has("order:1001")).toBe(true);
    });

    it("expires an entry at its TTL, the expiry second itself included", async () => {
        const { clock, cache } = await begin();
        await cache.set("short", "value", { ttlSeconds: 10 });

        clock.set(START + 9_000);
        expect(await cache.get("short")).toBe("value");
        expect(await cache.has("short")).toBe(true);

        clock.set(START + 10_000);
        expect(await cache.get("short")).toBeUndefined();
        expect(await cache.has("short")).toBe(false);
    });

    it("refuses a value JSON cannot represent, a blank key, and a sort key past 900 bytes once escaped", async () => {
        const { cache } = await begin();
        await expect(cache.set("nothing", undefined)).rejects.toThrow();
        await expect(cache.get("  ")).rejects.toThrow();
        await expect(cache.get({ pk: "reports", sk: "  " })).rejects.toThrow();
        // "#" escapes to two bytes, so 500 of them are 1000 bytes escaped.
        await expect(cache.get({ pk: "reports", sk: "#".repeat(500) })).rejects.toThrow();
    });

    it("deletes one entry and says whether there was one", async () => {
        const { cache } = await begin();
        await cache.set("gone", 1);

        expect(await cache.delete("gone")).toBe(true);
        expect(await cache.get("gone")).toBeUndefined();
        expect(await cache.delete("gone")).toBe(false);
    });

    it("keeps a plain key and the grouped keys of its partition apart", async () => {
        const { cache } = await begin();
        await cache.set("store:nyc-01", "a plain key");
        await cache.set({ pk: "store:nyc-01", sk: "hours" }, "a grouped key");

        expect(await cache.delete("store:nyc-01")).toBe(true);
        expect(await cache.get({ pk: "store:nyc-01", sk: "hours" })).toBe("a grouped key");
        await cache.set("store:nyc-01", "a plain key");
        expect(await cache.delete({ pk: "store:nyc-01", sk: "hours" })).toBe(true);
        expect(await cache.get("store:nyc-01")).toBe("a plain key");
    });

    it("answers false from delete while a fill is loading the key, since a load in progress is no entry", async () => {
        const { cache } = await begin();
        const { loader, started, open } = gatedLoader({ tag: "old" });

        const fill = cache.getOrSet("filling", loader);
        await started;
        expect(await cache.delete("filling")).toBe(false);
        open();

        expect(await fill).toEqual({ tag: "old" });
        expect(await cache.get("filling")).toBeUndefined();
    });

    it("counts no entry past its TTL as deleted, from delete or deletePartition", async () => {
        const { clock, cache } = await begin();
        await cache.set("short", 1, { ttlSeconds: 10 });
        await cache.set({ pk: "store", sk: "short" }, 2, { ttlSeconds: 10 });
        await cache.set({ pk: "store", sk: "long" }, 3, { ttlSeconds: 100 });
        clock.set(START + 10_000);

        expect(await cache.delete("short")).toBe(false);
        expect(await cache.deletePartition("store")).toBe(1);
    });

    it("lists a partition's sort keys in order, by prefix and up to a limit, and leaves plain keys out", async () => {
        const { cache } = await begin();
        await cache.set({ pk: "store", sk: "1800:1900" }, 3);
        await cache.set({ pk: "store", sk: "1700:1800" }, 2);
        await cache.set({ pk: "store", sk: "0900:1000" }, 1);
        await cache.set({ pk: "other", sk: "1700:1800" }, 4);
        await cache.set("store", "a plain key sharing the partition");

        expect(await cache.listSortKeys("store")).toEqual(["0900:1000", "1700:1800", "1800:1900"]);
        expect(await cache.listSortKeys("store", { prefix: "1" })).toEqual(["1700:1800", "1800:1900"]);
        expect(await cache.listSortKeys("store", { limit: 1 })).toEqual(["0900:1000"]);
        expect(await cache.listSortKeys("nothing-here")).toEqual([]);
    });

    it("lists only live sort keys", async () => {
        const { clock, cache } = await begin();
        await cache.set({ pk: "store", sk: "short" }, 1, { ttlSeconds: 10 });
        await cache.set({ pk: "store", sk: "long" }, 2, { ttlSeconds: 100 });
        clock.set(START + 10_000);

        expect(await cache.listSortKeys("store")).toEqual(["long"]);
    });

    it("orders a key before one it is a prefix of when the longer one goes on below \"#\", as the table does", async () => {
        const { cache } = await begin();
        await cache.set({ pk: "cities", sk: "New York" }, 1);
        await cache.set({ pk: "cities", sk: "New York City" }, 2);
        await cache.set({ pk: "cities", sk: "New Yorker" }, 3);

        expect(await cache.listSortKeys("cities")).toEqual(["New York City", "New York", "New Yorker"]);
        expect(await cache.listSortKeys("cities", { prefix: "New", limit: 1 })).toEqual(["New York City"]);
    });

    it("orders keys holding \"#\" or \"~\" by their escaped form, as the table ranges them", async () => {
        const { cache } = await begin();
        await cache.set({ pk: "reports", sk: "a#b" }, 1);
        await cache.set({ pk: "reports", sk: "a~b" }, 2);
        await cache.set({ pk: "reports", sk: "a~1b" }, 3);
        await cache.set({ pk: "reports", sk: "ab" }, 4);

        // "~" escapes as "~0" and "#" as "~1", so both land past every letter.
        expect(await cache.listSortKeys("reports")).toEqual(["ab", "a~1b", "a~b", "a#b"]);
        expect(await cache.listSortKeys("reports", { prefix: "a~" })).toEqual(["a~1b", "a~b"]);
    });

    it("orders sort keys by their UTF-8 bytes, as DynamoDB orders a range key", async () => {
        const { cache } = await begin();
        // By bytes "B" (0x42) sorts before "a" (0x61), the opposite of a
        // locale compare, and U+FF5E (0xEF ...) before U+1F600 (0xF0 ...),
        // the opposite of UTF-16, which puts the surrogate pair first.
        await cache.set({ pk: "p", sk: "a" }, 1);
        await cache.set({ pk: "p", sk: "B" }, 2);
        await cache.set({ pk: "p", sk: "\uff5e" }, 3);
        await cache.set({ pk: "p", sk: "\u{1f600}" }, 4);

        expect(await cache.listSortKeys("p")).toEqual(["B", "a", "\uff5e", "\u{1f600}"]);
    });

    it("drops a partition's grouped entries in one call and counts them", async () => {
        const { cache } = await begin();
        await cache.set({ pk: "store", sk: "a" }, 1);
        await cache.set({ pk: "store", sk: "b" }, 2);
        await cache.set({ pk: "other", sk: "a" }, 3);

        expect(await cache.deletePartition("store")).toBe(2);
        expect(await cache.listSortKeys("store")).toEqual([]);
        expect(await cache.get({ pk: "other", sk: "a" })).toBe(3);
    });

    it("drops and counts a plain key sharing the partition, and leaves other partitions' plain keys alone", async () => {
        const { cache } = await begin();
        await cache.set("store", "a plain key sharing the partition");
        await cache.set({ pk: "store", sk: "a" }, 1);
        await cache.set("other", "a plain key of its own");
        await cache.set("store:nyc-01", "a partition the first is a prefix of");

        expect(await cache.deletePartition("store")).toBe(2);
        expect(await cache.get("store")).toBeUndefined();
        expect(await cache.get("other")).toBe("a plain key of its own");
        expect(await cache.get("store:nyc-01")).toBe("a partition the first is a prefix of");
    });

    it("loads once for concurrent getOrSet calls, then serves what it stored", async () => {
        const { cache } = await begin();
        const { loader, calls } = countingLoader(() => ({ city: "New York" }));

        const [first, second] = await Promise.all([cache.getOrSet("city", loader), cache.getOrSet("city", loader)]);
        expect(first).toEqual({ city: "New York" });
        expect(second).toEqual({ city: "New York" });
        expect(calls()).toBe(1);
        expect(await cache.getOrSet("city", loader)).toEqual({ city: "New York" });
        expect(calls()).toBe(1);
        expect(await cache.get("city")).toEqual({ city: "New York" });
    });

    it("stores a getOrSet value under the call's TTL", async () => {
        const { clock, cache } = await begin();
        await cache.getOrSet("short", async () => "value", { ttlSeconds: 10 });

        clock.set(START + 9_000);
        expect(await cache.get("short")).toBe("value");
        clock.set(START + 10_000);
        expect(await cache.get("short")).toBeUndefined();
    });

    it("hands each call that shares a load or a read a parse of its own", async () => {
        const { cache } = await begin();
        const loader = async () => ({ list: [1] });

        const [first, second] = await Promise.all([cache.getOrSet("shared", loader), cache.getOrSet("shared", loader)]);
        expect(second).not.toBe(first);
        first.list.push(2);
        expect(second).toEqual({ list: [1] });

        const [hit, joiner] = await Promise.all([cache.getOrSet("shared", loader), cache.getOrSet("shared", loader)]);
        expect(joiner).not.toBe(hit);
        expect(joiner).toEqual({ list: [1] });
    });

    it("leaves a loader's undefined uncached and asks the loader again next time", async () => {
        const { cache } = await begin();
        const { loader, calls } = countingLoader(() => undefined);

        expect(await cache.getOrSet("not-found", loader)).toBeUndefined();
        expect(await cache.has("not-found")).toBe(false);
        expect(await cache.getOrSet("not-found", loader)).toBeUndefined();
        expect(calls()).toBe(2);
    });

    it("caches a loader's null, the way to cache \"not found\"", async () => {
        const { cache } = await begin();
        const { loader, calls } = countingLoader(() => null);

        expect(await cache.getOrSet("not-found", loader)).toBeNull();
        expect(await cache.getOrSet("not-found", loader)).toBeNull();
        expect(calls()).toBe(1);
        expect(await cache.has("not-found")).toBe(true);
    });

    it("answers the stored JSON on the call that filled the entry, as on every later one", async () => {
        const { cache } = await begin();
        const loader = async () => ({ at: new Date("2026-01-02T03:04:05.000Z"), gone: undefined, count: 1 });

        const first = await cache.getOrSet("shape", loader);
        const later = await cache.getOrSet("shape", loader);
        expect(first).toEqual({ at: "2026-01-02T03:04:05.000Z", count: 1 });
        expect(Object.keys(first)).toEqual(["at", "count"]);
        expect(later).toEqual(first);
    });

    it("propagates a loader that throws, and stores nothing", async () => {
        const { cache } = await begin();
        await expect(cache.getOrSet("broken", async () => { throw new Error("origin down"); })).rejects.toThrow();
        expect(await cache.has("broken")).toBe(false);
    });

    it("never stores a slow fill's value over a set and a delete that landed while it loaded", async () => {
        const { cache } = await begin();
        const { loader, started, open } = gatedLoader({ tag: "old" });

        const fill = cache.getOrSet("raced", loader);
        await started;
        await cache.set("raced", { tag: "new" });
        // A call after the write reads it, rather than joining the load it overtook.
        expect(await cache.getOrSet("raced", async () => ({ tag: "other" }))).toEqual({ tag: "new" });
        await cache.delete("raced");
        open();

        expect(await fill).toEqual({ tag: "old" });
        expect(await cache.get("raced")).toBeUndefined();
    });

    it("never stores a slow fill's value over a deletePartition that landed while it loaded", async () => {
        const { cache } = await begin();
        const key = { pk: "store", sk: "a" };
        const { loader, started, open } = gatedLoader({ tag: "old" });

        const fill = cache.getOrSet(key, loader);
        await started;
        expect(await cache.deletePartition("store")).toBe(0);
        open();

        expect(await fill).toEqual({ tag: "old" });
        expect(await cache.get(key)).toBeUndefined();
    });

    it("throws an invalid option to the caller before loading anything", async () => {
        const { cache } = await begin();
        const { loader, calls } = countingLoader(() => "value");

        await expect(cache.set("options", 1, { ttlSeconds: 0 })).rejects.toThrow();
        await expect(cache.getOrSet("options", loader, { ttlSeconds: 0 })).rejects.toThrow();
        await expect(cache.getOrSet("options", loader, { ttlSeconds: 1.5 })).rejects.toThrow();
        // The fill lease's options are checked by every cache, whether or not it holds a lease.
        await expect(cache.getOrSet("options", loader, { leaseSeconds: 0 })).rejects.toThrow();
        await expect(cache.getOrSet("options", loader, { waitForFillMs: 1.5 })).rejects.toThrow();
        await expect(cache.listSortKeys("store", { limit: 0 })).rejects.toThrow();
        expect(calls()).toBe(0);
        expect(await cache.has("options")).toBe(false);
    });
};

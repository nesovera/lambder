/**
 * LambderStorageBackedCache over a small storage written the way an app
 * writes one over its own table (MemoryCacheStorage in helpers).
 *
 * The rules every cache shares (key refusals, the JSON round trip, expiry,
 * delete and deletePartition counts, listing order, getOrSet's single-flight
 * and a write winning over a fill) run over this cache in the conformance
 * suite in ddb-cache.test.ts. What is here is what only this cache has to get
 * right: what it hands the storage, what it decides itself about what the
 * storage hands back, and that a storage failing never fails a getOrSet.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { LambderStorageBackedCache, type LambderStorageBackedCacheOptions } from "../../src/stores/LambderStorageBackedCache.js";
import { DEFAULT_TTL_SECONDS } from "../../src/stores/LambderCacheValues.js";
import { MemoryCacheStorage } from "../helpers.js";

/** Half a second past a whole one, so a clock read as seconds has to round down. */
const START = 1_700_000_000_500;
const START_SECONDS = 1_700_000_000;

const build = (options: Omit<LambderStorageBackedCacheOptions, "storage"> = {}) => {
    const storage = new MemoryCacheStorage();
    let clock = START;
    const cache = new LambderStorageBackedCache({ storage, now: () => clock, ...options });
    return { cache, storage, moveTo: (ms: number) => { clock = ms; } };
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("LambderStorageBackedCache", () => {
    it("hands the storage the normalized address, the value's JSON and an expiry in epoch seconds off the injected clock", async () => {
        const { cache, storage } = build();

        await cache.set({ pk: "store:nyc-01", sk: "1700:1800" }, { orders: 3 }, { ttlSeconds: 60 });
        await cache.set("order:1001", { total: 42 });

        expect([...storage.entries.values()]).toEqual([
            {
                address: expect.objectContaining({ partition: "store:nyc-01", sortKey: "1700:1800" }),
                entry: { json: "{\"orders\":3}", expiresAt: START_SECONDS + 60 },
            },
            {
                address: expect.objectContaining({ partition: "order:1001", sortKey: null }),
                entry: { json: "{\"total\":42}", expiresAt: START_SECONDS + DEFAULT_TTL_SECONDS },
            },
        ]);
    });

    it("takes its default TTL from the options", async () => {
        const { cache, storage } = build({ defaultTtlSeconds: 300 });

        await cache.getOrSet("order:1001", async () => ({ total: 42 }));

        expect([...storage.entries.values()][0]?.entry.expiresAt).toBe(START_SECONDS + 300);
    });

    it("refuses a bad key, an oversized value and an invalid option before the storage hears of it", async () => {
        const { cache, storage } = build({ maxValueBytes: 10 });
        const calls = [
            vi.spyOn(storage, "read"),
            vi.spyOn(storage, "write"),
            vi.spyOn(storage, "delete"),
            vi.spyOn(storage, "deletePartition"),
            vi.spyOn(storage, "listSortKeys"),
        ];

        await expect(cache.get("  ")).rejects.toThrow("Cache key is required");
        await expect(cache.has({ pk: "reports", sk: "  " })).rejects.toThrow("Cache sort key is required");
        await expect(cache.set({ pk: "reports", sk: "#".repeat(500) }, 1)).rejects.toThrow("900");
        await expect(cache.set("big", "x".repeat(20))).rejects.toThrow("Cache value exceeds maxValueBytes");
        await expect(cache.set("undefined", undefined)).rejects.toThrow("Cache value must be JSON-serializable");
        await expect(cache.set("ttl", 1, { ttlSeconds: 0 })).rejects.toThrow("ttlSeconds");
        await expect(cache.delete("  ")).rejects.toThrow("Cache key is required");
        await expect(cache.deletePartition("  ")).rejects.toThrow("Cache key is required");
        await expect(cache.listSortKeys("store", { limit: 0 })).rejects.toThrow("limit");
        await expect(cache.getOrSet("options", async () => 1, { ttlSeconds: 1.5 })).rejects.toThrow("ttlSeconds");

        for(const call of calls) expect(call).not.toHaveBeenCalled();
    });

    it("rejects invalid construction options", () => {
        const storage = new MemoryCacheStorage();
        expect(() => new LambderStorageBackedCache({ storage, defaultTtlSeconds: 0 })).toThrow("defaultTtlSeconds");
        expect(() => new LambderStorageBackedCache({ storage, maxValueBytes: 1.5 })).toThrow("maxValueBytes");
        expect(() => new LambderStorageBackedCache({} as LambderStorageBackedCacheOptions)).toThrow("storage is required");
    });

    it("treats an entry the storage still holds past its expiry as absent, and fills over it", async () => {
        // The storage hands back what it holds, expired or not: whether an
        // entry is live is the cache's call.
        const { cache, storage, moveTo } = build();
        await cache.set("order:1001", { total: 1 }, { ttlSeconds: 10 });
        moveTo(START + 10_000);

        await expect(cache.get("order:1001")).resolves.toBeUndefined();
        await expect(cache.has("order:1001")).resolves.toBe(false);
        expect(storage.entries.size).toBe(1);

        const loader = vi.fn(async () => ({ total: 2 }));
        await expect(cache.getOrSet("order:1001", loader)).resolves.toEqual({ total: 2 });
        expect(loader).toHaveBeenCalledOnce();
        await expect(cache.get("order:1001")).resolves.toEqual({ total: 2 });
    });

    it("hands back a fresh parse on every read, so a change to one answer never reaches the next", async () => {
        const { cache, storage } = build();
        await cache.set("order:1001", { items: ["bagel"], placedAt: new Date(START) });

        const first = await cache.get<{ items: string[]; placedAt: string }>("order:1001");
        first?.items.push("coffee");

        await expect(cache.get("order:1001")).resolves.toEqual({ items: ["bagel"], placedAt: new Date(START).toISOString() });
        expect([...storage.entries.values()][0]?.entry.json).toBe(JSON.stringify({ items: ["bagel"], placedAt: new Date(START) }));
    });

    it("sorts whatever order the storage lists in, then cuts to the limit, leaving the storage's list as it was", async () => {
        const { cache, storage } = build();
        const listed = ["b", "New York", "a#", "New York City", "B"];
        const listing = vi.spyOn(storage, "listSortKeys")
            .mockResolvedValueOnce(listed)
            .mockResolvedValueOnce(["New York", "New York City"]);

        // By UTF-8 bytes of the escaped key and its "#": "B" below "a", " " below "#".
        await expect(cache.listSortKeys("cities")).resolves.toEqual(["B", "New York City", "New York", "a#", "b"]);
        await expect(cache.listSortKeys("cities", { prefix: "New", limit: 1 })).resolves.toEqual(["New York City"]);

        expect(listed).toEqual(["b", "New York", "a#", "New York City", "B"]);
        expect(listing).toHaveBeenNthCalledWith(1, "cities", "", START_SECONDS);
        expect(listing).toHaveBeenNthCalledWith(2, "cities", "New", START_SECONDS);
    });

    it("asks the storage what was live at the cache's own current second", async () => {
        const { cache, storage, moveTo } = build();
        const deleting = vi.spyOn(storage, "delete");
        const droppingPartition = vi.spyOn(storage, "deletePartition");
        moveTo(START + 90_000);

        await cache.delete({ pk: "store:nyc-01", sk: "1700:1800" });
        await cache.deletePartition("store:nyc-01");

        expect(deleting).toHaveBeenCalledWith(expect.objectContaining({ partition: "store:nyc-01", sortKey: "1700:1800" }), START_SECONDS + 90);
        expect(droppingPartition).toHaveBeenCalledWith("store:nyc-01", START_SECONDS + 90);
    });

    it("answers false from delete for a key the storage never held", async () => {
        const { cache } = build();
        await expect(cache.delete("order:never")).resolves.toBe(false);
        await expect(cache.delete({ pk: "store:nyc-01", sk: "never" })).resolves.toBe(false);
    });

    it("keeps nothing in memory: a second cache over the same storage sees every write at once", async () => {
        const storage = new MemoryCacheStorage();
        const first = new LambderStorageBackedCache({ storage, now: () => START });
        const second = new LambderStorageBackedCache({ storage, now: () => START });

        await first.set("order:1001", { total: 42 });
        await expect(second.get("order:1001")).resolves.toEqual({ total: 42 });
        await second.delete("order:1001");
        await expect(first.get("order:1001")).resolves.toBeUndefined();
    });

    it("fails open when the storage read throws: the loader runs once and its value comes back uncached, as a hit's JSON", async () => {
        const { cache, storage } = build();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(storage, "read").mockRejectedValueOnce(new Error("storage down"));
        const loader = vi.fn(async () => ({ placedAt: new Date(START) }));

        await expect(cache.getOrSet("order:1001", loader)).resolves.toEqual({ placedAt: new Date(START).toISOString() });

        expect(loader).toHaveBeenCalledOnce();
        expect(storage.entries.size).toBe(0);
        expect(error).toHaveBeenCalledOnce();
        expect(String(error.mock.calls[0]?.[0])).toContain("Storage-backed cache failed open");
    });

    it("fails open when the storage write throws, without running the loader a second time", async () => {
        const { cache, storage } = build();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(storage, "write").mockRejectedValueOnce(new Error("storage down"));
        const loader = vi.fn(async () => ({ total: 42 }));

        await expect(cache.getOrSet("order:1001", loader)).resolves.toEqual({ total: 42 });
        expect(loader).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledOnce();
        expect(storage.entries.size).toBe(0);

        // Nothing was stored, so the next call loads again, and stores.
        await expect(cache.getOrSet("order:1001", loader)).resolves.toEqual({ total: 42 });
        expect(loader).toHaveBeenCalledTimes(2);
        await expect(cache.get("order:1001")).resolves.toEqual({ total: 42 });
    });

    it("hands a storage failure to the caller of every method but getOrSet", async () => {
        const { cache, storage } = build();
        const down = () => Promise.reject(new Error("storage down"));
        vi.spyOn(storage, "read").mockImplementation(down);
        vi.spyOn(storage, "write").mockImplementation(down);
        vi.spyOn(storage, "delete").mockImplementation(down);
        vi.spyOn(storage, "deletePartition").mockImplementation(down);
        vi.spyOn(storage, "listSortKeys").mockImplementation(down);

        await expect(cache.get("order:1001")).rejects.toThrow("storage down");
        await expect(cache.has("order:1001")).rejects.toThrow("storage down");
        await expect(cache.set("order:1001", 1)).rejects.toThrow("storage down");
        await expect(cache.delete("order:1001")).rejects.toThrow("storage down");
        await expect(cache.deletePartition("store:nyc-01")).rejects.toThrow("storage down");
        await expect(cache.listSortKeys("store:nyc-01")).rejects.toThrow("storage down");
    });
});

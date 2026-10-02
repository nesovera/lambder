import { normalizeCacheKey, type LambderCacheAddress } from "../stores/LambderCacheKeys.js";
import type { LambderCacheStorage, LambderCacheStoredEntry } from "../stores/LambderStorageBackedCache.js";
import type { LambderCacheKey } from "../shared/contracts/LambderCache.js";
import { CONFORMANCE_START_MILLIS, type LambderConformanceRunner } from "./LambderConformanceRunner.js";

/*
 * The rules a LambderCacheStorage promises LambderStorageBackedCache: an
 * entry kept at its address exactly as written (the JSON text byte for byte,
 * the expiry second), every address apart from every other, and delete,
 * deletePartition and listSortKeys answering about the entries live at the
 * second the cache names. The cache brings every other rule itself, so a
 * storage that keeps these gives a cache that answers as LambderMemoryCache
 * does.
 *
 * The cases lean on where a storage over a database usually slips: a jsonb
 * column that reorders an object's keys, a collation that compares "a" and
 * "A" (or "a" and "a ") as one key, a LIKE pattern that reads "_" and "%" in
 * a prefix as wildcards, a partition matched by prefix rather than exactly,
 * and a partition and sort key joined into one string with a separator a key
 * may also contain.
 */

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
 * The second every case asks about: where every suite's clock starts, fixed
 * and far in the future (see CONFORMANCE_START_MILLIS), so an entry counts as
 * expired only by the storage's own answer to `nowSeconds`.
 */
const NOW = CONFORMANCE_START_MILLIS / 1000;

/** The address the cache would hand the storage for a key. */
const at = (key: LambderCacheKey): LambderCacheAddress => normalizeCacheKey(key);

const live = (json: string): LambderCacheStoredEntry => ({ json, expiresAt: NOW + 3600 });
/** An entry whose expiry is the very second asked about: no longer live, as the cache counts. */
const expiring = (json: string): LambderCacheStoredEntry => ({ json, expiresAt: NOW });

/** A listing in a fixed order, since a storage may answer in any. */
const sorted = (keys: readonly string[]): string[] => [...keys].sort();

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
export const lambderCacheStorageConformance = (options: LambderCacheStorageConformanceOptions): void => {
    const { it, expect } = options;

    const begin = async () => await options.create();

    /** The JSON text an address holds, or null: what a case compares, whatever else the storage's entry carries. */
    const jsonAt = async (storage: LambderCacheStorage, key: LambderCacheKey): Promise<string | null> =>
        (await storage.read(at(key)))?.json ?? null;

    it("reads null at an address it holds nothing at", async () => {
        const storage = await begin();
        expect(await storage.read(at("order:1001"))).toBeNull();
        expect(await storage.read(at({ pk: "store:nyc-01", sk: "hours" }))).toBeNull();
    });

    it("hands back what was written: the JSON text byte for byte, and the expiry second as a number", async () => {
        const storage = await begin();
        // Keys out of alphabetical order, escapes and characters past ASCII:
        // a column that parses the JSON (jsonb) hands back other text.
        const json = JSON.stringify({ zone: "America/New_York", items: [3, 1, 2], note: "Caf\u00e9 \u2615 \"two\"\nlines" });
        await storage.write(at("order:1001"), { json, expiresAt: NOW + 60 });
        await storage.write(at({ pk: "store:nyc-01", sk: "hours" }), { json: "null", expiresAt: NOW + 120 });

        const plain = await storage.read(at("order:1001"));
        expect(plain?.json).toBe(json);
        expect(plain?.expiresAt).toBe(NOW + 60);
        const grouped = await storage.read(at({ pk: "store:nyc-01", sk: "hours" }));
        expect(grouped?.json).toBe("null");
        expect(grouped?.expiresAt).toBe(NOW + 120);
    });

    it("replaces the entry at an address on a second write", async () => {
        const storage = await begin();
        await storage.write(at("order:1001"), live("\"placed\""));
        await storage.write(at("order:1001"), { json: "\"shipped\"", expiresAt: NOW + 7200 });

        const read = await storage.read(at("order:1001"));
        expect(read?.json).toBe("\"shipped\"");
        expect(read?.expiresAt).toBe(NOW + 7200);
    });

    it("keeps every address apart: a plain key, the sort keys of its partition, and partitions that share a prefix or a separator", async () => {
        const storage = await begin();
        const keys: LambderCacheKey[] = [
            "store",
            { pk: "store", sk: "hours" },
            { pk: "store", sk: "hours:late" },
            "store:nyc-01",
            { pk: "store:nyc-01", sk: "hours" },
            // What a storage joining partition and sort key with "#" would file as { pk: "store", sk: "hours" }.
            "store#hours",
        ];
        for(const [index, key] of keys.entries()) await storage.write(at(key), live(String(index)));

        for(const [index, key] of keys.entries()) expect(await jsonAt(storage, key)).toBe(String(index));
    });

    it("tells apart keys a database collation may compare as equal: by case, and by a trailing space", async () => {
        const storage = await begin();
        const keys: LambderCacheKey[] = [
            "store", "Store", "store ",
            { pk: "store", sk: "a" }, { pk: "store", sk: "A" }, { pk: "store", sk: "a " },
        ];
        for(const [index, key] of keys.entries()) await storage.write(at(key), live(String(index)));

        for(const [index, key] of keys.entries()) expect(await jsonAt(storage, key)).toBe(String(index));
        expect(sorted(await storage.listSortKeys("store", "", NOW))).toEqual(["A", "a", "a "]);
    });

    it("deletes one entry, answers whether it was live at the second asked about, and leaves the rest of its partition alone", async () => {
        const storage = await begin();
        await storage.write(at("store"), live("\"plain\""));
        await storage.write(at({ pk: "store", sk: "a" }), live("1"));
        await storage.write(at({ pk: "store", sk: "b" }), expiring("2"));

        expect(await storage.delete(at("store"), NOW)).toBe(true);
        expect(await storage.read(at("store"))).toBeNull();
        expect(await jsonAt(storage, { pk: "store", sk: "a" })).toBe("1");

        // Expired at that very second: removed all the same, and not counted as live.
        expect(await storage.delete(at({ pk: "store", sk: "b" }), NOW)).toBe(false);
        expect(await storage.read(at({ pk: "store", sk: "b" }))).toBeNull();

        expect(await storage.delete(at({ pk: "store", sk: "a" }), NOW)).toBe(true);
        expect(await storage.delete(at({ pk: "store", sk: "a" }), NOW)).toBe(false);
        expect(await storage.delete(at("absent"), NOW)).toBe(false);
    });

    it("judges a deleted entry live by the second it is handed, not by its own clock", async () => {
        const storage = await begin();
        await storage.write(at("order:1001"), expiring("1"));

        expect(await storage.delete(at("order:1001"), NOW - 1)).toBe(true);
    });

    it("drops every entry under a partition, the plain key's included, and counts the live ones", async () => {
        const storage = await begin();
        await storage.write(at("store"), live("\"plain\""));
        await storage.write(at({ pk: "store", sk: "a" }), live("1"));
        await storage.write(at({ pk: "store", sk: "b" }), expiring("2"));
        await storage.write(at("store:nyc-01"), live("\"a partition 'store' is a prefix of\""));
        await storage.write(at({ pk: "store:nyc-01", sk: "a" }), live("3"));
        await storage.write(at({ pk: "Store", sk: "a" }), live("4"));
        await storage.write(at({ pk: "other", sk: "a" }), live("5"));

        expect(await storage.deletePartition("store", NOW)).toBe(2);
        expect(await storage.read(at("store"))).toBeNull();
        expect(await storage.read(at({ pk: "store", sk: "a" }))).toBeNull();
        expect(await storage.read(at({ pk: "store", sk: "b" }))).toBeNull();
        expect(await jsonAt(storage, "store:nyc-01")).toBe("\"a partition 'store' is a prefix of\"");
        expect(await jsonAt(storage, { pk: "store:nyc-01", sk: "a" })).toBe("3");
        expect(await jsonAt(storage, { pk: "Store", sk: "a" })).toBe("4");
        expect(await jsonAt(storage, { pk: "other", sk: "a" })).toBe("5");

        expect(await storage.deletePartition("store", NOW)).toBe(0);
    });

    it("counts a dropped partition's live entries by the second it is handed", async () => {
        const storage = await begin();
        await storage.write(at({ pk: "store", sk: "a" }), live("1"));
        await storage.write(at({ pk: "store", sk: "b" }), expiring("2"));

        expect(await storage.deletePartition("store", NOW - 1)).toBe(2);
    });

    it("lists the live sort keys under a partition, never the plain key's entry, by the second it is handed", async () => {
        const storage = await begin();
        await storage.write(at("store"), live("\"plain\""));
        await storage.write(at({ pk: "store", sk: "1700:1800" }), live("1"));
        await storage.write(at({ pk: "store", sk: "1800:1900" }), live("2"));
        await storage.write(at({ pk: "store", sk: "0900:1000" }), expiring("3"));
        await storage.write(at({ pk: "store:nyc-01", sk: "1700:1900" }), live("4"));
        await storage.write(at({ pk: "other", sk: "1700:2000" }), live("5"));

        expect(sorted(await storage.listSortKeys("store", "", NOW))).toEqual(["1700:1800", "1800:1900"]);
        expect(sorted(await storage.listSortKeys("store", "17", NOW))).toEqual(["1700:1800"]);
        expect(sorted(await storage.listSortKeys("store", "", NOW - 1))).toEqual(["0900:1000", "1700:1800", "1800:1900"]);
        expect(await storage.listSortKeys("nothing-here", "", NOW)).toEqual([]);
    });

    it("matches a listing prefix literally, so characters a SQL pattern reads as wildcards match only themselves", async () => {
        const storage = await begin();
        for(const sortKey of ["a_b", "axb", "a%c", "abc", "a#b", "a~b", "a\\b"]){
            await storage.write(at({ pk: "store", sk: sortKey }), live("1"));
        }

        expect(sorted(await storage.listSortKeys("store", "a_", NOW))).toEqual(["a_b"]);
        expect(sorted(await storage.listSortKeys("store", "a%", NOW))).toEqual(["a%c"]);
        expect(sorted(await storage.listSortKeys("store", "a#", NOW))).toEqual(["a#b"]);
        expect(sorted(await storage.listSortKeys("store", "a~", NOW))).toEqual(["a~b"]);
        expect(sorted(await storage.listSortKeys("store", "a\\", NOW))).toEqual(["a\\b"]);
        expect(await storage.listSortKeys("store", "a", NOW)).toHaveLength(7);
    });
};

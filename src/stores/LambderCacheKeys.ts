import type { LambderCacheKey } from "../shared/contracts/LambderCache.js";

/*
 * How a cache key is checked and spelled, for every cache here.
 *
 * LambderDdbCache and LambderMemoryCache take the same keys, and a key one of
 * them refuses has to be refused by the other: a test that runs over the
 * memory cache must not accept a key production then throws on. So the rules
 * are written once, here, and both stores normalize through them.
 */

/** Longest partition accepted, in UTF-8 bytes. */
const MAX_PARTITION_BYTES = 8 * 1024;
/** Budget for one encoded sort key, leaving room for the DynamoDB cache's marker and longest item suffix inside the 1024-byte range key limit. */
const MAX_SORT_KEY_BYTES = 900;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** One entry's address, normalized: `sortKey` is null for a plain string key. */
export interface LambderCacheAddress {
    partition: string;
    sortKey: string | null;
    /** Unambiguous key for an in-memory layer and an in-flight map. */
    memoryKey: string;
}

/**
 * `#` separates the DynamoDB cache's own item-key segments, so a caller's `#`
 * is escaped rather than refused: `~` becomes `~0` and `#` becomes `~1`. An
 * encoded sort key therefore never contains a bare `#`, which keeps
 * `<encoded>#` an unambiguous boundary for prefix queries. Escaping is
 * per-character, so a prefix of the raw key stays a prefix of the encoded
 * one; only the sort ORDER of keys that contain `#` or `~` shifts, since both
 * encode into the `~` range. The memory cache sorts by the same encoding, so
 * listSortKeys answers in the same order over either store.
 */
export const encodeCacheSortKey = (value: string): string => value.replace(/~/g, "~0").replace(/#/g, "~1");
export const decodeCacheSortKey = (value: string): string => value.replace(/~([01])/g, (_match, code) => code === "0" ? "~" : "#");

/** Length-prefixed so a partition ending in the separator cannot collide with a sort key. */
export const cacheMemoryKeyOf = (partition: string, sortKey: string | null): string =>
    `${partition.length}:${partition}#${sortKey ?? ""}`;

/** A partition as the caches accept it, or a throw naming what is wrong with it. */
export const normalizeCachePartition = (key: string): string => {
    if(typeof key !== "string" || !key.trim()) throw new Error("Cache key is required");
    if(utf8Bytes(key) > MAX_PARTITION_BYTES){
        throw new Error(`Cache key must be at most ${MAX_PARTITION_BYTES} UTF-8 bytes`);
    }
    return key;
};

/** Either key form as an address, or a throw naming what is wrong with it. */
export const normalizeCacheKey = (key: LambderCacheKey): LambderCacheAddress => {
    if(typeof key === "string"){
        const partition = normalizeCachePartition(key);
        return { partition, sortKey: null, memoryKey: cacheMemoryKeyOf(partition, null) };
    }
    if(!key || typeof key !== "object") throw new Error("Cache key is required");

    const partition = normalizeCachePartition(key.pk);
    const sortKey = key.sk;
    if(typeof sortKey !== "string" || !sortKey.trim()) throw new Error("Cache sort key is required");
    const encodedBytes = utf8Bytes(encodeCacheSortKey(sortKey));
    if(encodedBytes > MAX_SORT_KEY_BYTES){
        throw new Error(`Cache sort key must be at most ${MAX_SORT_KEY_BYTES} UTF-8 bytes once escaped (${encodedBytes})`);
    }
    return { partition, sortKey, memoryKey: cacheMemoryKeyOf(partition, sortKey) };
};

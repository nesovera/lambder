import type { LambderCacheKey } from "../shared/contracts/LambderCache.js";
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
export declare const encodeCacheSortKey: (value: string) => string;
export declare const decodeCacheSortKey: (value: string) => string;
/** Length-prefixed so a partition ending in the separator cannot collide with a sort key. */
export declare const cacheMemoryKeyOf: (partition: string, sortKey: string | null) => string;
/** A partition as the caches accept it, or a throw naming what is wrong with it. */
export declare const normalizeCachePartition: (key: string) => string;
/** Either key form as an address, or a throw naming what is wrong with it. */
export declare const normalizeCacheKey: (key: LambderCacheKey) => LambderCacheAddress;

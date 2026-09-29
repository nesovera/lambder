import type { LambderCacheKey } from "../shared/contracts/LambderCache.js";
/**
 * One entry's address, normalized: `sortKey` is null for a plain string key.
 * A sort key is never empty (a blank one is refused), so a storage whose
 * column cannot hold null can keep a plain key's entry under "".
 */
export interface LambderCacheAddress {
    partition: string;
    sortKey: string | null;
    /** One string that tells every address apart: the key of an in-memory layer, an in-flight map, or a storage keyed by one string. */
    memoryKey: string;
}
/**
 * `#` separates the DynamoDB cache's own item-key segments, so a caller's `#`
 * is escaped rather than refused: `~` becomes `~0` and `#` becomes `~1`. An
 * encoded sort key therefore never contains a bare `#`, which keeps
 * `<encoded>#` an unambiguous boundary for prefix queries. Escaping is
 * per-character, so a prefix of the raw key stays a prefix of the encoded
 * one; only the sort ORDER of keys that contain `#` or `~` shifts, since both
 * encode into the `~` range. The other caches sort by the same encoding (see
 * compareCacheSortKeys), so listSortKeys answers in the same order over any.
 */
export declare const encodeCacheSortKey: (value: string) => string;
export declare const decodeCacheSortKey: (value: string) => string;
/**
 * Orders two sort keys as LambderDdbCache lists them, for the caches that
 * sort a listing themselves: by the whole item sort key the table ranges
 * over, which carries a "#" after the encoded key. So "New York City" sorts
 * before "New York" (" " is below "#"), over every cache alike.
 */
export declare const compareCacheSortKeys: (first: string, second: string) => number;
/** Length-prefixed so a partition ending in the separator cannot collide with a sort key. */
export declare const cacheMemoryKeyOf: (partition: string, sortKey: string | null) => string;
/** A partition as the caches accept it, or a throw naming what is wrong with it. */
export declare const normalizeCachePartition: (key: string) => string;
/** Either key form as an address, or a throw naming what is wrong with it. */
export declare const normalizeCacheKey: (key: LambderCacheKey) => LambderCacheAddress;

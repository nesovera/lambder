import type { LambderCache, LambderCacheGetOrSetOptions, LambderCacheKey, LambderCacheListOptions, LambderCacheSetOptions } from "../shared/contracts/LambderCache.js";
import { type LambderCacheAddress } from "./LambderCacheKeys.js";
/** One entry as a storage keeps it: the value's JSON text and the second it stops being live. */
export interface LambderCacheStoredEntry {
    json: string;
    /** Epoch seconds: the entry is live while this is greater than the current second, so it expires at this second itself. */
    expiresAt: number;
}
/**
 * Where a LambderStorageBackedCache keeps its entries: a SQL table, a Redis
 * database, anything that can hold a JSON text and an expiry under an
 * address. Only reading and writing are asked of it; the key checks, the
 * JSON round trip, the TTL, the listing order and getOrSet's single-flight
 * are the cache's, so no storage can drift from the rules the other caches
 * keep.
 *
 * An entry is live at `nowSeconds` while its `expiresAt` is greater than
 * `nowSeconds`. The cache hands `nowSeconds` to the methods that answer
 * about live entries, so a storage can filter in its own query. It never
 * removes an expired entry it is not asked to, so a storage purges them on
 * its own schedule (a periodic delete, a native TTL) or grows without bound.
 *
 * A plain string key and the `{ pk, sk }` keys of one partition share that
 * partition: `address.sortKey` is null for the plain one.
 */
export interface LambderCacheStorage {
    /** The entry at this address, expired or not: the cache decides what is live. Null when there is none. */
    read(address: LambderCacheAddress): Promise<LambderCacheStoredEntry | null>;
    /** Creates the entry at this address, or replaces the one there. */
    write(address: LambderCacheAddress, entry: LambderCacheStoredEntry): Promise<void>;
    /** Removes the entry at this address, live or not; true when it was live at `nowSeconds`. */
    delete(address: LambderCacheAddress, nowSeconds: number): Promise<boolean>;
    /** Removes every entry under the partition, plain key and sort keys alike, and answers how many of them were live at `nowSeconds`. */
    deletePartition(partition: string, nowSeconds: number): Promise<number>;
    /**
     * Every sort key under the partition that starts with `prefix` and is
     * live at `nowSeconds`, in any order: the cache sorts the list and cuts
     * it to the caller's limit. A plain key's entry has no sort key and is
     * never listed.
     */
    listSortKeys(partition: string, prefix: string, nowSeconds: number): Promise<string[]>;
}
export interface LambderStorageBackedCacheOptions {
    /** Where the entries live. */
    storage: LambderCacheStorage;
    /** Default: one year, as the other caches'. */
    defaultTtlSeconds?: number;
    /** Largest value accepted, in UTF-8 bytes of its JSON. Default: 32 MiB, as the other caches'. */
    maxValueBytes?: number;
    /** The clock entries expire against, in epoch milliseconds, so a test can cross a TTL without waiting. */
    now?: () => number;
}
/**
 * A LambderCache over storage the app supplies (see LambderCacheStorage),
 * with every rule LambderMemoryCache keeps: it refuses the keys and values
 * the other caches refuse, stores a value's JSON text and hands back a fresh
 * parse of it, expires entries on the same TTL, counts only live entries in
 * what delete and deletePartition answer, and lists sort keys in the table's
 * order whatever order the storage finds them in.
 *
 * getOrSet runs through the LambderCacheFiller every cache holds: concurrent
 * calls for one key in this process share a load, every call answers the
 * stored JSON parsed, a loader's undefined comes back uncached, a set,
 * delete or deletePartition of the key while the loader runs keeps the fill
 * from storing over it, and a storage that fails (a read, a write) hands the
 * loader's value back uncached rather than failing the caller. A fill whose
 * write is already on its way to the storage when a write of the same key
 * arrives races it there, as two overlapping sets do.
 *
 * It holds no fill lease across processes: two processes missing one key
 * each run the loader, and the last write stands. It keeps nothing in
 * memory either, so every read asks the storage.
 */
export declare class LambderStorageBackedCache implements LambderCache {
    private readonly storage;
    /** getOrSet's single-flight and fail-open, shared with the other caches (see LambderCacheFiller). */
    private readonly filler;
    private readonly defaultTtlSeconds;
    private readonly maxValueBytes;
    private readonly now;
    constructor(options: LambderStorageBackedCacheOptions);
    get<T>(key: LambderCacheKey): Promise<T | undefined>;
    has(key: LambderCacheKey): Promise<boolean>;
    set<T>(key: LambderCacheKey, value: T, options?: LambderCacheSetOptions): Promise<void>;
    delete(key: LambderCacheKey): Promise<boolean>;
    deletePartition(partition: string): Promise<number>;
    listSortKeys(partition: string, options?: LambderCacheListOptions): Promise<string[]>;
    getOrSet<T>(key: LambderCacheKey, loader: () => Promise<T>, options?: LambderCacheGetOrSetOptions): Promise<T>;
    /** Whole seconds, as entries expire in every cache here, so a TTL ends on the same second as the memory cache's. */
    private nowSeconds;
    /** The entry at the address while it is live; the storage may still hold one past its expiry. */
    private readLive;
    /** Stores the value and hands back what was stored, the parse of its JSON. */
    private setByAddress;
}

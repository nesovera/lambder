import type { LambderCache, LambderCacheKey, LambderCacheListOptions, LambderCacheSetOptions } from "../shared/contracts/LambderCache.js";
export interface LambderMemoryCacheOptions {
    /** Default: one year, as LambderDdbCache's. */
    defaultTtlSeconds?: number;
    /** Largest value accepted, in UTF-8 bytes of its JSON. Default: 32 MiB, as LambderDdbCache's. */
    maxValueBytes?: number;
    /** Ceiling on entries held at once; past it the ones closest to expiring go first. Default: 100,000. */
    maxEntries?: number;
    /** The clock entries expire against, so a test can cross a TTL without waiting. */
    now?: () => number;
}
/**
 * LambderDdbCache's twin, held in memory: the same LambderCache interface and
 * the same rules, so code written against the interface can be tested
 * without a table. It refuses the keys and values the DynamoDB cache
 * refuses, stores a value's JSON text and hands back a fresh parse of it,
 * expires entries on the same TTL, and lists sort keys in the same order.
 *
 * getOrSet runs through the LambderCacheFiller both caches hold: concurrent
 * calls for one key share a load, every call (the filling one included)
 * answers the stored JSON parsed, a loader's undefined comes back uncached,
 * and a set, delete or deletePartition of the key while the loader runs
 * keeps the fill from storing over it, so a test that passes here passes
 * against the table.
 *
 * It has none of the table's machinery: no compression, no chunks, no fill
 * lease across containers. It is one process's cache, bounded by
 * `maxEntries`, and a single-process server could use it as that.
 */
export declare class LambderMemoryCache implements LambderCache {
    private readonly entries;
    /** getOrSet's single-flight and fail-open, shared with LambderDdbCache (see LambderCacheFiller). */
    private readonly filler;
    private readonly defaultTtlSeconds;
    private readonly maxValueBytes;
    private readonly now;
    constructor(options?: LambderMemoryCacheOptions);
    get<T>(key: LambderCacheKey): Promise<T | undefined>;
    has(key: LambderCacheKey): Promise<boolean>;
    set<T>(key: LambderCacheKey, value: T, options?: LambderCacheSetOptions): Promise<void>;
    delete(key: LambderCacheKey): Promise<boolean>;
    deletePartition(partition: string): Promise<number>;
    listSortKeys(partition: string, options?: LambderCacheListOptions): Promise<string[]>;
    getOrSet<T>(key: LambderCacheKey, loader: () => Promise<T>, options?: LambderCacheSetOptions): Promise<T>;
    /** Forgets every entry; a fill in flight meanwhile stores nothing. */
    reset(): void;
    /** Stores the value and hands back what was stored, the parse of its JSON. */
    private setByAddress;
}

import type { LambderCache, LambderCacheKey, LambderCacheListOptions, LambderCacheSetOptions } from "../shared/contracts/LambderCache.js";
import { LambderExpiringMap } from "../shared/util/LambderExpiringMap.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { cacheMemoryKeyOf, encodeCacheSortKey, normalizeCacheKey, normalizeCachePartition, type LambderCacheAddress } from "./LambderCacheKeys.js";
import {
    DEFAULT_MAX_VALUE_BYTES, DEFAULT_TTL_SECONDS, resolveCacheTtlSeconds, resolveGetOrSetOptions, serializeCacheValue,
} from "./LambderCacheValues.js";
import { LambderCacheFiller } from "./LambderCacheFiller.js";

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

/** One stored entry: the JSON text, and its address, so a partition can be listed and dropped. */
type MemoryCacheEntry = {
    json: string;
    address: LambderCacheAddress;
};

/** DynamoDB orders string range keys by their UTF-8 bytes, which is not JavaScript's UTF-16 order for every character. */
const compareUtf8 = (first: string, second: string): number => {
    const a = new TextEncoder().encode(first);
    const b = new TextEncoder().encode(second);
    const length = Math.min(a.length, b.length);
    for(let index = 0; index < length; index += 1){
        if(a[index] !== b[index]) return a[index]! - b[index]!;
    }
    return a.length - b.length;
};

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
export class LambderMemoryCache implements LambderCache {
    private readonly entries: LambderExpiringMap<MemoryCacheEntry>;
    /** getOrSet's single-flight and fail-open, shared with LambderDdbCache (see LambderCacheFiller). */
    private readonly filler = new LambderCacheFiller("Memory cache failed open");
    private readonly defaultTtlSeconds: number;
    private readonly maxValueBytes: number;
    private readonly now: () => number;

    constructor(options: LambderMemoryCacheOptions = {}){
        this.now = options.now ?? (() => Date.now());
        this.defaultTtlSeconds = assertPositiveInteger(options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS, "defaultTtlSeconds");
        this.maxValueBytes = assertPositiveInteger(options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES, "maxValueBytes");
        this.entries = new LambderExpiringMap<MemoryCacheEntry>({ now: this.now, maxEntries: options.maxEntries });
    }

    async get<T>(key: LambderCacheKey): Promise<T | undefined> {
        const entry = this.entries.get(normalizeCacheKey(key).memoryKey);
        return entry ? JSON.parse(entry.json) as T : undefined;
    }

    async has(key: LambderCacheKey): Promise<boolean> {
        return this.entries.get(normalizeCacheKey(key).memoryKey) !== undefined;
    }

    async set<T>(key: LambderCacheKey, value: T, options: LambderCacheSetOptions = {}): Promise<void> {
        const address = normalizeCacheKey(key);
        const ttlSeconds = resolveCacheTtlSeconds(options.ttlSeconds, this.defaultTtlSeconds);
        this.filler.supersedeFill(address.memoryKey);
        this.setByAddress(address, value, ttlSeconds);
    }

    async delete(key: LambderCacheKey): Promise<boolean> {
        const address = normalizeCacheKey(key);
        this.filler.supersedeFill(address.memoryKey);
        const existed = this.entries.get(address.memoryKey) !== undefined;
        this.entries.delete(address.memoryKey);
        return existed;
    }

    async deletePartition(partition: string): Promise<number> {
        const normalized = normalizeCachePartition(partition);
        this.filler.supersedeFillsWithPrefix(cacheMemoryKeyOf(normalized, ""));
        let removed = 0;
        for(const { address } of this.entries.values()){
            if(address.partition !== normalized) continue;
            this.entries.delete(address.memoryKey);
            removed += 1;
        }
        return removed;
    }

    async listSortKeys(partition: string, options: LambderCacheListOptions = {}): Promise<string[]> {
        const normalized = normalizeCachePartition(partition);
        const prefix = options.prefix ?? "";
        const limit = options.limit === undefined ? undefined : assertPositiveInteger(options.limit, "limit");
        const sortKeys = this.entries.values()
            .flatMap(({ address }) => address.partition === normalized && address.sortKey !== null && address.sortKey.startsWith(prefix) ? [address.sortKey] : [])
            // Ordered as the table orders the items it lists: by the whole
            // item sort key, which carries a "#" after the encoded key. So
            // "New York City" sorts before "New York" there (" " is below
            // "#"), and here too.
            .sort((first, second) => compareUtf8(`${encodeCacheSortKey(first)}#`, `${encodeCacheSortKey(second)}#`));
        return limit === undefined ? sortKeys : sortKeys.slice(0, limit);
    }

    async getOrSet<T>(key: LambderCacheKey, loader: () => Promise<T>, options: LambderCacheSetOptions = {}): Promise<T> {
        const address = normalizeCacheKey(key);
        const { ttlSeconds } = resolveGetOrSetOptions(options, this.defaultTtlSeconds);
        return this.filler.getOrSet(address.memoryKey, loader, async (load) => {
            const existing = this.entries.get(address.memoryKey);
            return existing ? JSON.parse(existing.json) as T : await load(async (value) => this.setByAddress(address, value, ttlSeconds));
        });
    }

    /** Forgets every entry; a fill in flight meanwhile stores nothing. */
    reset(): void {
        this.filler.supersedeFillsWithPrefix("");
        this.entries.clear();
    }

    /** Stores the value and hands back what was stored, the parse of its JSON. */
    private setByAddress<T>(address: LambderCacheAddress, value: T, ttlSeconds: number): T {
        const { json } = serializeCacheValue(value, this.maxValueBytes);
        const expiresAt = Math.floor(this.now() / 1000) + ttlSeconds;
        this.entries.set(address.memoryKey, { json, address }, expiresAt);
        return JSON.parse(json) as T;
    }
}

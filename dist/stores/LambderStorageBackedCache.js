import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { cacheMemoryKeyOf, compareCacheSortKeys, normalizeCacheKey, normalizeCachePartition } from "./LambderCacheKeys.js";
import { DEFAULT_MAX_VALUE_BYTES, DEFAULT_TTL_SECONDS, resolveCacheTtlSeconds, resolveGetOrSetOptions, serializeCacheValue, } from "./LambderCacheValues.js";
import { LambderCacheFiller } from "./LambderCacheFiller.js";
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
export class LambderStorageBackedCache {
    storage;
    /** getOrSet's single-flight and fail-open, shared with the other caches (see LambderCacheFiller). */
    filler = new LambderCacheFiller("Storage-backed cache failed open");
    defaultTtlSeconds;
    maxValueBytes;
    now;
    constructor(options) {
        // Here rather than at first use, where getOrSet would fail open over
        // it on every call and caching would be off without a caller seeing why.
        if (!options.storage)
            throw new Error("storage is required");
        this.storage = options.storage;
        this.now = options.now ?? (() => Date.now());
        this.defaultTtlSeconds = assertPositiveInteger(options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS, "defaultTtlSeconds");
        this.maxValueBytes = assertPositiveInteger(options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES, "maxValueBytes");
    }
    async get(key) {
        const entry = await this.readLive(normalizeCacheKey(key));
        return entry ? JSON.parse(entry.json) : undefined;
    }
    async has(key) {
        return await this.readLive(normalizeCacheKey(key)) !== null;
    }
    async set(key, value, options = {}) {
        const address = normalizeCacheKey(key);
        const ttlSeconds = resolveCacheTtlSeconds(options.ttlSeconds, this.defaultTtlSeconds);
        this.filler.supersedeFill(address.memoryKey);
        await this.setByAddress(address, value, ttlSeconds);
    }
    async delete(key) {
        const address = normalizeCacheKey(key);
        this.filler.supersedeFill(address.memoryKey);
        return await this.storage.delete(address, this.nowSeconds());
    }
    async deletePartition(partition) {
        const normalized = normalizeCachePartition(partition);
        this.filler.supersedeFillsWithPrefix(cacheMemoryKeyOf(normalized, ""));
        return await this.storage.deletePartition(normalized, this.nowSeconds());
    }
    async listSortKeys(partition, options = {}) {
        const normalized = normalizeCachePartition(partition);
        const prefix = options.prefix ?? "";
        const limit = options.limit === undefined ? undefined : assertPositiveInteger(options.limit, "limit");
        // A copy, since the storage may hand back a list it holds on to.
        const sortKeys = [...await this.storage.listSortKeys(normalized, prefix, this.nowSeconds())].sort(compareCacheSortKeys);
        return limit === undefined ? sortKeys : sortKeys.slice(0, limit);
    }
    async getOrSet(key, loader, options = {}) {
        const address = normalizeCacheKey(key);
        const { ttlSeconds } = resolveGetOrSetOptions(options, this.defaultTtlSeconds);
        return this.filler.getOrSet(address.memoryKey, loader, async (load) => {
            const existing = await this.readLive(address);
            return existing ? JSON.parse(existing.json) : await load(async (value) => await this.setByAddress(address, value, ttlSeconds));
        });
    }
    /** Whole seconds, as entries expire in every cache here, so a TTL ends on the same second as the memory cache's. */
    nowSeconds() {
        return Math.floor(this.now() / 1000);
    }
    /** The entry at the address while it is live; the storage may still hold one past its expiry. */
    async readLive(address) {
        const entry = await this.storage.read(address);
        return entry && entry.expiresAt > this.nowSeconds() ? entry : null;
    }
    /** Stores the value and hands back what was stored, the parse of its JSON. */
    async setByAddress(address, value, ttlSeconds) {
        const { json } = serializeCacheValue(value, this.maxValueBytes);
        await this.storage.write(address, { json, expiresAt: this.nowSeconds() + ttlSeconds });
        return JSON.parse(json);
    }
}

/**
 * The cache vocabulary every cache in Lambder shares: how an entry is
 * addressed, what writing and listing take, and the methods an app calls.
 *
 * Kept apart from LambderDdbCache for the reason the rate-limit and
 * idempotency contracts are: an app that types its caches against this
 * interface can hold a LambderMemoryCache in a test and a LambderDdbCache in
 * production without the test's import graph ever reaching the DynamoDB
 * store. Pure and dependency-free.
 */
/**
 * Where a value lives. A plain string addresses one entry. `{ pk, sk }` puts
 * the entry in a partition it can share with others, so a group can be
 * listed or dropped in one call: `{ pk: "store:nyc-01", sk: "1700:1800" }`
 * keeps every cached window of one store together.
 */
export type LambderCacheKey = string | {
    pk: string;
    sk: string;
};
export interface LambderCacheSetOptions {
    /** How long the entry lives. Default: the cache's own defaultTtlSeconds. */
    ttlSeconds?: number;
}
export interface LambderCacheListOptions {
    /** Only sort keys starting with this prefix. */
    prefix?: string;
    /** Cap on RESULTS, not on entries read. */
    limit?: number;
}
/**
 * What an app asks of a cache. LambderDdbCache and LambderMemoryCache
 * implement it with the same rules (the same key limits, the same JSON round
 * trip, the same expiry), so code written against this interface behaves the
 * same over either.
 *
 * Values are JSON: what `set` is handed is stored as its JSON text and `get`
 * hands back a parse of it, never the object that was stored.
 */
export interface LambderCache {
    /** The value, or undefined when it is absent or past its TTL. */
    get<T>(key: LambderCacheKey): Promise<T | undefined>;
    has(key: LambderCacheKey): Promise<boolean>;
    /** Stores the value's JSON; throws for a value JSON cannot represent (undefined, a function). */
    set<T>(key: LambderCacheKey, value: T, options?: LambderCacheSetOptions): Promise<void>;
    /** True when there was a live entry to delete: a load in progress for the key, or an entry past its TTL, is none. */
    delete(key: LambderCacheKey): Promise<boolean>;
    /** Drops every entry stored under one `pk` and answers how many live ones there were. */
    deletePartition(partition: string): Promise<number>;
    /** The live sort keys stored under one `pk`, in sort-key order. Plain-string entries have none, so they never appear. */
    listSortKeys(partition: string, options?: LambderCacheListOptions): Promise<string[]>;
    /**
     * The cached value, or the loader's once it has been stored, as the
     * stored JSON either way, so the call that filled the entry answers what
     * every later one does. Concurrent calls for one key in one process share
     * a single load, each handed a parse of its own, so one caller's change to
     * its answer never shows in another's. A loader's undefined is not cached
     * (return null to cache "not found"), and a value the cache fails to store
     * is handed back uncached, as the same JSON. So is the value of a load
     * that a `set`, `delete` or `deletePartition` of the key overtook: the
     * loader may have read its source before that write, so its value never
     * lands over it. An invalid option throws before anything is read or
     * loaded.
     */
    getOrSet<T>(key: LambderCacheKey, loader: () => Promise<T>, options?: LambderCacheSetOptions): Promise<T>;
}

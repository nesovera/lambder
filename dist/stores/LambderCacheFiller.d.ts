/**
 * How a cache's fill runs the loader and keeps its value: `store` writes the
 * value where the cache keeps it and answers it as stored. Handed to the
 * cache at the point it fills, so the store can carry what only that point
 * knows (LambderDdbCache's fill lease).
 */
export type LambderCacheLoad<T> = (store: (value: T) => Promise<T>) => Promise<T>;
/**
 * getOrSet's contract, shared by every cache here: concurrent calls for one
 * key in one process share a single load, each handed a parse of its own as
 * every read is, a loader's failure is the caller's, and the cache's own
 * failure (a read, a lease, a write) never is.
 * A cache failure after the loader answered hands that value back uncached,
 * and one before the loader ran calls the loader directly, so the loader runs
 * at most once per call whatever breaks. A loader's undefined has nothing to
 * cache and comes back as it is, so the next call loads again (a loader
 * answers null to cache "not found"); anything else is answered as the JSON
 * it was stored as, the filling call included, so it has the shape every
 * later hit has.
 *
 * A write of the key (set, delete, deletePartition) while a fill is loading
 * wins over the fill: the loader may have read its source before whatever
 * that write records, so storing its value afterwards would put back what the
 * write replaced. The write takes the fill out of the in-flight map, a fill
 * stores only while the map still holds it, and a call arriving after the
 * write starts a load of its own instead of joining the old one. The old
 * fill's callers get its value uncached.
 *
 * LambderDdbCache and LambderMemoryCache each supply only their read-then-fill
 * and hold one filler, so the two cannot drift on any of the above.
 */
export declare class LambderCacheFiller {
    private readonly inFlight;
    /** Opens the log line of a fail-open, naming the cache: "DynamoDB cache failed open in geo". */
    private readonly failOpenLabel;
    constructor(failOpenLabel: string);
    /**
     * The value for `memoryKey`: `readOrFill` is the cache's own read, and
     * its fill when the read finds nothing, handed `load` to call (at most
     * once) at that point with the store that keeps the loader's value.
     */
    getOrSet<T>(memoryKey: string, loader: () => Promise<T>, readOrFill: (load: LambderCacheLoad<T>) => Promise<T>): Promise<T>;
    /** Called by a write of `memoryKey` before it writes: the fill in flight for it stores nothing (see the class comment). */
    supersedeFill(memoryKey: string): void;
    /** supersedeFill for every key starting with `memoryKeyPrefix`: one partition's keys, or all of them for "". */
    supersedeFillsWithPrefix(memoryKeyPrefix: string): void;
    private failOpen;
}

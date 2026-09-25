import { asStoredJson } from "./LambderCacheValues.js";

/**
 * How a cache's fill runs the loader and keeps its value: `store` writes the
 * value where the cache keeps it and answers it as stored. Handed to the
 * cache at the point it fills, so the store can carry what only that point
 * knows (LambderDdbCache's fill lease).
 */
export type LambderCacheLoad<T> = (store: (value: T) => Promise<T>) => Promise<T>;

/** One getOrSet in flight for a key, shared by the calls that join it (see LambderCacheFiller.getOrSet). */
interface SharedFill {
    /** What the first call answers. */
    answer: Promise<unknown>;
    /** Calls that joined after the first. */
    joiners: number;
    /** The answer as JSON text, taken once as it settles when a call joined; undefined for an answer JSON cannot hold. */
    answerJson?: string;
}

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
export class LambderCacheFiller {
    private readonly inFlight = new Map<string, SharedFill>();
    /** Opens the log line of a fail-open, naming the cache: "DynamoDB cache failed open in geo". */
    private readonly failOpenLabel: string;

    constructor(failOpenLabel: string){
        this.failOpenLabel = failOpenLabel;
    }

    /**
     * The value for `memoryKey`: `readOrFill` is the cache's own read, and
     * its fill when the read finds nothing, handed `load` to call (at most
     * once) at that point with the store that keeps the loader's value.
     */
    getOrSet<T>(
        memoryKey: string,
        loader: () => Promise<T>,
        readOrFill: (load: LambderCacheLoad<T>) => Promise<T>,
    ): Promise<T> {
        const current = this.inFlight.get(memoryKey);
        if(current){
            // A parse of its own, as a read hands back: the first call's
            // object is that caller's to change, and a change must not show
            // in anyone else's answer.
            current.joiners += 1;
            return current.answer.then((value) => current.answerJson === undefined ? value : JSON.parse(current.answerJson)) as Promise<T>;
        }

        const leave = () => {
            // A write may have handed the key to a newer fill meanwhile.
            if(this.inFlight.get(memoryKey) === shared) this.inFlight.delete(memoryKey);
        };
        const shared: SharedFill = {
            joiners: 0,
            answer: this.failOpen(loader, readOrFill, () => this.inFlight.get(memoryKey) !== shared).then(
                (value) => {
                    // Out of the map in the same step the text is taken, and
                    // before any caller holds the value: no call joins after
                    // this, and none has changed the value yet.
                    leave();
                    if(shared.joiners > 0){
                        // A value JSON cannot hold (a bigint the loader
                        // answered on a fail-open) goes to every caller as it is.
                        try { shared.answerJson = JSON.stringify(value); } catch {}
                    }
                    return value;
                },
                (error: unknown) => {
                    leave();
                    throw error;
                },
            ),
        };
        this.inFlight.set(memoryKey, shared);
        return shared.answer as Promise<T>;
    }

    /** Called by a write of `memoryKey` before it writes: the fill in flight for it stores nothing (see the class comment). */
    supersedeFill(memoryKey: string): void {
        this.inFlight.delete(memoryKey);
    }

    /** supersedeFill for every key starting with `memoryKeyPrefix`: one partition's keys, or all of them for "". */
    supersedeFillsWithPrefix(memoryKeyPrefix: string): void {
        for(const memoryKey of [...this.inFlight.keys()]){
            if(memoryKey.startsWith(memoryKeyPrefix)) this.inFlight.delete(memoryKey);
        }
    }

    private async failOpen<T>(
        loader: () => Promise<T>,
        readOrFill: (load: LambderCacheLoad<T>) => Promise<T>,
        superseded: () => boolean,
    ): Promise<T> {
        let loaderStarted = false;
        let loaderCompleted = false;
        let loaderValue: T | undefined;
        const trackedLoader = async (): Promise<T> => {
            loaderStarted = true;
            loaderValue = await loader();
            loaderCompleted = true;
            return loaderValue;
        };

        const load: LambderCacheLoad<T> = async (store) => {
            const value = await trackedLoader();
            if(value === undefined) return value;
            if(superseded()) return asStoredJson(value);
            return await store(value);
        };

        try {
            return await readOrFill(load);
        } catch(error){
            if(loaderStarted && !loaderCompleted) throw error;
            // The key stays out of the line: it is the app's data (an email
            // address, a user id), and the other engines keep theirs out too.
            console.error(`${this.failOpenLabel}; the loader's value is handed back uncached.`, error);
            if(loaderCompleted) return asStoredJson(loaderValue as T);
            return asStoredJson(await trackedLoader());
        }
    }
}

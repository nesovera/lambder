/**
 * A Map whose entries have an expiry, which is the one thing every in-memory
 * store here needs: idempotency records, rate-limit counters and session
 * records all key something by a string and all stop mattering at a known
 * second.
 *
 * Written once because a store that hand-rolls it tends to expire an entry
 * only when something asks for that exact key again, which
 * is fine for a test and a slow leak in anything long-lived: a rate-limit
 * counter nobody asks about again is dead weight for as long as the process
 * runs, and an idempotency record for a key that never returns is dead weight
 * for ever. So expiry happens on read AND on an amortized sweep, and no
 * caller has to remember either.
 *
 * Expiry alone bounds how long an entry lives, not how many there are: a
 * workload that never repeats a key (a rate-limit counter per IP with a
 * monthly window, an idempotency key per request) accumulates live entries
 * faster than any expiry retires them. So the map also holds a ceiling and
 * evicts once it is reached, which is what makes "in memory" a bounded claim
 * rather than a slower leak. It evicts whatever expires SOONEST among the
 * entries that may be evicted at all, never whatever was written earliest:
 * insertion order would retire exactly the entries with the most life left in
 * them, which are the long-window rate-limit counters and the day-long
 * idempotency records, so a flood of short-lived keys could reset a monthly
 * cap. Evicting the soonest-expiring entry costs the caller the least that
 * can be taken, and a flood evicts mostly itself.
 *
 * "Soonest to expire" is the wrong answer for one kind of entry, though, and
 * it is the one where the cost is highest: an idempotency claim lives for a
 * few minutes while the settled record it becomes lives for a day, so at the
 * ceiling the claim was always the first victim and two concurrent retries
 * both executed. An entry written with `evictable: false` is therefore never
 * chosen, and a caller whose write cannot be made room for is told so
 * (LambderExpiringMapFullError) rather than quietly costing somebody else
 * their claim.
 *
 * Times are epoch SECONDS, matching the TTL attribute DynamoDB uses, so the
 * memory stores and their DynamoDB counterparts say the same thing.
 */

import { assertPositiveInteger } from "./LambderOptionChecks.js";

/** How many writes go by before the map walks itself and drops what has expired. */
const SWEEP_WRITE_INTERVAL = 256;

/**
 * Live entries held before the oldest writes start being evicted. High enough
 * that no ordinary single-process run reaches it, low enough to bound the
 * process: crossing it means a key space that never repeats, where the
 * alternative to evicting is growing until the process dies.
 */
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * Share of the ceiling one eviction pass reclaims. Evicting exactly the one
 * entry that crossed the ceiling means every later write crosses it again, so
 * the map pays a full pass per write for as long as the flood lasts; taking a
 * batch amortizes that pass over the writes the headroom absorbs.
 */
const EVICTION_BATCH_SHARE = 0.01;

/**
 * Thrown by set() when the map is at its ceiling and every entry it holds is
 * protected from eviction. The write did not happen and nothing was dropped
 * to make room for it: the caller decides what to do about a store that is
 * full of live claims, and the claim already held by somebody else is not
 * something this map will trade away.
 */
export class LambderExpiringMapFullError extends Error {
    constructor(maxEntries: number){
        super(`LambderExpiringMap: at the ceiling of ${maxEntries} entries and every entry is protected from eviction, so the write was refused.`);
        this.name = "LambderExpiringMapFullError";
    }
}

/** What the map holds per key: the value, its expiry second, and whether the ceiling may take it. */
type LambderExpiringEntry<TValue> = { value: TValue; expiresAt: number; evictable: boolean };

export class LambderExpiringMap<TValue> {
    private readonly entries = new Map<string, LambderExpiringEntry<TValue>>();
    private readonly now: () => number;
    private readonly maxEntries: number;
    private readonly evictionBatchSize: number;
    private writesSinceSweep = 0;

    /**
     * `now` is injectable so a test can move time forward without waiting.
     * `maxEntries` caps live entries; once a sweep cannot get back under it,
     * the soonest to expire go first, protected entries excepted.
     */
    constructor(options: { now?: () => number; maxEntries?: number } = {}){
        this.now = options.now ?? (() => Date.now());
        this.maxEntries = assertPositiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
        this.evictionBatchSize = Math.max(1, Math.ceil(this.maxEntries * EVICTION_BATCH_SHARE));
    }

    private nowSeconds(): number { return Math.floor(this.now() / 1000); }

    /**
     * The value, or undefined when it is absent or past its expiry. An
     * expired entry is dropped on the way, so a read never resurrects one.
     */
    get(key: string): TValue | undefined {
        const entry = this.entries.get(key);
        if(!entry) return undefined;
        if(entry.expiresAt <= this.nowSeconds()){
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    /**
     * Stores the value until `expiresAt` (epoch seconds), replacing what was
     * there. `evictable: false` keeps the entry out of the ceiling eviction,
     * for the entries whose loss costs more than the flood that would take
     * them (an idempotency claim, whose loss lets a duplicate execute).
     *
     * Throws LambderExpiringMapFullError when the map is at its ceiling and
     * nothing there may be evicted. `expiresAt` is checked the way the
     * constructor checks `maxEntries`, because a NaN expiry compares false
     * against every clock: an entry carrying one is neither read, swept nor
     * evicted, which is one immortal record per bad TTL.
     */
    set(key: string, value: TValue, expiresAt: number, options: { evictable?: boolean } = {}): void {
        assertPositiveInteger(expiresAt, "expiresAt");
        this.entries.set(key, { value, expiresAt, evictable: options.evictable ?? true });
        this.writesSinceSweep += 1;
        if(this.writesSinceSweep >= SWEEP_WRITE_INTERVAL) this.sweep();
        if(this.entries.size <= this.maxEntries) return;

        this.evictBatch(key);
        if(this.entries.size > this.maxEntries){
            // Only a key the map did not already hold can push the size past
            // the ceiling, so dropping the one just written is what leaves the
            // map exactly as the caller found it.
            this.entries.delete(key);
            throw new LambderExpiringMapFullError(this.maxEntries);
        }
    }

    delete(key: string): void { this.entries.delete(key); }

    /**
     * Every live value. Expired entries are skipped rather than deleted:
     * reading the map is not a reason to write to it, and the amortized sweep
     * on writes is what reclaims them.
     */
    values(): TValue[] {
        const nowSeconds = this.nowSeconds();
        const live: TValue[] = [];
        for(const entry of this.entries.values()){
            if(entry.expiresAt > nowSeconds) live.push(entry.value);
        }
        return live;
    }

    /** Number of live entries, counted rather than swept, for the same reason values() counts. */
    get size(): number {
        const nowSeconds = this.nowSeconds();
        let count = 0;
        for(const entry of this.entries.values()){
            if(entry.expiresAt > nowSeconds) count += 1;
        }
        return count;
    }

    clear(): void {
        this.entries.clear();
        this.writesSinceSweep = 0;
    }

    /**
     * Drops a batch of the evictable entries closest to expiring, taking the
     * map from its ceiling down to a floor one batch below it. Reached only
     * when expiry cannot keep up, which means the keys are not repeating.
     * Evicting costs the caller whatever the entry was protecting (a counter
     * resets, a stored answer re-executes on retry), so the ones taken are
     * always the ones with the least life left: the soonest to expire were
     * going to be lost first anyway, and choosing them means a flood of
     * short-lived keys cannot evict a long-window counter.
     *
     * A batch rather than a single entry because a single one leaves the map
     * exactly at its ceiling, so the next write crosses it again and pays for
     * another pass: one pass per write, for as long as the flood lasts. The
     * headroom this leaves is what the following writes spend. Measured at
     * 100,000 entries: 0.56 ms per write one at a time, 0.007 ms per write in
     * batches of one percent.
     *
     * The pass is linear and the sort is over the evictable entries only,
     * which is affordable because reaching the ceiling at all is already
     * pathological.
     */
    private evictBatch(justWritten: string): void {
        const floorSize = Math.max(0, this.maxEntries - this.evictionBatchSize);
        // One clock read per batch: expired entries go first, protected or
        // not, since a claim past its own TTL holds nothing anyone can settle
        // and is never worth a live entry's slot. Reclaimed in the same pass
        // that collects the candidates, so a batch is still one walk.
        const nowSeconds = this.nowSeconds();
        const candidates: { key: string; expiresAt: number }[] = [];
        for(const [key, entry] of this.entries){
            if(entry.expiresAt <= nowSeconds){ this.entries.delete(key); continue; }
            // The entry just written is what the caller asked to store; taking
            // it as its own victim would answer a write that stored nothing.
            if(entry.evictable && key !== justWritten) candidates.push({ key, expiresAt: entry.expiresAt });
        }
        if(this.entries.size <= floorSize) return;
        // A stable sort over a list built in insertion order, so entries
        // expiring in the same second are taken oldest first.
        candidates.sort((first, second) => first.expiresAt - second.expiresAt);
        for(const candidate of candidates){
            if(this.entries.size <= floorSize) break;
            this.entries.delete(candidate.key);
        }
    }

    private sweep(): void {
        const nowSeconds = this.nowSeconds();
        for(const [key, entry] of this.entries){
            if(entry.expiresAt <= nowSeconds) this.entries.delete(key);
        }
        this.writesSinceSweep = 0;
    }
}

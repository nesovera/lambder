/**
 * A Map whose entries expire, which every in-memory store here needs:
 * idempotency records, rate-limit counters and session records all key
 * something by a string and all stop mattering at a known second.
 *
 * Entries expire on read and on an amortized sweep, so no caller has to
 * remember either. Expiring only when the same key is read again would leak
 * in anything long-lived: a counter nobody asks about again, or a record for
 * a key that never returns, would stay for as long as the process runs.
 *
 * Expiry bounds how long an entry lives, not how many there are: a workload
 * that never repeats a key (a per-IP counter with a monthly window, an
 * idempotency key per request) accumulates live entries faster than expiry
 * retires them. So the map also holds a ceiling, where it evicts the
 * evictable entries that expire soonest. Insertion order would instead
 * retire the entries with the most life left (long-window counters, day-long
 * idempotency records), letting a flood of short-lived keys reset a monthly
 * cap; soonest-to-expire costs the caller least, and a flood evicts mostly
 * itself.
 *
 * An idempotency claim lives minutes while the record it settles into lives
 * a day, so at the ceiling it would always be the first victim and two
 * concurrent retries would both execute. An entry written with `evictable:
 * false` is never chosen, and a write that cannot be made room for is
 * refused (LambderExpiringMapFullError) rather than costing somebody else
 * their claim.
 *
 * Times are epoch seconds, matching DynamoDB's TTL attribute, so the memory
 * stores and their DynamoDB counterparts say the same thing.
 */
import { assertPositiveInteger } from "./LambderOptionChecks.js";
/** How many writes go by before the map walks itself and drops what has expired. */
const SWEEP_WRITE_INTERVAL = 256;
/**
 * Live entries held before eviction starts. High enough that no ordinary
 * single-process run reaches it, low enough to bound the process: crossing it
 * means a key space that never repeats, where the alternative to evicting is
 * growing until the process dies.
 */
const DEFAULT_MAX_ENTRIES = 100_000;
/**
 * Share of the ceiling one eviction pass reclaims, so the pass is amortized
 * over the writes the headroom absorbs (see evictBatch).
 */
const EVICTION_BATCH_SHARE = 0.01;
/**
 * Thrown by set() when the map is at its ceiling and every entry it holds is
 * protected from eviction. The write did not happen and nothing was dropped
 * to make room for it: the caller decides what to do about a store full of
 * live claims, and a claim somebody else holds is never traded away.
 */
export class LambderExpiringMapFullError extends Error {
    constructor(maxEntries) {
        super(`LambderExpiringMap: at the ceiling of ${maxEntries} entries and every entry is protected from eviction, so the write was refused.`);
        this.name = "LambderExpiringMapFullError";
    }
}
export class LambderExpiringMap {
    entries = new Map();
    now;
    maxEntries;
    evictionBatchSize;
    writesSinceSweep = 0;
    /**
     * `now` is injectable so a test can move time forward without waiting.
     * `maxEntries` caps live entries; once a sweep cannot get back under it,
     * the soonest to expire go first, protected entries excepted.
     */
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.maxEntries = assertPositiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
        this.evictionBatchSize = Math.max(1, Math.ceil(this.maxEntries * EVICTION_BATCH_SHARE));
    }
    nowSeconds() { return Math.floor(this.now() / 1000); }
    /**
     * The value, or undefined when it is absent or past its expiry. An
     * expired entry is dropped on the way, so a read never resurrects one.
     */
    get(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return undefined;
        if (entry.expiresAt <= this.nowSeconds()) {
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
    set(key, value, expiresAt, options = {}) {
        assertPositiveInteger(expiresAt, "expiresAt");
        this.entries.set(key, { value, expiresAt, evictable: options.evictable ?? true });
        this.writesSinceSweep += 1;
        if (this.writesSinceSweep >= SWEEP_WRITE_INTERVAL)
            this.sweep();
        if (this.entries.size <= this.maxEntries)
            return;
        this.evictBatch(key);
        if (this.entries.size > this.maxEntries) {
            // Only a key the map did not already hold can push the size past
            // the ceiling, so dropping the one just written is what leaves the
            // map exactly as the caller found it.
            this.entries.delete(key);
            throw new LambderExpiringMapFullError(this.maxEntries);
        }
    }
    delete(key) { this.entries.delete(key); }
    /**
     * Every live value. Expired entries are skipped rather than deleted:
     * reading the map is not a reason to write to it, and the amortized sweep
     * on writes is what reclaims them.
     */
    values() {
        const nowSeconds = this.nowSeconds();
        const live = [];
        for (const entry of this.entries.values()) {
            if (entry.expiresAt > nowSeconds)
                live.push(entry.value);
        }
        return live;
    }
    /** Number of live entries, counted rather than swept, for the same reason values() counts. */
    get size() {
        const nowSeconds = this.nowSeconds();
        let count = 0;
        for (const entry of this.entries.values()) {
            if (entry.expiresAt > nowSeconds)
                count += 1;
        }
        return count;
    }
    clear() {
        this.entries.clear();
        this.writesSinceSweep = 0;
    }
    /**
     * Drops a batch of the evictable entries closest to expiring, taking the
     * map from its ceiling down to a floor one batch below it. Reached only
     * when expiry cannot keep up, which means the keys are not repeating.
     * Evicting costs the caller whatever the entry protected (a counter
     * resets, a stored answer re-executes on retry), so the entries taken are
     * those with the least life left, and a flood of short-lived keys cannot
     * evict a long-window counter.
     *
     * A batch rather than one entry, because one leaves the map exactly at
     * its ceiling and the next write pays for another pass: one pass per
     * write for as long as the flood lasts. At 100,000 entries that is 0.56
     * ms per write, against 0.007 ms with batches of one percent.
     *
     * The pass is linear and the sort covers only evictable entries, which is
     * affordable because reaching the ceiling at all is already pathological.
     */
    evictBatch(justWritten) {
        const floorSize = Math.max(0, this.maxEntries - this.evictionBatchSize);
        // One clock read per batch: expired entries go first, protected or
        // not, since a claim past its own TTL holds nothing anyone can settle
        // and is never worth a live entry's slot. Reclaimed in the same pass
        // that collects the candidates, so a batch is still one walk.
        const nowSeconds = this.nowSeconds();
        const candidates = [];
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= nowSeconds) {
                this.entries.delete(key);
                continue;
            }
            // The entry just written is what the caller asked to store; taking
            // it as its own victim would answer a write that stored nothing.
            if (entry.evictable && key !== justWritten)
                candidates.push({ key, expiresAt: entry.expiresAt });
        }
        if (this.entries.size <= floorSize)
            return;
        // A stable sort over a list built in insertion order, so entries
        // expiring in the same second are taken oldest first.
        candidates.sort((first, second) => first.expiresAt - second.expiresAt);
        for (const candidate of candidates) {
            if (this.entries.size <= floorSize)
                break;
            this.entries.delete(candidate.key);
        }
    }
    sweep() {
        const nowSeconds = this.nowSeconds();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= nowSeconds)
                this.entries.delete(key);
        }
        this.writesSinceSweep = 0;
    }
}

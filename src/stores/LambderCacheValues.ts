import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";

/*
 * What a cache value has to be, and how a cache call's options are read, for
 * every cache here.
 *
 * LambderDdbCache and LambderMemoryCache refuse the same values and the same
 * options for the reason they refuse the same keys (see LambderCacheKeys): a
 * test that runs over the memory cache must not accept what production then
 * throws on. So the rules are written once, here, and both caches call them.
 */

/** How long an entry lives when neither the call nor the cache names a TTL: one year. */
export const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Largest value a cache accepts unless told otherwise, in UTF-8 bytes of its JSON: 32 MiB. */
export const DEFAULT_MAX_VALUE_BYTES = 32 * 1024 * 1024;
/** How long LambderDdbCache's fill lease holds when getOrSet names none. */
const DEFAULT_LEASE_SECONDS = 15;

/** A value as a cache stores it: its JSON text, and that text's UTF-8 bytes. */
export interface LambderCacheValueText {
    json: string;
    utf8: Uint8Array;
}

/** getOrSet's options once checked, the defaults filled in. */
export interface LambderCacheFillSettings {
    ttlSeconds: number;
    leaseSeconds: number;
    waitForFillMs: number;
}

/**
 * The value as a cache stores it, or a throw when no cache here can hold it:
 * a value JSON cannot represent (undefined, a function) or one whose JSON is
 * past `maxValueBytes`.
 */
export const serializeCacheValue = (value: unknown, maxValueBytes: number): LambderCacheValueText => {
    const json = JSON.stringify(value);
    if(json === undefined) throw new Error("Cache value must be JSON-serializable");
    const utf8 = new TextEncoder().encode(json);
    if(utf8.length > maxValueBytes){
        throw new Error(`Cache value exceeds maxValueBytes (${utf8.length} > ${maxValueBytes})`);
    }
    return { json, utf8 };
};

/**
 * The value as a cache hands a stored one back, a JSON round trip, so a value
 * handed back uncached (a fail-open, a fill a write overtook) has the shape a
 * hit has (a Date as its string). A value JSON cannot hold (undefined, a
 * bigint) is handed back as it is.
 */
export const asStoredJson = <T>(value: T): T => {
    let json: string | undefined;
    try { json = JSON.stringify(value); } catch { return value; }
    return json === undefined ? value : JSON.parse(json) as T;
};

/** A write's TTL: the call's own or the cache's default, checked either way. */
export const resolveCacheTtlSeconds = (ttlSeconds: number | undefined, defaultTtlSeconds: number): number =>
    assertPositiveInteger(ttlSeconds ?? defaultTtlSeconds, "ttlSeconds");

/**
 * getOrSet's options, checked before the call reaches the fail-open (see
 * LambderCacheFiller). Checked inside it, a bad option would read as the
 * cache failing: every call would log, hand the loader's value back
 * uncached, and caching would be off without the caller ever seeing why.
 *
 * The lease options are LambderDdbCache's. The memory cache holds no lease
 * but checks them all the same, so an options object that the table refuses
 * is refused by its twin too.
 */
export const resolveGetOrSetOptions = (
    options: { ttlSeconds?: number, leaseSeconds?: number, waitForFillMs?: number },
    defaultTtlSeconds: number,
): LambderCacheFillSettings => {
    const leaseSeconds = assertPositiveInteger(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS, "leaseSeconds");
    return {
        ttlSeconds: resolveCacheTtlSeconds(options.ttlSeconds, defaultTtlSeconds),
        leaseSeconds,
        // As long as the holder's lease lasts, and a second more, by default:
        // a waiter that gives up sooner runs the loader itself while the
        // holder is still loading, so ten containers asking for one slow key
        // would load it ten times. The extra second is the lease's own
        // rounding: it expires in whole seconds, so a crashed holder's lease
        // becomes free up to a second after it runs out, and a waiter should
        // still be there to take it.
        waitForFillMs: assertPositiveInteger(options.waitForFillMs ?? (leaseSeconds + 1) * 1000, "waitForFillMs"),
    };
};

/** How long an entry lives when neither the call nor the cache names a TTL: one year. */
export declare const DEFAULT_TTL_SECONDS: number;
/** Largest value a cache accepts unless told otherwise, in UTF-8 bytes of its JSON: 32 MiB. */
export declare const DEFAULT_MAX_VALUE_BYTES: number;
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
export declare const serializeCacheValue: (value: unknown, maxValueBytes: number) => LambderCacheValueText;
/**
 * The value as a cache hands a stored one back, a JSON round trip, so a value
 * handed back uncached (a fail-open, a fill a write overtook) has the shape a
 * hit has (a Date as its string). A value JSON cannot hold (undefined, a
 * bigint) is handed back as it is.
 */
export declare const asStoredJson: <T>(value: T) => T;
/** A write's TTL: the call's own or the cache's default, checked either way. */
export declare const resolveCacheTtlSeconds: (ttlSeconds: number | undefined, defaultTtlSeconds: number) => number;
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
export declare const resolveGetOrSetOptions: (options: {
    ttlSeconds?: number;
    leaseSeconds?: number;
    waitForFillMs?: number;
}, defaultTtlSeconds: number) => LambderCacheFillSettings;

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { type LambderCompressionOption } from "../shared/wire/LambderCompressionOption.js";
import type { LambderCache, LambderCacheKey, LambderCacheListOptions, LambderCacheSetOptions } from "../shared/contracts/LambderCache.js";
export interface LambderDdbCacheOptions {
    tableName: string;
    /** Region the client is created for on first use; the SDK's default chain otherwise. */
    region?: string;
    /** Partition key prefix, keeps cache items separated from other systems in a shared table. Default: "CACHE". */
    keyPrefix?: string;
    namespace?: string;
    defaultTtlSeconds?: number;
    chunkBytes?: number;
    /**
     * Brotli compression of stored values. `true` (the default) is
     * `{ minBytes: 0, quality: 5 }`: every value compressed; `false` stores
     * values plain; an object overrides the defaults. The manifest records
     * each value's encoding, so it can be switched on or off on a live table.
     */
    compression?: LambderCompressionOption;
    maxValueBytes?: number;
    memoryMaxBytes?: number;
    client?: DynamoDBClient;
    /**
     * The clock entries are expired against, injectable the way the rate
     * limiter's and the idempotency store's are, so a test can cross a TTL
     * boundary without moving the world's clock.
     */
    now?: () => number;
}
export interface LambderDdbCacheGetOrSetOptions extends LambderCacheSetOptions {
    /** How long one container's fill lease on a missing entry holds the others off. Default: 15. */
    leaseSeconds?: number;
    /** How long a container waits for another's fill before loading itself. Default: (leaseSeconds + 1) * 1000. */
    waitForFillMs?: number;
}
/**
 * Persistent JSON cache backed by DynamoDB.
 *
 * Values are Brotli-compressed by default (`compression` option; the manifest
 * records each value's encoding, so the option can be switched on a live
 * table). Values within the safe DynamoDB item budget are stored directly in
 * the manifest for a single-request read; larger values are split into
 * versioned binary chunks. A manifest is written only after every chunk
 * succeeds, so readers see either the previous complete version or the new
 * one. DynamoDB TTL is cleanup only; every read also checks expiresAt because
 * TTL deletion can lag.
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on
 * `expiresAt`. Items are prefixed `CACHE#<namespace>#` by default, so the
 * table can be shared with LambderDdbRateLimiter (`RL#`) and
 * LambderDdbIdempotencyStore (`IDEM#`) without key collisions.
 *
 * A key may also be a `{ pk, sk }` pair, which groups entries under one
 * partition so `deletePartition` and `listSortKeys` can work on the group
 * without knowing its members. Only the `pk` part is hashed into the
 * DynamoDB partition key; the sort key is stored readable, which makes
 * prefix queries possible. Plain-string keys use the bare item keys (`meta`,
 * `chunk#...`) and grouped entries live beside them under
 * `sk#<encoded sort key>#...`, so both forms can share a partition.
 *
 * getOrSet's fill lease lives on the entry's manifest item (see takeLease),
 * and a fill publishes only while its lease is still there. `set` replaces
 * the manifest, and `delete` and `deletePartition` remove it, lease and all,
 * so a fill that started before any of them never stores over it. Both find
 * what to remove on the leader (`delete` by the manifest's own key,
 * `deletePartition` with a consistent Query), since a replica may not have
 * seen a value or a lease the table accepted a moment before.
 *
 * Implements LambderCache, so code typed against the interface runs over
 * LambderMemoryCache in a test.
 */
export declare class LambderDdbCache implements LambderCache {
    readonly tableName: string;
    readonly keyPrefix: string;
    readonly namespace: string;
    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    private readonly ready;
    private readonly defaultTtlSeconds;
    private readonly chunkBytes;
    private readonly compression;
    private readonly maxValueBytes;
    private readonly memory;
    /** getOrSet's single-flight and fail-open, shared with LambderMemoryCache (see LambderCacheFiller). */
    private readonly filler;
    private readonly now;
    /** This instance's own writes, as its reads and its memory layer need to know them (see LocalWriteLedger). */
    private readonly localWrites;
    constructor(options: LambderDdbCacheOptions);
    get<T>(key: LambderCacheKey): Promise<T | undefined>;
    private getByAddress;
    /**
     * The value a manifest the leader answered describes, its chunks read
     * consistently, or undefined when it fails that read: then it is corrupt,
     * and its manifest is dropped. `overtaken` comes from the read's watch
     * (see LocalWriteLedger).
     */
    private readLeaderEntry;
    /**
     * The value a manifest describes, checked against it and kept in the
     * memory layer unless a write of the key finished while it was read
     * (`overtaken`, see LocalWriteLedger).
     */
    private readEntry;
    has(key: LambderCacheKey): Promise<boolean>;
    set<T>(key: LambderCacheKey, value: T, options?: LambderCacheSetOptions): Promise<void>;
    /**
     * Stores the value and hands back what was stored, the parse of its
     * JSON: what every later read answers too.
     *
     * With `leaseOwner` it is a fill publishing under its lease, and the
     * manifest is written only while that lease is still on it. A set,
     * delete or deletePartition since the lease was taken replaced or
     * removed it, and so did a waiter that took it over once it lapsed; the
     * loader may have read its source before any of those, so its value must
     * not land over them. A refused fill deletes the chunks it wrote, which
     * belong to no manifest, and hands its value back uncached. A write
     * winning is the design and is not logged; a takeover is logged, since it
     * means the loader ran past `leaseSeconds`, and while every fill does,
     * each is refused by the next takeover and the entry never fills. The
     * cure is a lease longer than the loader's worst case, which only the
     * caller can give.
     */
    private setByAddress;
    /**
     * The chunks of the version a manifest write just replaced, which nothing
     * reads any more and which would otherwise sit in the table until their
     * TTL: a large value refreshed hourly leaves a copy an hour. `ownVersion`
     * is the writer's own, which an SDK retry of a write that had already
     * landed reports as the replaced one.
     */
    private deleteReplacedChunks;
    /**
     * One version's chunk items, deleted. The write they belonged to is
     * settled whether or not this succeeds, and the chunks carry their own
     * TTL, so a failure here is logged, not the caller's.
     */
    private deleteChunks;
    /**
     * Removes the entry's manifest item, whatever it holds (a value, or a
     * fill's lease, whose publish is then refused), and its chunks. True when
     * the manifest held a live value: a lease or an expired value the table's
     * TTL has not removed yet is no entry.
     */
    delete(key: LambderCacheKey): Promise<boolean>;
    /**
     * Drop every entry stored under one `pk`, without knowing which sort keys
     * exist: the invalidation a group of related entries is worth grouping
     * for. Returns the number of live values removed. In-memory copies held
     * by OTHER Lambda containers still serve until their own TTL, as they do
     * after a single-entry delete.
     */
    deletePartition(partition: string): Promise<number>;
    /**
     * The live (unexpired) sort keys stored under one `pk`, in table order.
     * Plain-string entries have no sort key, so they never appear here.
     * The partition (or prefix range) is read whatever the limit, and reading
     * a partition whose values are chunked also reads those chunk items, so
     * grouping very large values makes listing more expensive.
     */
    listSortKeys(partition: string, options?: LambderCacheListOptions): Promise<string[]>;
    getOrSet<T>(key: LambderCacheKey, loader: () => Promise<T>, options?: LambderDdbCacheGetOrSetOptions): Promise<T>;
    /** The fill once a read found nothing: one container loads under the lease while the others wait for its value. */
    private fill;
    /**
     * Takes the fill lease on one entry by writing it onto the entry's
     * manifest item, a manifest with no value that the fill's publish then
     * replaces. Readers find no value on it, so to them it is a miss.
     *
     * The write is conditional on the item holding nothing live: none at
     * all, or one whose expiresAt has passed, whether an expired value or a
     * lapsed lease. So a lease never hides a live value, and a waiter taking
     * over a lapsed lease replaces the first holder's, whose publish is then
     * refused. An expired value the lease replaces goes at once, its chunks
     * with it, and readers see a miss until the fill publishes, as they did
     * from the moment it expired. DynamoDB's TTL removes a lease its holder
     * abandoned.
     *
     * A refusal hands back the item that refused it: "held" for another
     * fill's lease, and for a live value its manifest, which the caller
     * serves the value from. A manifest this instance cannot read (written
     * under another chunkBytes or maxValueBytes) is a miss to every read here
     * and would otherwise block fills until its TTL, so the lease is taken
     * over it, conditioned on it being the same manifest still.
     */
    private takeLease;
    /** Clears this fill's lease off the manifest item, conditional on it still being this fill's, so it never touches what replaced it. */
    private releaseLease;
    private readManifest;
    /**
     * The value a manifest item describes, or undefined when it describes
     * none this instance can read: a fill's lease with no value under it
     * yet, or a manifest that does not add up. Expiry is the caller's check.
     */
    private parseManifest;
    private readChunks;
    /** Every item matching a partition (optionally a sort-key prefix), following pagination. */
    private queryItems;
    private deleteItems;
    private invalidateManifest;
    private batchWrite;
    /** The JSON text of a stored payload. */
    private decode;
    private remember;
    private partitionKey;
    /**
     * One of an entry's item keys. A plain-string entry uses the bare
     * suffix; a grouped one nests under its escaped sort key, whose trailing
     * `#` is an unambiguous boundary because an escaped sort key never
     * contains a bare `#`.
     */
    private itemSortKey;
    private isManifestSortKey;
    private chunkSortKey;
    /** Drop every in-memory copy belonging to one partition. */
    private forgetPartition;
    private nowSeconds;
}

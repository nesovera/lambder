import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { type LambderCompressionOption } from "../shared/LambderCompressionOption.js";
export interface LambderDdbCacheOptions {
    tableName: string;
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
}
/**
 * Where a value lives. A plain string addresses one entry, as it always has.
 * `{ pk, sk }` puts the entry in a partition it can share with others, so a
 * group can be listed or dropped in one call: `{ pk: "division:ist-34", sk:
 * "1700:1800" }` keeps every cached window of one division together.
 * Only the `pk` part is hashed into the DynamoDB partition key; the sort key
 * is stored readable, which is what makes prefix queries possible.
 */
export type LambderCacheKey = string | {
    pk: string;
    sk: string;
};
export interface LambderDdbCacheSetOptions {
    ttlSeconds?: number;
}
export interface LambderDdbCacheGetOrSetOptions extends LambderDdbCacheSetOptions {
    leaseSeconds?: number;
    waitForFillMs?: number;
}
export interface LambderDdbCacheListOptions {
    /** Only sort keys starting with this raw (unescaped) prefix. */
    prefix?: string;
    /** Cap on RESULTS, not on items read: the partition (or prefix range) is read either way. */
    limit?: number;
}
/**
 * Persistent JSON cache backed by DynamoDB.
 *
 * Values are Brotli-compressed by default (`compression` option; the manifest
 * records each value's encoding, so the option can be switched on a live
 * table). Values within the safe DynamoDB item budget are stored directly in
 * the manifest for a single-request read; larger values are
 * split into versioned binary chunks. A manifest is written only after every
 * chunk succeeds, so readers see either the previous complete version or the
 * new complete version. DynamoDB TTL is cleanup only; every read also checks
 * expiresAt because TTL deletion can lag.
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on
 * `expiresAt`. Items are prefixed `CACHE#<namespace>#` by default, so the
 * table can be shared with LambderDdbRateLimiter (`RL#`) and
 * LambderDdbIdempotency (`IDEM#`) without key collisions.
 *
 * A key may also be a `{ pk, sk }` pair, which groups entries under one
 * partition so `deletePartition` and `listSortKeys` can work on the group
 * without knowing its members. Plain-string keys keep the exact item layout
 * they have always had (`meta`, `lock`, `chunk#...`), and grouped entries
 * live beside them under `sk#<encoded sort key>#...`, so both forms can
 * share a partition and a live table needs no migration.
 */
export declare class LambderDdbCache {
    readonly tableName: string;
    readonly keyPrefix: string;
    readonly namespace: string;
    private readonly client;
    private readonly defaultTtlSeconds;
    private readonly chunkBytes;
    private readonly compression;
    private readonly maxValueBytes;
    private readonly memory;
    private readonly inFlight;
    constructor(options: LambderDdbCacheOptions);
    get<T>(key: LambderCacheKey): Promise<T | undefined>;
    private getByAddress;
    has(key: LambderCacheKey): Promise<boolean>;
    set<T>(key: LambderCacheKey, value: T, options?: LambderDdbCacheSetOptions): Promise<void>;
    private setByAddress;
    delete(key: LambderCacheKey): Promise<boolean>;
    /**
     * Drop every entry stored under one `pk`, without knowing which sort keys
     * exist: the invalidation a group of related entries is worth grouping
     * for. Returns the number of entries removed. In-memory copies held by
     * OTHER Lambda containers still serve until their own TTL, as they do
     * after a single-entry delete.
     */
    deletePartition(partition: string): Promise<number>;
    /**
     * The live (unexpired) sort keys stored under one `pk`, in table order.
     * Plain-string entries have no sort key, so they never appear here.
     * Reading a partition whose values are chunked also reads those chunk
     * items, so grouping very large values makes listing more expensive.
     */
    listSortKeys(partition: string, options?: LambderDdbCacheListOptions): Promise<string[]>;
    getOrSet<T>(key: LambderCacheKey, factory: () => Promise<T>, options?: LambderDdbCacheGetOrSetOptions): Promise<T>;
    /**
     * Cache infrastructure is best-effort for getOrSet: read, lease, or write
     * failures return the loader value. Loader failures still propagate and the
     * loader is never repeated after it has completed successfully.
     */
    private getOrSetFailOpen;
    private fill;
    private acquireLease;
    private releaseLease;
    private readManifest;
    private readChunks;
    /** Every item matching a partition (optionally a sort-key prefix), following pagination. */
    private queryItems;
    private deleteItems;
    private invalidateManifest;
    private batchWrite;
    /** The JSON text of a stored payload. */
    private decode;
    private remember;
    private normalizeKey;
    private normalizePartition;
    /** Length-prefixed so a partition ending in the separator cannot collide with a sort key. */
    private memoryKeyOf;
    private partitionKey;
    /**
     * One of an entry's item keys. A plain-string entry keeps the bare
     * suffix it has always used; a grouped one nests under its escaped sort
     * key, whose trailing `#` is an unambiguous boundary because an escaped
     * sort key never contains a bare `#`.
     */
    private itemSortKey;
    /** The prefix covering every item of a grouped entry; null for a plain-string entry, which owns the bare item keys instead. */
    private entryItemPrefix;
    private isManifestSortKey;
    private chunkSortKey;
    /** Drop every in-memory copy belonging to one partition. */
    private forgetPartition;
    private nowSeconds;
    private isConditionalFailure;
}

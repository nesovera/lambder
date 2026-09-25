import type { AttributeValue, DynamoDBClient, WriteRequest } from "@aws-sdk/client-dynamodb";
import { createDynamoClientLoader, isConditionalCheckFailure, type LambderDynamoClientReady } from "./LambderDdbSdk.js";
import { getCrypto } from "../shared/util/LambderNodeModules.js";
import { LambderExpiringMap } from "../shared/util/LambderExpiringMap.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { compressText, restoreText, LambderCompressionError } from "../shared/wire/LambderCompressionCodec.js";
import {
    resolveCompressionOption,
    type LambderCompressionOption, type LambderCompressionSettings,
} from "../shared/wire/LambderCompressionOption.js";
import { LRUCache } from "lru-cache";
import type { LambderCache, LambderCacheKey, LambderCacheListOptions, LambderCacheSetOptions } from "../shared/contracts/LambderCache.js";
import {
    cacheMemoryKeyOf, decodeCacheSortKey, encodeCacheSortKey, normalizeCacheKey, normalizeCachePartition,
    type LambderCacheAddress,
} from "./LambderCacheKeys.js";
import {
    DEFAULT_MAX_VALUE_BYTES, DEFAULT_TTL_SECONDS, resolveCacheTtlSeconds, resolveGetOrSetOptions, serializeCacheValue,
    type LambderCacheFillSettings,
} from "./LambderCacheValues.js";
import { LambderCacheFiller, type LambderCacheLoad } from "./LambderCacheFiller.js";

const DEFAULT_CHUNK_BYTES = 350 * 1024;
const MAX_SAFE_CHUNK_BYTES = 380 * 1024;
const DEFAULT_MEMORY_BYTES = 16 * 1024 * 1024;
/**
 * What one memory-layer entry costs beyond its bytes and its key: the entry
 * object and the LRU's own bookkeeping for it. Counted so that many small
 * values fill the budget at the rate they actually use memory.
 */
const MEMORY_ENTRY_OVERHEAD_BYTES = 256;
const META_SORT_KEY = "meta";
const CHUNK_SORT_KEY_PREFIX = "chunk#";
/** Item-key prefix that separates entries addressed with a sort key from plain-key entries sharing the partition. */
const SORT_KEY_MARKER = "sk#";
const BATCH_WRITE_LIMIT = 25;
const MAX_BATCH_RETRIES = 8;
/** Every value compressed by default; see the `compression` option. */
const COMPRESSION_DEFAULTS: LambderCompressionSettings = { minBytes: 0, quality: 5 };
/**
 * How long this instance reads a key it wrote with consistent reads, in
 * seconds (whole ones, so from four to five). DynamoDB's replicas apply a
 * write well within that, and the margin costs little: only the keys this
 * instance wrote are read at a consistent read's price.
 */
const RECENT_WRITE_SECONDS = 5;
/** Keys, and partitions, remembered as recently written at most; past it the ones closest to expiring go first (see LambderExpiringMap). */
const RECENT_WRITE_MAX_ENTRIES = 1_000;

/** How a value's bytes are stored: Brotli, or the UTF-8 JSON itself. */
type CacheEncoding = "br" | "identity";

/** What one attempt at a fill lease found (see takeLease): the lease, another fill's lease, or a live value's manifest as the leader holds it. */
type LeaseAttempt = "taken" | "held" | { filled: CacheManifest };

/**
 * A stored entry that cannot be trusted: chunks that do not add up to what
 * the manifest describes, bytes that fail its checksum, or a restore the
 * codec would not vouch for (a LambderCompressionError, which is the same
 * answer in the compression layer's own words).
 *
 * A type rather than "anything thrown while reading the entry", because the
 * two are treated in opposite ways: a corrupt entry is dropped so the next
 * reader refills it, while a throttled or failed Query is the table being
 * busy. Deleting a healthy 2MB entry over one throttle would orphan its
 * chunks until their TTL and send every later reader to the origin, the load
 * the cache exists to absorb.
 */
class LambderCacheIntegrityError extends Error {
    constructor(message: string){
        super(message);
        this.name = "LambderCacheIntegrityError";
    }
}

/** A read that proves the entry wrong, as opposed to the table answering badly: only such an entry is ever dropped. */
const isEntryFault = (error: unknown): boolean =>
    error instanceof LambderCacheIntegrityError || error instanceof LambderCompressionError;

/**
 * Whether a manifest item holds an entry: a value whose expiresAt has not
 * passed. A fill's lease holds no value, and an expired value the table's TTL
 * has not removed yet is a miss to every read, so neither is one.
 */
const holdsLiveValue = (item: Record<string, AttributeValue> | undefined, nowSeconds: number): boolean =>
    item?.version?.S !== undefined && Number(item.expiresAt?.N) > nowSeconds;

interface CacheManifest {
    version: string;
    encoding: CacheEncoding;
    chunkCount: number;
    storedBytes: number;
    uncompressedBytes: number;
    checksum: string;
    expiresAt: number;
    inlineData?: Buffer;
}

interface MemoryEntry {
    stored: Buffer;
    encoding: CacheEncoding;
    uncompressedBytes: number;
    expiresAt: number;
}

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

// Node builtins are loaded lazily through LambderNodeModules so this module can
// sit in a frontend bundle's import graph (via the package root) without
// breaking; using the cache at runtime still requires Node.
const requireCrypto = async () => {
    const crypto = await getCrypto();
    if (!crypto) throw new Error("LambderDdbCache requires a Node.js environment.");
    return crypto;
};

const sha256 = async (value: string | Buffer): Promise<string> => {
    const crypto = await requireCrypto();
    return crypto.createHash("sha256").update(value).digest("hex");
};

const randomUUID = async (): Promise<string> => {
    const crypto = await requireCrypto();
    return crypto.randomUUID();
};

const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * What an instance's reads need to know about its own writes (set, delete,
 * deletePartition, a fill's publish), so that its memory layer never keeps a
 * value one of them replaced.
 *
 * The table does not answer in the order it applied writes, and an
 * eventually consistent read answers from a replica that may not have
 * applied the latest ones. So a value a read fetched can be one a write of
 * this instance had already replaced, in two ways:
 *
 * - The read overlapped the write. `watch` counts, per key, the writes that
 *   finish while an operation on the key is in flight, and the operation
 *   keeps what it got only when none did. Only keys with an operation in
 *   flight are held, so a write of one key never costs another key its copy.
 * - The read began after the write finished and reached a replica that had
 *   not applied it. For a few seconds after each write, `wroteRecently`
 *   answers true for the key (and for every key of a partition that
 *   deletePartition dropped), and the read goes to the leader instead.
 *
 * A write settles its key's memory copy as it finishes, keeping its own value
 * or dropping the copy, so whatever an earlier read kept cannot outlive it.
 */
class LocalWriteLedger {
    /** Per memory key with an operation in flight: how many there are, and how many writes of the key have finished since the first began. */
    private readonly keysInFlight = new Map<string, { operations: number, finishedWrites: number }>();
    private readonly recentKeys: LambderExpiringMap<true>;
    private readonly recentPartitions: LambderExpiringMap<true>;
    private readonly now: () => number;

    constructor(now: () => number){
        this.now = now;
        this.recentKeys = new LambderExpiringMap<true>({ now, maxEntries: RECENT_WRITE_MAX_ENTRIES });
        this.recentPartitions = new LambderExpiringMap<true>({ now, maxEntries: RECENT_WRITE_MAX_ENTRIES });
    }

    /**
     * Runs `operation` on one key, handing it `overtaken`, which answers
     * whether a write of the key (a deletePartition of its partition
     * included) has finished since the operation began.
     */
    async watch<T>(memoryKey: string, operation: (overtaken: () => boolean) => Promise<T>): Promise<T> {
        const activity = this.keysInFlight.get(memoryKey) ?? { operations: 0, finishedWrites: 0 };
        this.keysInFlight.set(memoryKey, activity);
        activity.operations += 1;
        const startedAt = activity.finishedWrites;
        try {
            return await operation(() => activity.finishedWrites !== startedAt);
        } finally {
            activity.operations -= 1;
            if (activity.operations === 0) this.keysInFlight.delete(memoryKey);
        }
    }

    /** A write of one key has finished, landed or failed: the table may hold it either way. */
    recordKeyWrite(memoryKey: string): void {
        const activity = this.keysInFlight.get(memoryKey);
        if (activity) activity.finishedWrites += 1;
        this.recentKeys.set(memoryKey, true, this.recentUntil());
    }

    /** A deletePartition has finished, landed or failed: a write of every key in the partition. */
    recordPartitionWrite(partition: string): void {
        const prefix = cacheMemoryKeyOf(partition, "");
        for (const [memoryKey, activity] of this.keysInFlight) {
            if (memoryKey.startsWith(prefix)) activity.finishedWrites += 1;
        }
        this.recentPartitions.set(partition, true, this.recentUntil());
    }

    /** Whether this instance wrote the entry a moment ago, recently enough that a replica may not have applied the write yet. */
    wroteRecently(address: LambderCacheAddress): boolean {
        return this.recentKeys.get(address.memoryKey) !== undefined || this.recentPartitions.get(address.partition) !== undefined;
    }

    private recentUntil(): number {
        return Math.floor(this.now() / 1000) + RECENT_WRITE_SECONDS;
    }
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
export class LambderDdbCache implements LambderCache {
    readonly tableName: string;
    readonly keyPrefix: string;
    readonly namespace: string;

    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    private readonly ready: () => Promise<LambderDynamoClientReady>;
    private readonly defaultTtlSeconds: number;
    private readonly chunkBytes: number;
    private readonly compression: LambderCompressionSettings | null;
    private readonly maxValueBytes: number;
    private readonly memory: LRUCache<string, MemoryEntry> | null;
    /** getOrSet's single-flight and fail-open, shared with LambderMemoryCache (see LambderCacheFiller). */
    private readonly filler: LambderCacheFiller;
    private readonly now: () => number;
    /** This instance's own writes, as its reads and its memory layer need to know them (see LocalWriteLedger). */
    private readonly localWrites: LocalWriteLedger;

    constructor(options: LambderDdbCacheOptions) {
        if (!options.tableName.trim()) throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "CACHE";
        this.namespace = options.namespace?.trim() || "default";
        if (Buffer.byteLength(this.namespace, "utf8") > 128) {
            throw new Error("namespace must be at most 128 UTF-8 bytes");
        }

        this.defaultTtlSeconds = assertPositiveInteger(
            options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS,
            "defaultTtlSeconds",
        );
        this.chunkBytes = assertPositiveInteger(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, "chunkBytes");
        if (this.chunkBytes > MAX_SAFE_CHUNK_BYTES) {
            throw new Error(`chunkBytes must not exceed ${MAX_SAFE_CHUNK_BYTES}`);
        }

        this.compression = resolveCompressionOption(options.compression, COMPRESSION_DEFAULTS);

        this.maxValueBytes = assertPositiveInteger(
            options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES,
            "maxValueBytes",
        );
        const memoryMaxBytes = options.memoryMaxBytes ?? DEFAULT_MEMORY_BYTES;
        this.memory = memoryMaxBytes === 0
            ? null
            : new LRUCache<string, MemoryEntry>({
                maxSize: assertPositiveInteger(memoryMaxBytes, "memoryMaxBytes"),
                // The key is a JS string, two bytes a character.
                sizeCalculation: (entry, key) => entry.stored.byteLength + key.length * 2 + MEMORY_ENTRY_OVERHEAD_BYTES,
            });
        this.now = options.now ?? (() => Date.now());
        this.localWrites = new LocalWriteLedger(this.now);
        this.ready = createDynamoClientLoader({ user: "LambderDdbCache", region: options.region, client: options.client });
        this.filler = new LambderCacheFiller(`DynamoDB cache failed open in ${this.namespace}`);
    }

    async get<T>(key: LambderCacheKey): Promise<T | undefined> {
        return await this.getByAddress<T>(normalizeCacheKey(key));
    }

    private async getByAddress<T>(address: LambderCacheAddress): Promise<T | undefined> {
        const cached = this.memory?.get(address.memoryKey);
        const nowSeconds = this.nowSeconds();
        if (cached && cached.expiresAt > nowSeconds) {
            try {
                return JSON.parse(await this.decode(cached.stored, cached.encoding, cached.uncompressedBytes)) as T;
            } catch {
                // Fall through to DynamoDB; the in-memory copy is disposable.
            }
        }
        if (cached) this.memory?.delete(address.memoryKey);

        return await this.localWrites.watch(address.memoryKey, async (overtaken) => {
            const pk = await this.partitionKey(address.partition);
            // A key this instance wrote a moment ago is read from the leader:
            // a replica may not have applied that write yet, and the memory
            // layer would keep what it had instead (see LocalWriteLedger).
            const consistent = this.localWrites.wroteRecently(address);
            const manifest = await this.readManifest(pk, address, consistent);
            if (!manifest || manifest.expiresAt <= nowSeconds) return undefined;
            try {
                return await this.readEntry<T>(pk, address, manifest, consistent, overtaken);
            } catch (error) {
                // Only an entry this read can prove wrong is dropped. Anything
                // else is the table answering badly and propagates, like the
                // manifest read's errors, for getOrSet's fail-open to handle as
                // the infrastructure failure it is.
                if (!isEntryFault(error)) throw error;
            }

            // One read is not proof yet: a replica can hold a manifest before
            // its chunks, and a newer write can replace the version and delete
            // its chunks while they are read. One consistent read of both
            // decides, and only what fails that is corrupt.
            const current = await this.readManifest(pk, address, true);
            if (!current || current.expiresAt <= this.nowSeconds()) return undefined;
            return await this.readLeaderEntry<T>(pk, address, current, overtaken);
        });
    }

    /**
     * The value a manifest the leader answered describes, its chunks read
     * consistently, or undefined when it fails that read: then it is corrupt,
     * and its manifest is dropped. `overtaken` comes from the read's watch
     * (see LocalWriteLedger).
     */
    private async readLeaderEntry<T>(pk: string, address: LambderCacheAddress, manifest: CacheManifest, overtaken: () => boolean): Promise<T | undefined> {
        try {
            return await this.readEntry<T>(pk, address, manifest, true, overtaken);
        } catch (error) {
            if (!isEntryFault(error)) throw error;
            await this.invalidateManifest(pk, address, manifest.version);
            console.warn(`Ignoring corrupt DynamoDB cache entry in ${this.namespace}`, error);
            return undefined;
        }
    }

    /**
     * The value a manifest describes, checked against it and kept in the
     * memory layer unless a write of the key finished while it was read
     * (`overtaken`, see LocalWriteLedger).
     */
    private async readEntry<T>(pk: string, address: LambderCacheAddress, manifest: CacheManifest, consistent: boolean, overtaken: () => boolean): Promise<T> {
        const stored = manifest.inlineData ?? await this.readChunks(pk, address, manifest, consistent);
        if (stored.length !== manifest.storedBytes) {
            throw new LambderCacheIntegrityError("stored byte length does not match manifest");
        }
        if (await sha256(stored) !== manifest.checksum) {
            throw new LambderCacheIntegrityError("stored checksum does not match manifest");
        }

        const json = await this.decode(stored, manifest.encoding, manifest.uncompressedBytes);
        const parsed = JSON.parse(json) as T;
        if (!overtaken()) {
            this.remember(address.memoryKey, stored, manifest.encoding, manifest.uncompressedBytes, manifest.expiresAt);
        }
        return parsed;
    }

    async has(key: LambderCacheKey): Promise<boolean> {
        const address = normalizeCacheKey(key);
        const cached = this.memory?.get(address.memoryKey);
        const nowSeconds = this.nowSeconds();
        if (cached?.expiresAt && cached.expiresAt > nowSeconds) return true;
        if (cached) this.memory?.delete(address.memoryKey);

        // From the leader for a key this instance wrote a moment ago, as getByAddress reads it.
        const manifest = await this.readManifest(await this.partitionKey(address.partition), address, this.localWrites.wroteRecently(address));
        return !!manifest && manifest.expiresAt > nowSeconds;
    }

    async set<T>(key: LambderCacheKey, value: T, options: LambderCacheSetOptions = {}): Promise<void> {
        const address = normalizeCacheKey(key);
        const ttlSeconds = resolveCacheTtlSeconds(options.ttlSeconds, this.defaultTtlSeconds);
        this.filler.supersedeFill(address.memoryKey);
        await this.setByAddress(address, value, ttlSeconds);
    }

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
    private async setByAddress<T>(address: LambderCacheAddress, value: T, ttlSeconds: number, leaseOwner?: string): Promise<T> {
        const { json, utf8 } = serializeCacheValue(value, this.maxValueBytes);
        const input = Buffer.from(utf8.buffer, utf8.byteOffset, utf8.byteLength);

        const brotli = this.compression && input.length >= this.compression.minBytes ? this.compression : null;
        const encoding: CacheEncoding = brotli ? "br" : "identity";
        const stored = brotli ? await compressText(input, "br", brotli.quality) : input;
        if (stored.length > this.maxValueBytes) {
            throw new Error(`Stored cache value exceeds maxValueBytes (${stored.length} > ${this.maxValueBytes})`);
        }

        const pk = await this.partitionKey(address.partition);
        const version = `${Date.now().toString(36)}-${await randomUUID()}`;
        const expiresAt = this.nowSeconds() + ttlSeconds;
        const chunks: Buffer[] = [];
        const inline = stored.length <= this.chunkBytes;
        if (!inline) {
            for (let offset = 0; offset < stored.length; offset += this.chunkBytes) {
                chunks.push(stored.subarray(offset, offset + this.chunkBytes));
            }
        }

        const writes: WriteRequest[] = chunks.map((chunk, index) => ({
            PutRequest: {
                Item: {
                    pk: { S: pk },
                    sk: { S: this.chunkSortKey(address, version, index) },
                    data: { B: chunk },
                    expiresAt: { N: String(expiresAt) },
                },
            },
        }));

        const publish = await this.localWrites.watch(address.memoryKey, async (overtaken) => {
            let kept = false;
            try {
                await this.batchWrite(writes);
                const { client, sdk } = await this.ready();
                let replaced: Record<string, AttributeValue> | undefined;
                let refused = false;
                try {
                    const response = await client.send(
                        new sdk.PutItemCommand({
                            TableName: this.tableName,
                            ReturnValues: "ALL_OLD",
                            Item: {
                                pk: { S: pk },
                                sk: { S: this.itemSortKey(address, META_SORT_KEY) },
                                version: { S: version },
                                chunkCount: { N: String(chunks.length) },
                                storedBytes: { N: String(stored.length) },
                                uncompressedBytes: { N: String(input.length) },
                                checksum: { S: await sha256(stored) },
                                encoding: { S: encoding },
                                createdAt: { N: String(this.nowSeconds()) },
                                expiresAt: { N: String(expiresAt) },
                                ...(inline ? { data: { B: stored } } : {}),
                            },
                            ...(leaseOwner === undefined ? {} : {
                                ConditionExpression: "#leaseOwner = :leaseOwner",
                                ExpressionAttributeNames: { "#leaseOwner": "leaseOwner" },
                                ExpressionAttributeValues: { ":leaseOwner": { S: leaseOwner } },
                                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                            }),
                        }),
                    );
                    replaced = response.Attributes;
                } catch (error) {
                    if (leaseOwner === undefined || !isConditionalCheckFailure(error)) throw error;
                    const current = (error as { Item?: Record<string, AttributeValue> }).Item;
                    // Refused over this very manifest when the SDK retried an
                    // attempt that had already landed: published, not refused.
                    refused = current?.version?.S !== version;
                    if (refused && current?.leaseOwner?.S !== undefined) {
                        console.warn(`LambderDdbCache: a fill in ${this.namespace} ran past its lease and another container took the lease over, so its value was not stored; give getOrSet a leaseSeconds longer than its loader takes.`);
                    }
                }
                // Kept only when no other write of this key finished while
                // this one was in flight (see LocalWriteLedger).
                if (!refused && !overtaken()) {
                    this.remember(address.memoryKey, stored, encoding, input.length, expiresAt);
                    kept = true;
                }
                return { refused, replaced };
            } finally {
                // Settled as it lands, whatever happened: its own value in
                // memory, or no copy of the key at all.
                if (!kept) this.memory?.delete(address.memoryKey);
                this.localWrites.recordKeyWrite(address.memoryKey);
            }
        });

        if (publish.refused) {
            await this.deleteChunks(pk, address, version, chunks.length, "a refused fill's");
        } else {
            await this.deleteReplacedChunks(pk, address, publish.replaced, version);
        }
        return JSON.parse(json) as T;
    }

    /**
     * The chunks of the version a manifest write just replaced, which nothing
     * reads any more and which would otherwise sit in the table until their
     * TTL: a large value refreshed hourly leaves a copy an hour. `ownVersion`
     * is the writer's own, which an SDK retry of a write that had already
     * landed reports as the replaced one.
     */
    private async deleteReplacedChunks(
        pk: string,
        address: LambderCacheAddress,
        previous: Record<string, AttributeValue> | undefined,
        ownVersion?: string,
    ): Promise<void> {
        const previousVersion = previous?.version?.S;
        const chunkCount = Number(previous?.chunkCount?.N);
        if (!previousVersion || previousVersion === ownVersion || !Number.isSafeInteger(chunkCount) || chunkCount <= 0) return;
        const count = Math.min(chunkCount, Math.ceil(this.maxValueBytes / this.chunkBytes));
        await this.deleteChunks(pk, address, previousVersion, count, "a replaced value's");
    }

    /**
     * One version's chunk items, deleted. The write they belonged to is
     * settled whether or not this succeeds, and the chunks carry their own
     * TTL, so a failure here is logged, not the caller's.
     */
    private async deleteChunks(pk: string, address: LambderCacheAddress, version: string, count: number, whose: string): Promise<void> {
        try {
            await this.batchWrite(Array.from({ length: count }, (_, index) => ({
                DeleteRequest: { Key: { pk: { S: pk }, sk: { S: this.chunkSortKey(address, version, index) } } },
            })));
        } catch (error) {
            console.warn(`Failed to delete ${whose} chunks from the DynamoDB cache in ${this.namespace}`, error);
        }
    }

    /**
     * Removes the entry's manifest item, whatever it holds (a value, or a
     * fill's lease, whose publish is then refused), and its chunks. True when
     * the manifest held a live value: a lease or an expired value the table's
     * TTL has not removed yet is no entry.
     */
    async delete(key: LambderCacheKey): Promise<boolean> {
        const address = normalizeCacheKey(key);
        this.filler.supersedeFill(address.memoryKey);
        this.memory?.delete(address.memoryKey);
        try {
            const pk = await this.partitionKey(address.partition);
            const { client, sdk } = await this.ready();
            // By its key, so the leader removes what it holds now: a value or
            // a lease another container wrote a moment ago, which a Query
            // could miss on a replica that has not seen it yet.
            const { Attributes: removed } = await client.send(
                new sdk.DeleteItemCommand({
                    TableName: this.tableName,
                    Key: { pk: { S: pk }, sk: { S: this.itemSortKey(address, META_SORT_KEY) } },
                    ReturnValues: "ALL_OLD",
                }),
            );
            // Then the chunks of any version (the value's, and any a failed
            // write left behind), read consistently for the same reason. The
            // prefix is this entry's own chunk items, so a plain key's delete
            // leaves the grouped entries sharing its partition alone.
            await this.deleteItems(await this.queryItems(pk, {
                prefix: this.itemSortKey(address, CHUNK_SORT_KEY_PREFIX),
                projection: "#pk, #sk",
                consistent: true,
            }));
            return holdsLiveValue(removed, this.nowSeconds());
        } finally {
            // Again once the items are gone: a read in flight meanwhile may
            // have kept what it found before they were (see LocalWriteLedger).
            this.memory?.delete(address.memoryKey);
            this.localWrites.recordKeyWrite(address.memoryKey);
        }
    }

    /**
     * Drop every entry stored under one `pk`, without knowing which sort keys
     * exist: the invalidation a group of related entries is worth grouping
     * for. Returns the number of live values removed. In-memory copies held
     * by OTHER Lambda containers still serve until their own TTL, as they do
     * after a single-entry delete.
     */
    async deletePartition(partition: string): Promise<number> {
        const normalized = normalizeCachePartition(partition);
        this.filler.supersedeFillsWithPrefix(cacheMemoryKeyOf(normalized, ""));
        this.forgetPartition(normalized);
        try {
            const pk = await this.partitionKey(normalized);
            // Read consistently: a replica may not have seen a value or a
            // fill's lease the table accepted a moment ago, and whatever this
            // misses outlives the call.
            const items = await this.queryItems(pk, {
                projection: "#pk, #sk, #version, #expiresAt",
                extraNames: { "#version": "version", "#expiresAt": "expiresAt" },
                consistent: true,
            });
            await this.deleteItems(items);
            const nowSeconds = this.nowSeconds();
            return items.filter((item) => this.isManifestSortKey(item.sk?.S) && holdsLiveValue(item, nowSeconds)).length;
        } finally {
            // Again once the items are gone, as in delete.
            this.forgetPartition(normalized);
            this.localWrites.recordPartitionWrite(normalized);
        }
    }

    /**
     * The live (unexpired) sort keys stored under one `pk`, in table order.
     * Plain-string entries have no sort key, so they never appear here.
     * The partition (or prefix range) is read whatever the limit, and reading
     * a partition whose values are chunked also reads those chunk items, so
     * grouping very large values makes listing more expensive.
     */
    async listSortKeys(partition: string, options: LambderCacheListOptions = {}): Promise<string[]> {
        const pk = await this.partitionKey(normalizeCachePartition(partition));
        const prefix = `${SORT_KEY_MARKER}${encodeCacheSortKey(options.prefix ?? "")}`;
        const limit = options.limit === undefined ? undefined : assertPositiveInteger(options.limit, "limit");
        const nowSeconds = this.nowSeconds();

        const items = await this.queryItems(pk, {
            prefix,
            projection: "#sk, #expiresAt, #version",
            extraNames: { "#expiresAt": "expiresAt", "#version": "version" },
        });
        const sortKeys: string[] = [];
        for (const item of items) {
            const sk = item.sk?.S;
            if (!sk || !this.isManifestSortKey(sk)) continue;
            // A manifest item holding only a fill's lease, or an expired value, has nothing to list.
            if (!holdsLiveValue(item, nowSeconds)) continue;
            sortKeys.push(decodeCacheSortKey(sk.slice(SORT_KEY_MARKER.length, -(META_SORT_KEY.length + 1))));
            if (limit !== undefined && sortKeys.length >= limit) break;
        }
        return sortKeys;
    }

    async getOrSet<T>(
        key: LambderCacheKey,
        loader: () => Promise<T>,
        options: LambderDdbCacheGetOrSetOptions = {},
    ): Promise<T> {
        const address = normalizeCacheKey(key);
        const settings = resolveGetOrSetOptions(options, this.defaultTtlSeconds);
        // Cache infrastructure is best-effort here: a read, lease or write
        // failure returns the loader's value (see LambderCacheFiller).
        return this.filler.getOrSet(address.memoryKey, loader, async (load) => {
            const existing = await this.getByAddress<T>(address);
            if (existing !== undefined) return existing;
            return await this.fill(address, load, settings);
        });
    }

    /** The fill once a read found nothing: one container loads under the lease while the others wait for its value. */
    private async fill<T>(
        address: LambderCacheAddress,
        load: LambderCacheLoad<T>,
        { ttlSeconds, leaseSeconds, waitForFillMs }: LambderCacheFillSettings,
    ): Promise<T> {
        const pk = await this.partitionKey(address.partition);
        const owner = await randomUUID();

        // The load under the lease just taken, published only while the lease
        // is still this fill's (see setByAddress). A publish that answered,
        // landed or refused, leaves no lease of this fill's on the item; any
        // other end (the loader threw or answered undefined, a write
        // superseded the fill, the publish failed) releases it.
        const fillUnderLease = async (): Promise<T> => {
            let published = false;
            try {
                return await load(async (value) => {
                    const stored = await this.setByAddress(address, value, ttlSeconds, owner);
                    published = true;
                    return stored;
                });
            } finally {
                if (!published) await this.releaseLease(pk, address, owner);
            }
        };

        const deadline = Date.now() + waitForFillMs;
        let delay = 50;
        for (;;) {
            const attempt = await this.takeLease(pk, address, owner, leaseSeconds);
            if (attempt === "taken") return await fillUnderLease();
            if (attempt !== "held") {
                // Refused over a live value: the read that found the entry
                // missing reached a replica that had not seen it yet. The
                // refusal carries the manifest as the leader holds it, so it
                // serves the value, its chunks read consistently when it has
                // any, rather than waiting out the lag.
                const value = await this.localWrites.watch(
                    address.memoryKey,
                    (overtaken) => this.readLeaderEntry<T>(pk, address, attempt.filled, overtaken),
                );
                if (value !== undefined) return value;
            }
            if (Date.now() >= deadline) break;
            await sleep(delay + Math.floor(Math.random() * 25));
            const value = await this.getByAddress<T>(address);
            if (value !== undefined) return value;
            delay = Math.min(delay * 2, 500);
        }

        throw new Error(`Timed out waiting for DynamoDB cache fill in ${this.namespace}`);
    }

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
    private async takeLease(
        pk: string,
        address: LambderCacheAddress,
        owner: string,
        leaseSeconds: number,
        unreadableVersion?: string,
    ): Promise<LeaseAttempt> {
        const now = this.nowSeconds();
        let current: Record<string, AttributeValue> | undefined;
        try {
            const { client, sdk } = await this.ready();
            const response = await client.send(
                new sdk.PutItemCommand({
                    TableName: this.tableName,
                    Item: {
                        pk: { S: pk },
                        sk: { S: this.itemSortKey(address, META_SORT_KEY) },
                        leaseOwner: { S: owner },
                        // The first second the lease no longer holds, as a
                        // value's expiresAt is the first second it no longer
                        // reads. Counted from the whole second the lease was
                        // taken in, so one taken late in a second still lasts
                        // its full length.
                        expiresAt: { N: String(now + leaseSeconds + 1) },
                    },
                    ...(unreadableVersion === undefined ? {
                        // An item without expiresAt is none a cache wrote; a
                        // comparison with a missing attribute is false, so it
                        // is allowed by name rather than refused for ever.
                        ConditionExpression: "attribute_not_exists(#expiresAt) OR #expiresAt <= :now",
                        ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
                        ExpressionAttributeValues: { ":now": { N: String(now) } },
                    } : {
                        ConditionExpression: "attribute_not_exists(#leaseOwner) AND #version = :version",
                        ExpressionAttributeNames: { "#leaseOwner": "leaseOwner", "#version": "version" },
                        ExpressionAttributeValues: { ":version": { S: unreadableVersion } },
                    }),
                    ReturnValues: "ALL_OLD",
                    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
                }),
            );
            await this.deleteReplacedChunks(pk, address, response.Attributes);
            return "taken";
        } catch (error) {
            if (!isConditionalCheckFailure(error)) throw error;
            current = (error as { Item?: Record<string, AttributeValue> }).Item;
        }

        const holder = current?.leaseOwner?.S;
        // Refused over this very lease when the SDK retried an attempt that
        // had already landed: taken, not refused.
        if (holder === owner) return "taken";
        if (!current || holder !== undefined) return "held";
        const manifest = this.parseManifest(current);
        if (manifest && manifest.expiresAt > now) return { filled: manifest };
        const version = current.version?.S;
        if (unreadableVersion !== undefined || version === undefined) return "held";
        return await this.takeLease(pk, address, owner, leaseSeconds, version);
    }

    /** Clears this fill's lease off the manifest item, conditional on it still being this fill's, so it never touches what replaced it. */
    private async releaseLease(pk: string, address: LambderCacheAddress, owner: string): Promise<void> {
        try {
            const { client, sdk } = await this.ready();
            await client.send(
                new sdk.DeleteItemCommand({
                    TableName: this.tableName,
                    Key: { pk: { S: pk }, sk: { S: this.itemSortKey(address, META_SORT_KEY) } },
                    ConditionExpression: "#leaseOwner = :owner",
                    ExpressionAttributeNames: { "#leaseOwner": "leaseOwner" },
                    ExpressionAttributeValues: { ":owner": { S: owner } },
                }),
            );
        } catch (error) {
            if (!isConditionalCheckFailure(error)) {
                console.warn(`Failed to release DynamoDB cache lease in ${this.namespace}`, error);
            }
        }
    }

    private async readManifest(pk: string, address: LambderCacheAddress, consistent: boolean): Promise<CacheManifest | undefined> {
        const { client, sdk } = await this.ready();
        const response = await client.send(
            new sdk.GetItemCommand({
                TableName: this.tableName,
                Key: { pk: { S: pk }, sk: { S: this.itemSortKey(address, META_SORT_KEY) } },
                ConsistentRead: consistent,
            }),
        );
        return response.Item ? this.parseManifest(response.Item) : undefined;
    }

    /**
     * The value a manifest item describes, or undefined when it describes
     * none this instance can read: a fill's lease with no value under it
     * yet, or a manifest that does not add up. Expiry is the caller's check.
     */
    private parseManifest(item: Record<string, AttributeValue>): CacheManifest | undefined {
        const version = item.version?.S;
        const encoding = item.encoding?.S;
        const chunkCount = Number(item.chunkCount?.N);
        const storedBytes = Number(item.storedBytes?.N);
        const uncompressedBytes = Number(item.uncompressedBytes?.N);
        const expiresAt = Number(item.expiresAt?.N);
        const checksum = item.checksum?.S;
        const inlineData = item.data?.B == null ? undefined : Buffer.from(item.data.B);
        const validInline =
            inlineData !== undefined &&
            chunkCount === 0 &&
            inlineData.length === storedBytes &&
            storedBytes <= this.chunkBytes;
        const validChunks =
            inlineData === undefined &&
            chunkCount > 0 &&
            chunkCount === Math.ceil(storedBytes / this.chunkBytes);
        if (
            !version ||
            (encoding !== "br" && encoding !== "identity") ||
            !checksum ||
            !Number.isSafeInteger(chunkCount) ||
            chunkCount < 0 ||
            !Number.isSafeInteger(storedBytes) ||
            storedBytes < 0 ||
            storedBytes > this.maxValueBytes ||
            !Number.isSafeInteger(uncompressedBytes) ||
            uncompressedBytes < 0 ||
            uncompressedBytes > this.maxValueBytes ||
            (encoding === "identity" && storedBytes !== uncompressedBytes) ||
            !Number.isSafeInteger(expiresAt) ||
            (!validInline && !validChunks)
        ) {
            return undefined;
        }
        return {
            version,
            encoding,
            chunkCount,
            storedBytes,
            uncompressedBytes,
            checksum,
            expiresAt,
            inlineData,
        };
    }

    private async readChunks(pk: string, address: LambderCacheAddress, manifest: CacheManifest, consistent: boolean): Promise<Buffer> {
        const prefix = this.itemSortKey(address, `${CHUNK_SORT_KEY_PREFIX}${manifest.version}#`);
        const items = await this.queryItems(pk, {
            prefix,
            projection: "#sk, #data",
            extraNames: { "#data": "data" },
            consistent,
        });
        const chunks = items
            .filter((item) => item.sk?.S && item.data?.B)
            .map((item) => ({ sk: item.sk!.S!, data: Buffer.from(item.data!.B!) }));

        chunks.sort((left, right) => left.sk.localeCompare(right.sk));
        if (chunks.length !== manifest.chunkCount) {
            throw new LambderCacheIntegrityError(`DynamoDB cache entry is missing chunks (${chunks.length}/${manifest.chunkCount})`);
        }
        for (let index = 0; index < chunks.length; index += 1) {
            if (chunks[index]?.sk !== this.chunkSortKey(address, manifest.version, index)) {
                throw new LambderCacheIntegrityError(`DynamoDB cache entry has an invalid chunk index at ${index}`);
            }
        }
        return Buffer.concat(chunks.map((chunk) => chunk.data), manifest.storedBytes);
    }

    /** Every item matching a partition (optionally a sort-key prefix), following pagination. */
    private async queryItems(
        pk: string,
        options: { prefix?: string | null, projection: string, extraNames?: Record<string, string>, consistent?: boolean },
    ): Promise<Array<Record<string, AttributeValue>>> {
        const items: Array<Record<string, AttributeValue>> = [];
        let cursor: Record<string, AttributeValue> | undefined;
        do {
            const { client, sdk } = await this.ready();
            const response = await client.send(
                new sdk.QueryCommand({
                    TableName: this.tableName,
                    KeyConditionExpression: options.prefix
                        ? "#pk = :pk AND begins_with(#sk, :prefix)"
                        : "#pk = :pk",
                    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", ...options.extraNames },
                    ExpressionAttributeValues: {
                        ":pk": { S: pk },
                        ...(options.prefix ? { ":prefix": { S: options.prefix } } : {}),
                    },
                    ProjectionExpression: options.projection,
                    ExclusiveStartKey: cursor,
                    ConsistentRead: options.consistent ?? false,
                }),
            );
            items.push(...(response.Items ?? []));
            cursor = response.LastEvaluatedKey;
        } while (cursor);
        return items;
    }

    private async deleteItems(items: Array<Record<string, AttributeValue>>): Promise<void> {
        const keys = items.flatMap((item) => item.pk && item.sk ? [{ pk: item.pk, sk: item.sk }] : []);
        await this.batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
    }

    private async invalidateManifest(pk: string, address: LambderCacheAddress, version: string): Promise<void> {
        try {
            const { client, sdk } = await this.ready();
            await client.send(
                new sdk.DeleteItemCommand({
                    TableName: this.tableName,
                    Key: { pk: { S: pk }, sk: { S: this.itemSortKey(address, META_SORT_KEY) } },
                    ConditionExpression: "#version = :version",
                    ExpressionAttributeNames: { "#version": "version" },
                    ExpressionAttributeValues: { ":version": { S: version } },
                }),
            );
        } catch (error) {
            if (!isConditionalCheckFailure(error)) {
                console.warn(`Failed to invalidate corrupt DynamoDB cache manifest in ${this.namespace}`, error);
            }
        }
    }

    private async batchWrite(requests: WriteRequest[]): Promise<void> {
        for (let offset = 0; offset < requests.length; offset += BATCH_WRITE_LIMIT) {
            let pending = requests.slice(offset, offset + BATCH_WRITE_LIMIT);
            for (let attempt = 0; pending.length > 0; attempt += 1) {
                if (attempt >= MAX_BATCH_RETRIES) {
                    throw new Error(`DynamoDB cache batch write remained throttled after ${MAX_BATCH_RETRIES} attempts`);
                }
                const { client, sdk } = await this.ready();
                const response = await client.send(
                    new sdk.BatchWriteItemCommand({ RequestItems: { [this.tableName]: pending } }),
                );
                pending = response.UnprocessedItems?.[this.tableName] ?? [];
                if (pending.length > 0) {
                    const backoff = Math.min(25 * 2 ** attempt, 1_000) + Math.floor(Math.random() * 50);
                    await sleep(backoff);
                }
            }
        }
    }

    /** The JSON text of a stored payload. */
    private async decode(stored: Buffer, encoding: CacheEncoding, uncompressedBytes: number): Promise<string> {
        return encoding === "br" ? await restoreText(stored, "br", { declaredBytes: uncompressedBytes }) : stored.toString("utf8");
    }

    private remember(
        key: string,
        stored: Buffer,
        encoding: CacheEncoding,
        uncompressedBytes: number,
        expiresAt: number,
    ): void {
        if (!this.memory) return;
        const ttl = expiresAt * 1000 - this.now();
        if (ttl <= 0) return;
        // Kept for as long as the entry lives, and counted by its length, so
        // it must own exactly those bytes. A small Buffer is often a view onto
        // something larger (a slice of zlib's 16 KB output chunk, a copy in
        // Node's shared 8 KB pool), and kept as it is it would pin all of it.
        let owned = stored;
        if (stored.byteLength !== stored.buffer.byteLength) {
            owned = Buffer.allocUnsafeSlow(stored.byteLength);
            stored.copy(owned);
        }
        this.memory.set(key, { stored: owned, encoding, uncompressedBytes, expiresAt }, { ttl });
    }

    private async partitionKey(key: string): Promise<string> {
        return `${this.keyPrefix}#${this.namespace}#${await sha256(key)}`;
    }

    /**
     * One of an entry's item keys. A plain-string entry uses the bare
     * suffix; a grouped one nests under its escaped sort key, whose trailing
     * `#` is an unambiguous boundary because an escaped sort key never
     * contains a bare `#`.
     */
    private itemSortKey(address: LambderCacheAddress, suffix: string): string {
        return address.sortKey === null ? suffix : `${SORT_KEY_MARKER}${encodeCacheSortKey(address.sortKey)}#${suffix}`;
    }

    private isManifestSortKey(sk: string | undefined): boolean {
        return sk === META_SORT_KEY || (!!sk && sk.startsWith(SORT_KEY_MARKER) && sk.endsWith(`#${META_SORT_KEY}`));
    }

    private chunkSortKey(address: LambderCacheAddress, version: string, index: number): string {
        return this.itemSortKey(address, `${CHUNK_SORT_KEY_PREFIX}${version}#${String(index).padStart(6, "0")}`);
    }

    /** Drop every in-memory copy belonging to one partition. */
    private forgetPartition(partition: string): void {
        if (!this.memory) return;
        const prefix = cacheMemoryKeyOf(partition, "");
        for (const key of [...this.memory.keys()]) {
            if (key.startsWith(prefix)) this.memory.delete(key);
        }
    }

    private nowSeconds(): number {
        return Math.floor(this.now() / 1000);
    }

}

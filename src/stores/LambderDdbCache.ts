import {
    BatchWriteItemCommand,
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    type AttributeValue,
    type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import { getCrypto } from "../shared/node-polyfills.js";
import { compressText, restoreBoundedText } from "../shared/LambderCompressionCodec.js";
import {
    resolveCompressionOption,
    type LambderCompressionOption, type LambderCompressionSettings,
} from "../shared/LambderCompressionOption.js";
import { LRUCache } from "lru-cache";

const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_CHUNK_BYTES = 350 * 1024;
const MAX_SAFE_CHUNK_BYTES = 380 * 1024;
const DEFAULT_MAX_VALUE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MEMORY_BYTES = 16 * 1024 * 1024;
const META_SORT_KEY = "meta";
const LOCK_SORT_KEY = "lock";
const CHUNK_SORT_KEY_PREFIX = "chunk#";
/** Item-key prefix that separates entries addressed with a sort key from plain-key entries sharing the partition. */
const SORT_KEY_MARKER = "sk#";
/** Budget for one encoded sort key, leaving room for the marker and the longest item suffix inside DynamoDB's 1024-byte range key limit. */
const MAX_SORT_KEY_BYTES = 900;
const BATCH_WRITE_LIMIT = 25;
const MAX_BATCH_RETRIES = 8;
/** Every value compressed by default; see the `compression` option. */
const COMPRESSION_DEFAULTS: LambderCompressionSettings = { minBytes: 0, quality: 5 };

/** How a value's bytes are stored: Brotli, or the UTF-8 JSON itself. */
type CacheEncoding = "br" | "identity";

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
export type LambderCacheKey = string | { pk: string, sk: string };

/** One entry's address, normalized: `sortKey` is null for a plain string key. */
interface CacheAddress {
    partition: string;
    sortKey: string | null;
    /** Unambiguous key for the in-memory layer and the in-flight map. */
    memoryKey: string;
}

/**
 * `#` separates the store's own item-key segments, so a caller's `#` is
 * escaped rather than refused: `~` becomes `~0` and `#` becomes `~1`. An
 * encoded sort key therefore never contains a bare `#`, which keeps
 * `<encoded>#` an unambiguous boundary for prefix queries. Escaping is
 * per-character, so a prefix of the raw key stays a prefix of the encoded
 * one; only the sort ORDER of keys that contain `#` or `~` shifts, since
 * both encode into the `~` range.
 */
const encodeSortKey = (value: string): string => value.replace(/~/g, "~0").replace(/#/g, "~1");
const decodeSortKey = (value: string): string => value.replace(/~([01])/g, (_match, code) => code === "0" ? "~" : "#");

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

// Node builtins are loaded lazily through node-polyfills so this module can
// sit in a frontend bundle's import graph (via the package root) without
// breaking; using the cache at runtime still requires Node. Brotli helpers
// are shared with LambderDdbIdempotency and LambderSessionManager via
// ../shared/LambderCompressionCodec.js.
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

const positiveInteger = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
};

const sleep = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

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
export class LambderDdbCache {
    readonly tableName: string;
    readonly keyPrefix: string;
    readonly namespace: string;

    private readonly client: DynamoDBClient;
    private readonly defaultTtlSeconds: number;
    private readonly chunkBytes: number;
    private readonly compression: LambderCompressionSettings | null;
    private readonly maxValueBytes: number;
    private readonly memory: LRUCache<string, MemoryEntry> | null;
    private readonly inFlight = new Map<string, Promise<unknown>>();

    constructor(options: LambderDdbCacheOptions) {
        if (!options.tableName.trim()) throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "CACHE";
        this.namespace = options.namespace?.trim() || "default";
        if (Buffer.byteLength(this.namespace, "utf8") > 128) {
            throw new Error("namespace must be at most 128 UTF-8 bytes");
        }

        this.defaultTtlSeconds = positiveInteger(
            options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS,
            "defaultTtlSeconds",
        );
        this.chunkBytes = positiveInteger(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, "chunkBytes");
        if (this.chunkBytes > MAX_SAFE_CHUNK_BYTES) {
            throw new Error(`chunkBytes must not exceed ${MAX_SAFE_CHUNK_BYTES}`);
        }

        this.compression = resolveCompressionOption(options.compression, COMPRESSION_DEFAULTS);

        this.maxValueBytes = positiveInteger(
            options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES,
            "maxValueBytes",
        );
        const memoryMaxBytes = options.memoryMaxBytes ?? DEFAULT_MEMORY_BYTES;
        this.memory = memoryMaxBytes === 0
            ? null
            : new LRUCache<string, MemoryEntry>({
                maxSize: positiveInteger(memoryMaxBytes, "memoryMaxBytes"),
                sizeCalculation: (entry) => entry.stored.length,
            });
        this.client = options.client ?? new DynamoDBClient({ region: options.region ?? "us-east-1" });
    }

    async get<T>(key: LambderCacheKey): Promise<T | undefined> {
        return await this.getByAddress<T>(this.normalizeKey(key));
    }

    private async getByAddress<T>(address: CacheAddress): Promise<T | undefined> {
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

        const pk = await this.partitionKey(address.partition);
        const manifest = await this.readManifest(pk, address);
        if (!manifest || manifest.expiresAt <= nowSeconds) return undefined;

        try {
            const stored = manifest.inlineData ?? await this.readChunks(pk, address, manifest);
            if (stored.length !== manifest.storedBytes) {
                throw new Error("stored byte length does not match manifest");
            }
            if (await sha256(stored) !== manifest.checksum) {
                throw new Error("stored checksum does not match manifest");
            }

            const json = await this.decode(stored, manifest.encoding, manifest.uncompressedBytes);
            const parsed = JSON.parse(json) as T;
            this.remember(address.memoryKey, stored, manifest.encoding, manifest.uncompressedBytes, manifest.expiresAt);
            return parsed;
        } catch (error) {
            await this.invalidateManifest(pk, address, manifest.version);
            console.warn(`Ignoring corrupt DynamoDB cache entry in ${this.namespace}`, error);
            return undefined;
        }
    }

    async has(key: LambderCacheKey): Promise<boolean> {
        const address = this.normalizeKey(key);
        const cached = this.memory?.get(address.memoryKey);
        const nowSeconds = this.nowSeconds();
        if (cached?.expiresAt && cached.expiresAt > nowSeconds) return true;
        if (cached) this.memory?.delete(address.memoryKey);

        const manifest = await this.readManifest(await this.partitionKey(address.partition), address);
        return !!manifest && manifest.expiresAt > nowSeconds;
    }

    async set<T>(key: LambderCacheKey, value: T, options: LambderDdbCacheSetOptions = {}): Promise<void> {
        return await this.setByAddress(this.normalizeKey(key), value, options);
    }

    private async setByAddress<T>(address: CacheAddress, value: T, options: LambderDdbCacheSetOptions): Promise<void> {
        const ttlSeconds = positiveInteger(options.ttlSeconds ?? this.defaultTtlSeconds, "ttlSeconds");
        const json = JSON.stringify(value);
        if (json === undefined) throw new Error("Cache value must be JSON-serializable");

        const input = Buffer.from(json, "utf8");
        if (input.length > this.maxValueBytes) {
            throw new Error(`Cache value exceeds maxValueBytes (${input.length} > ${this.maxValueBytes})`);
        }

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
        await this.batchWrite(writes);

        await this.client.send(
            new PutItemCommand({
                TableName: this.tableName,
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
            }),
        );
        this.remember(address.memoryKey, stored, encoding, input.length, expiresAt);
    }

    async delete(key: LambderCacheKey): Promise<boolean> {
        const address = this.normalizeKey(key);
        const pk = await this.partitionKey(address.partition);
        this.memory?.delete(address.memoryKey);

        // A grouped entry owns one contiguous item range; a plain-string one
        // owns the bare item keys, so it must leave any grouped entries
        // sharing its partition alone.
        const prefix = this.entryItemPrefix(address);
        const items = await this.queryItems(pk, { prefix, projection: "#pk, #sk" });
        const owned = prefix ? items : items.filter((item) => !item.sk?.S?.startsWith(SORT_KEY_MARKER));

        await this.deleteItems(owned);
        return owned.length > 0;
    }

    /**
     * Drop every entry stored under one `pk`, without knowing which sort keys
     * exist: the invalidation a group of related entries is worth grouping
     * for. Returns the number of entries removed. In-memory copies held by
     * OTHER Lambda containers still serve until their own TTL, as they do
     * after a single-entry delete.
     */
    async deletePartition(partition: string): Promise<number> {
        const normalized = this.normalizePartition(partition);
        const pk = await this.partitionKey(normalized);
        this.forgetPartition(normalized);

        const items = await this.queryItems(pk, { projection: "#pk, #sk" });
        await this.deleteItems(items);
        return items.filter((item) => this.isManifestSortKey(item.sk?.S)).length;
    }

    /**
     * The live (unexpired) sort keys stored under one `pk`, in table order.
     * Plain-string entries have no sort key, so they never appear here.
     * Reading a partition whose values are chunked also reads those chunk
     * items, so grouping very large values makes listing more expensive.
     */
    async listSortKeys(partition: string, options: LambderDdbCacheListOptions = {}): Promise<string[]> {
        const pk = await this.partitionKey(this.normalizePartition(partition));
        const prefix = `${SORT_KEY_MARKER}${encodeSortKey(options.prefix ?? "")}`;
        const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, "limit");
        const nowSeconds = this.nowSeconds();

        const items = await this.queryItems(pk, { prefix, projection: "#sk, #expiresAt", extraNames: { "#expiresAt": "expiresAt" } });
        const sortKeys: string[] = [];
        for (const item of items) {
            const sk = item.sk?.S;
            if (!sk || !this.isManifestSortKey(sk)) continue;
            if (Number(item.expiresAt?.N) <= nowSeconds) continue;
            sortKeys.push(decodeSortKey(sk.slice(SORT_KEY_MARKER.length, -(META_SORT_KEY.length + 1))));
            if (limit !== undefined && sortKeys.length >= limit) break;
        }
        return sortKeys;
    }

    async getOrSet<T>(
        key: LambderCacheKey,
        factory: () => Promise<T>,
        options: LambderDdbCacheGetOrSetOptions = {},
    ): Promise<T> {
        const address = this.normalizeKey(key);
        const current = this.inFlight.get(address.memoryKey) as Promise<T> | undefined;
        if (current) return current;

        const fill = this.getOrSetFailOpen(address, factory, options).finally(() => {
            this.inFlight.delete(address.memoryKey);
        });
        this.inFlight.set(address.memoryKey, fill);
        return fill;
    }

    /**
     * Cache infrastructure is best-effort for getOrSet: read, lease, or write
     * failures return the loader value. Loader failures still propagate and the
     * loader is never repeated after it has completed successfully.
     */
    private async getOrSetFailOpen<T>(
        address: CacheAddress,
        factory: () => Promise<T>,
        options: LambderDdbCacheGetOrSetOptions,
    ): Promise<T> {
        let factoryStarted = false;
        let factoryCompleted = false;
        let factoryValue: T | undefined;
        const trackedFactory = async (): Promise<T> => {
            factoryStarted = true;
            factoryValue = await factory();
            factoryCompleted = true;
            return factoryValue;
        };

        try {
            const existing = await this.getByAddress<T>(address);
            if (existing !== undefined) return existing;
            return await this.fill(address, trackedFactory, options);
        } catch (error) {
            if (factoryStarted && !factoryCompleted) throw error;
            console.error(`DynamoDB cache failed open in ${this.namespace} for ${address.memoryKey}`, error);
            if (factoryCompleted) return factoryValue as T;
            return trackedFactory();
        }
    }

    private async fill<T>(
        address: CacheAddress,
        factory: () => Promise<T>,
        options: LambderDdbCacheGetOrSetOptions,
    ): Promise<T> {
        const leaseSeconds = positiveInteger(options.leaseSeconds ?? 15, "leaseSeconds");
        const waitForFillMs = positiveInteger(options.waitForFillMs ?? 5_000, "waitForFillMs");
        const pk = await this.partitionKey(address.partition);
        const owner = await randomUUID();

        if (await this.acquireLease(pk, address, owner, leaseSeconds)) {
            try {
                const value = await factory();
                await this.setByAddress(address, value, { ttlSeconds: options.ttlSeconds });
                return value;
            } finally {
                await this.releaseLease(pk, address, owner);
            }
        }

        const deadline = Date.now() + waitForFillMs;
        let delay = 50;
        while (Date.now() < deadline) {
            await sleep(delay + Math.floor(Math.random() * 25));
            const value = await this.getByAddress<T>(address);
            if (value !== undefined) return value;
            if (await this.acquireLease(pk, address, owner, leaseSeconds)) {
                try {
                    const loaded = await factory();
                    await this.setByAddress(address, loaded, { ttlSeconds: options.ttlSeconds });
                    return loaded;
                } finally {
                    await this.releaseLease(pk, address, owner);
                }
            }
            delay = Math.min(delay * 2, 500);
        }

        throw new Error(`Timed out waiting for DynamoDB cache fill in ${this.namespace}`);
    }

    private async acquireLease(pk: string, address: CacheAddress, owner: string, leaseSeconds: number): Promise<boolean> {
        const now = this.nowSeconds();
        try {
            await this.client.send(
                new PutItemCommand({
                    TableName: this.tableName,
                    Item: {
                        pk: { S: pk },
                        sk: { S: this.itemSortKey(address, LOCK_SORT_KEY) },
                        owner: { S: owner },
                        expiresAt: { N: String(now + leaseSeconds) },
                    },
                    ConditionExpression: "attribute_not_exists(#pk) OR #expiresAt < :now",
                    ExpressionAttributeNames: { "#pk": "pk", "#expiresAt": "expiresAt" },
                    ExpressionAttributeValues: { ":now": { N: String(now) } },
                }),
            );
            return true;
        } catch (error) {
            if (this.isConditionalFailure(error)) return false;
            throw error;
        }
    }

    private async releaseLease(pk: string, address: CacheAddress, owner: string): Promise<void> {
        try {
            await this.client.send(
                new DeleteItemCommand({
                    TableName: this.tableName,
                    Key: { pk: { S: pk }, sk: { S: this.itemSortKey(address, LOCK_SORT_KEY) } },
                    ConditionExpression: "#owner = :owner",
                    ExpressionAttributeNames: { "#owner": "owner" },
                    ExpressionAttributeValues: { ":owner": { S: owner } },
                }),
            );
        } catch (error) {
            if (!this.isConditionalFailure(error)) {
                console.warn(`Failed to release DynamoDB cache lease in ${this.namespace}`, error);
            }
        }
    }

    private async readManifest(pk: string, address: CacheAddress): Promise<CacheManifest | undefined> {
        const response = await this.client.send(
            new GetItemCommand({
                TableName: this.tableName,
                Key: { pk: { S: pk }, sk: { S: this.itemSortKey(address, META_SORT_KEY) } },
                ConsistentRead: false,
            }),
        );
        const item = response.Item;
        if (!item) return undefined;

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

    private async readChunks(pk: string, address: CacheAddress, manifest: CacheManifest): Promise<Buffer> {
        const prefix = this.itemSortKey(address, `${CHUNK_SORT_KEY_PREFIX}${manifest.version}#`);
        const items = await this.queryItems(pk, {
            prefix,
            projection: "#sk, #data",
            extraNames: { "#data": "data" },
        });
        const chunks = items
            .filter((item) => item.sk?.S && item.data?.B)
            .map((item) => ({ sk: item.sk!.S!, data: Buffer.from(item.data!.B!) }));

        chunks.sort((left, right) => left.sk.localeCompare(right.sk));
        if (chunks.length !== manifest.chunkCount) {
            throw new Error(`DynamoDB cache entry is missing chunks (${chunks.length}/${manifest.chunkCount})`);
        }
        for (let index = 0; index < chunks.length; index += 1) {
            if (chunks[index]?.sk !== this.chunkSortKey(address, manifest.version, index)) {
                throw new Error(`DynamoDB cache entry has an invalid chunk index at ${index}`);
            }
        }
        return Buffer.concat(chunks.map((chunk) => chunk.data), manifest.storedBytes);
    }

    /** Every item matching a partition (optionally a sort-key prefix), following pagination. */
    private async queryItems(
        pk: string,
        options: { prefix?: string | null, projection: string, extraNames?: Record<string, string> },
    ): Promise<Array<Record<string, AttributeValue>>> {
        const items: Array<Record<string, AttributeValue>> = [];
        let cursor: Record<string, AttributeValue> | undefined;
        do {
            const response = await this.client.send(
                new QueryCommand({
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
                    ConsistentRead: false,
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

    private async invalidateManifest(pk: string, address: CacheAddress, version: string): Promise<void> {
        try {
            await this.client.send(
                new DeleteItemCommand({
                    TableName: this.tableName,
                    Key: { pk: { S: pk }, sk: { S: this.itemSortKey(address, META_SORT_KEY) } },
                    ConditionExpression: "#version = :version",
                    ExpressionAttributeNames: { "#version": "version" },
                    ExpressionAttributeValues: { ":version": { S: version } },
                }),
            );
        } catch (error) {
            if (!this.isConditionalFailure(error)) {
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
                const response = await this.client.send(
                    new BatchWriteItemCommand({ RequestItems: { [this.tableName]: pending } }),
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
        return encoding === "br" ? await restoreBoundedText(stored, uncompressedBytes, "br") : stored.toString("utf8");
    }

    private remember(
        key: string,
        stored: Buffer,
        encoding: CacheEncoding,
        uncompressedBytes: number,
        expiresAt: number,
    ): void {
        if (!this.memory) return;
        const ttl = expiresAt * 1000 - Date.now();
        if (ttl <= 0) return;
        this.memory.set(key, { stored, encoding, uncompressedBytes, expiresAt }, { ttl });
    }

    private normalizeKey(key: LambderCacheKey): CacheAddress {
        if (typeof key === "string") {
            const partition = this.normalizePartition(key);
            return { partition, sortKey: null, memoryKey: this.memoryKeyOf(partition, null) };
        }
        if (!key || typeof key !== "object") throw new Error("Cache key is required");

        const partition = this.normalizePartition(key.pk);
        const sortKey = key.sk;
        if (typeof sortKey !== "string" || !sortKey.trim()) throw new Error("Cache sort key is required");
        const encodedBytes = Buffer.byteLength(encodeSortKey(sortKey), "utf8");
        if (encodedBytes > MAX_SORT_KEY_BYTES) {
            throw new Error(`Cache sort key must be at most ${MAX_SORT_KEY_BYTES} UTF-8 bytes once escaped (${encodedBytes})`);
        }
        return { partition, sortKey, memoryKey: this.memoryKeyOf(partition, sortKey) };
    }

    private normalizePartition(key: string): string {
        if (typeof key !== "string" || !key.trim()) throw new Error("Cache key is required");
        if (Buffer.byteLength(key, "utf8") > 8 * 1024) {
            throw new Error("Cache key must be at most 8192 UTF-8 bytes");
        }
        return key;
    }

    /** Length-prefixed so a partition ending in the separator cannot collide with a sort key. */
    private memoryKeyOf(partition: string, sortKey: string | null): string {
        return `${partition.length}:${partition}#${sortKey ?? ""}`;
    }

    private async partitionKey(key: string): Promise<string> {
        return `${this.keyPrefix}#${this.namespace}#${await sha256(key)}`;
    }

    /**
     * One of an entry's item keys. A plain-string entry keeps the bare
     * suffix it has always used; a grouped one nests under its escaped sort
     * key, whose trailing `#` is an unambiguous boundary because an escaped
     * sort key never contains a bare `#`.
     */
    private itemSortKey(address: CacheAddress, suffix: string): string {
        return address.sortKey === null ? suffix : `${SORT_KEY_MARKER}${encodeSortKey(address.sortKey)}#${suffix}`;
    }

    /** The prefix covering every item of a grouped entry; null for a plain-string entry, which owns the bare item keys instead. */
    private entryItemPrefix(address: CacheAddress): string | null {
        return address.sortKey === null ? null : `${SORT_KEY_MARKER}${encodeSortKey(address.sortKey)}#`;
    }

    private isManifestSortKey(sk: string | undefined): boolean {
        return sk === META_SORT_KEY || (!!sk && sk.startsWith(SORT_KEY_MARKER) && sk.endsWith(`#${META_SORT_KEY}`));
    }

    private chunkSortKey(address: CacheAddress, version: string, index: number): string {
        return this.itemSortKey(address, `${CHUNK_SORT_KEY_PREFIX}${version}#${String(index).padStart(6, "0")}`);
    }

    /** Drop every in-memory copy belonging to one partition. */
    private forgetPartition(partition: string): void {
        if (!this.memory) return;
        const prefix = this.memoryKeyOf(partition, "");
        for (const key of [...this.memory.keys()]) {
            if (key.startsWith(prefix)) this.memory.delete(key);
        }
    }

    private nowSeconds(): number {
        return Math.floor(Date.now() / 1000);
    }

    private isConditionalFailure(error: unknown): boolean {
        return !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";
    }
}
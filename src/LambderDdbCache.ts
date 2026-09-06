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
import { getCrypto, getZlib } from "./node-polyfills.js";
import { LRUCache } from "lru-cache";

const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_CHUNK_BYTES = 350 * 1024;
const MAX_SAFE_CHUNK_BYTES = 380 * 1024;
const DEFAULT_MAX_VALUE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MEMORY_BYTES = 16 * 1024 * 1024;
const META_SORT_KEY = "meta";
const LOCK_SORT_KEY = "lock";
const BATCH_WRITE_LIMIT = 25;
const MAX_BATCH_RETRIES = 8;

interface CacheManifest {
    version: string;
    chunkCount: number;
    compressedBytes: number;
    uncompressedBytes: number;
    checksum: string;
    expiresAt: number;
    inlineData?: Buffer;
}

interface MemoryEntry {
    compressed: Buffer;
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
    compressionQuality?: number;
    maxValueBytes?: number;
    memoryMaxBytes?: number;
    client?: DynamoDBClient;
}

export interface LambderDdbCacheSetOptions {
    ttlSeconds?: number;
}

export interface LambderDdbCacheGetOrSetOptions extends LambderDdbCacheSetOptions {
    leaseSeconds?: number;
    waitForFillMs?: number;
}

// Node builtins are loaded lazily through node-polyfills so this module can
// sit in a frontend bundle's import graph (via the package root) without
// breaking; using the cache at runtime still requires Node.
const requireZlib = async () => {
    const zlib = await getZlib();
    if (!zlib) throw new Error("LambderDdbCache requires a Node.js environment.");
    return zlib;
};
const requireCrypto = async () => {
    const crypto = await getCrypto();
    if (!crypto) throw new Error("LambderDdbCache requires a Node.js environment.");
    return crypto;
};

const compress = async (input: Buffer, quality: number): Promise<Buffer> => {
    const zlib = await requireZlib();
    return new Promise((resolve, reject) => {
        zlib.brotliCompress(
            input,
            {
                params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
                    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                },
            },
            (error, output) => {
                if (error) reject(error);
                else resolve(output);
            },
        );
    });
};

const decompress = async (input: Buffer, maxOutputLength: number): Promise<Buffer> => {
    const zlib = await requireZlib();
    return new Promise((resolve, reject) => {
        zlib.brotliDecompress(input, { maxOutputLength }, (error, output) => {
            if (error) reject(error);
            else resolve(output);
        });
    });
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
 * Values are Brotli-compressed. Values within the safe DynamoDB item budget are
 * stored directly in the manifest for a single-request read; larger values are
 * split into versioned binary chunks. A manifest is written only after every
 * chunk succeeds, so readers see either the previous complete version or the
 * new complete version. DynamoDB TTL is cleanup only; every read also checks
 * expiresAt because TTL deletion can lag.
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on
 * `expiresAt`. Items are prefixed `CACHE#<namespace>#` by default, so the
 * table can be shared with LambderDdbRateLimiter (`RL#`) and
 * LambderDdbIdempotency (`IDEM#`) without key collisions.
 */
export class LambderDdbCache {
    readonly tableName: string;
    readonly keyPrefix: string;
    readonly namespace: string;

    private readonly client: DynamoDBClient;
    private readonly defaultTtlSeconds: number;
    private readonly chunkBytes: number;
    private readonly compressionQuality: number;
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

        this.compressionQuality = options.compressionQuality ?? 5;
        if (!Number.isInteger(this.compressionQuality) || this.compressionQuality < 0 || this.compressionQuality > 11) {
            throw new Error("compressionQuality must be an integer from 0 to 11");
        }

        this.maxValueBytes = positiveInteger(
            options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES,
            "maxValueBytes",
        );
        const memoryMaxBytes = options.memoryMaxBytes ?? DEFAULT_MEMORY_BYTES;
        this.memory = memoryMaxBytes === 0
            ? null
            : new LRUCache<string, MemoryEntry>({
                maxSize: positiveInteger(memoryMaxBytes, "memoryMaxBytes"),
                sizeCalculation: (entry) => entry.compressed.length,
            });
        this.client = options.client ?? new DynamoDBClient({ region: options.region ?? "us-east-1" });
    }

    async get<T>(key: string): Promise<T | undefined> {
        const normalizedKey = this.normalizeKey(key);
        const cached = this.memory?.get(normalizedKey);
        const nowSeconds = this.nowSeconds();
        if (cached && cached.expiresAt > nowSeconds) {
            try {
                const output = await decompress(cached.compressed, this.maxValueBytes);
                if (output.length === cached.uncompressedBytes) {
                    return JSON.parse(output.toString("utf8")) as T;
                }
            } catch {
                // Fall through to DynamoDB; the in-memory copy is disposable.
            }
        }
        if (cached) this.memory?.delete(normalizedKey);

        const pk = await this.partitionKey(normalizedKey);
        const manifest = await this.readManifest(pk);
        if (!manifest || manifest.expiresAt <= nowSeconds) return undefined;

        try {
            const compressed = manifest.inlineData ?? await this.readChunks(pk, manifest);
            if (compressed.length !== manifest.compressedBytes) {
                throw new Error("compressed byte length does not match manifest");
            }
            if (await sha256(compressed) !== manifest.checksum) {
                throw new Error("compressed checksum does not match manifest");
            }

            const output = await decompress(compressed, this.maxValueBytes);
            if (output.length !== manifest.uncompressedBytes) {
                throw new Error("uncompressed byte length does not match manifest");
            }
            const json = output.toString("utf8");
            const parsed = JSON.parse(json) as T;
            this.remember(normalizedKey, compressed, output.length, manifest.expiresAt);
            return parsed;
        } catch (error) {
            await this.invalidateManifest(pk, manifest.version);
            console.warn(`Ignoring corrupt DynamoDB cache entry in ${this.namespace}`, error);
            return undefined;
        }
    }

    async has(key: string): Promise<boolean> {
        const normalizedKey = this.normalizeKey(key);
        const cached = this.memory?.get(normalizedKey);
        const nowSeconds = this.nowSeconds();
        if (cached?.expiresAt && cached.expiresAt > nowSeconds) return true;
        if (cached) this.memory?.delete(normalizedKey);

        const manifest = await this.readManifest(await this.partitionKey(normalizedKey));
        return !!manifest && manifest.expiresAt > nowSeconds;
    }

    async set<T>(key: string, value: T, options: LambderDdbCacheSetOptions = {}): Promise<void> {
        const normalizedKey = this.normalizeKey(key);
        const ttlSeconds = positiveInteger(options.ttlSeconds ?? this.defaultTtlSeconds, "ttlSeconds");
        const json = JSON.stringify(value);
        if (json === undefined) throw new Error("Cache value must be JSON-serializable");

        const input = Buffer.from(json, "utf8");
        if (input.length > this.maxValueBytes) {
            throw new Error(`Cache value exceeds maxValueBytes (${input.length} > ${this.maxValueBytes})`);
        }

        const compressed = await compress(input, this.compressionQuality);
        if (compressed.length > this.maxValueBytes) {
            throw new Error(`Compressed cache value exceeds maxValueBytes (${compressed.length} > ${this.maxValueBytes})`);
        }

        const pk = await this.partitionKey(normalizedKey);
        const version = `${Date.now().toString(36)}-${await randomUUID()}`;
        const expiresAt = this.nowSeconds() + ttlSeconds;
        const chunks: Buffer[] = [];
        const inline = compressed.length <= this.chunkBytes;
        if (!inline) {
            for (let offset = 0; offset < compressed.length; offset += this.chunkBytes) {
                chunks.push(compressed.subarray(offset, offset + this.chunkBytes));
            }
        }

        const writes: WriteRequest[] = chunks.map((chunk, index) => ({
            PutRequest: {
                Item: {
                    pk: { S: pk },
                    sk: { S: this.chunkSortKey(version, index) },
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
                    sk: { S: META_SORT_KEY },
                    version: { S: version },
                    chunkCount: { N: String(chunks.length) },
                    compressedBytes: { N: String(compressed.length) },
                    uncompressedBytes: { N: String(input.length) },
                    checksum: { S: await sha256(compressed) },
                    encoding: { S: "br" },
                    createdAt: { N: String(this.nowSeconds()) },
                    expiresAt: { N: String(expiresAt) },
                    ...(inline ? { data: { B: compressed } } : {}),
                },
            }),
        );
        this.remember(normalizedKey, compressed, input.length, expiresAt);
    }

    async delete(key: string): Promise<boolean> {
        const normalizedKey = this.normalizeKey(key);
        const pk = await this.partitionKey(normalizedKey);
        this.memory?.delete(normalizedKey);

        const keys: Array<Record<string, AttributeValue>> = [];
        let cursor: Record<string, AttributeValue> | undefined;
        do {
            const response = await this.client.send(
                new QueryCommand({
                    TableName: this.tableName,
                    KeyConditionExpression: "#pk = :pk",
                    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                    ExpressionAttributeValues: { ":pk": { S: pk } },
                    ProjectionExpression: "#pk, #sk",
                    ExclusiveStartKey: cursor,
                }),
            );
            for (const item of response.Items ?? []) {
                if (item.pk && item.sk) keys.push({ pk: item.pk, sk: item.sk });
            }
            cursor = response.LastEvaluatedKey;
        } while (cursor);

        await this.batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
        return keys.length > 0;
    }

    async getOrSet<T>(
        key: string,
        factory: () => Promise<T>,
        options: LambderDdbCacheGetOrSetOptions = {},
    ): Promise<T> {
        const normalizedKey = this.normalizeKey(key);
        const current = this.inFlight.get(normalizedKey) as Promise<T> | undefined;
        if (current) return current;

        const fill = this.getOrSetFailOpen(normalizedKey, factory, options).finally(() => {
            this.inFlight.delete(normalizedKey);
        });
        this.inFlight.set(normalizedKey, fill);
        return fill;
    }

    /**
     * Cache infrastructure is best-effort for getOrSet: read, lease, or write
     * failures return the loader value. Loader failures still propagate and the
     * loader is never repeated after it has completed successfully.
     */
    private async getOrSetFailOpen<T>(
        key: string,
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
            const existing = await this.get<T>(key);
            if (existing !== undefined) return existing;
            return await this.fill(key, trackedFactory, options);
        } catch (error) {
            if (factoryStarted && !factoryCompleted) throw error;
            console.error(`DynamoDB cache failed open in ${this.namespace} for ${key}`, error);
            if (factoryCompleted) return factoryValue as T;
            return trackedFactory();
        }
    }

    private async fill<T>(
        key: string,
        factory: () => Promise<T>,
        options: LambderDdbCacheGetOrSetOptions,
    ): Promise<T> {
        const leaseSeconds = positiveInteger(options.leaseSeconds ?? 15, "leaseSeconds");
        const waitForFillMs = positiveInteger(options.waitForFillMs ?? 5_000, "waitForFillMs");
        const pk = await this.partitionKey(key);
        const owner = await randomUUID();

        if (await this.acquireLease(pk, owner, leaseSeconds)) {
            try {
                const value = await factory();
                await this.set(key, value, { ttlSeconds: options.ttlSeconds });
                return value;
            } finally {
                await this.releaseLease(pk, owner);
            }
        }

        const deadline = Date.now() + waitForFillMs;
        let delay = 50;
        while (Date.now() < deadline) {
            await sleep(delay + Math.floor(Math.random() * 25));
            const value = await this.get<T>(key);
            if (value !== undefined) return value;
            if (await this.acquireLease(pk, owner, leaseSeconds)) {
                try {
                    const loaded = await factory();
                    await this.set(key, loaded, { ttlSeconds: options.ttlSeconds });
                    return loaded;
                } finally {
                    await this.releaseLease(pk, owner);
                }
            }
            delay = Math.min(delay * 2, 500);
        }

        throw new Error(`Timed out waiting for DynamoDB cache fill in ${this.namespace}`);
    }

    private async acquireLease(pk: string, owner: string, leaseSeconds: number): Promise<boolean> {
        const now = this.nowSeconds();
        try {
            await this.client.send(
                new PutItemCommand({
                    TableName: this.tableName,
                    Item: {
                        pk: { S: pk },
                        sk: { S: LOCK_SORT_KEY },
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

    private async releaseLease(pk: string, owner: string): Promise<void> {
        try {
            await this.client.send(
                new DeleteItemCommand({
                    TableName: this.tableName,
                    Key: { pk: { S: pk }, sk: { S: LOCK_SORT_KEY } },
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

    private async readManifest(pk: string): Promise<CacheManifest | undefined> {
        const response = await this.client.send(
            new GetItemCommand({
                TableName: this.tableName,
                Key: { pk: { S: pk }, sk: { S: META_SORT_KEY } },
                ConsistentRead: false,
            }),
        );
        const item = response.Item;
        if (!item) return undefined;

        const version = item.version?.S;
        const encoding = item.encoding?.S;
        const chunkCount = Number(item.chunkCount?.N);
        const compressedBytes = Number(item.compressedBytes?.N);
        const uncompressedBytes = Number(item.uncompressedBytes?.N);
        const expiresAt = Number(item.expiresAt?.N);
        const checksum = item.checksum?.S;
        const inlineData = item.data?.B == null ? undefined : Buffer.from(item.data.B);
        const validInline =
            inlineData !== undefined &&
            chunkCount === 0 &&
            inlineData.length === compressedBytes &&
            compressedBytes <= this.chunkBytes;
        const validChunks =
            inlineData === undefined &&
            chunkCount > 0 &&
            chunkCount === Math.ceil(compressedBytes / this.chunkBytes);
        if (
            !version ||
            encoding !== "br" ||
            !checksum ||
            !Number.isSafeInteger(chunkCount) ||
            chunkCount < 0 ||
            !Number.isSafeInteger(compressedBytes) ||
            compressedBytes < 0 ||
            compressedBytes > this.maxValueBytes ||
            !Number.isSafeInteger(uncompressedBytes) ||
            uncompressedBytes < 0 ||
            uncompressedBytes > this.maxValueBytes ||
            !Number.isSafeInteger(expiresAt) ||
            (!validInline && !validChunks)
        ) {
            return undefined;
        }
        return {
            version,
            chunkCount,
            compressedBytes,
            uncompressedBytes,
            checksum,
            expiresAt,
            inlineData,
        };
    }

    private async readChunks(pk: string, manifest: CacheManifest): Promise<Buffer> {
        const prefix = `chunk#${manifest.version}#`;
        const chunks: Array<{ sk: string; data: Buffer }> = [];
        let cursor: Record<string, AttributeValue> | undefined;
        do {
            const response = await this.client.send(
                new QueryCommand({
                    TableName: this.tableName,
                    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
                    ExpressionAttributeValues: { ":pk": { S: pk }, ":prefix": { S: prefix } },
                    ProjectionExpression: "#sk, #data",
                    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#data": "data" },
                    ExclusiveStartKey: cursor,
                    ConsistentRead: false,
                }),
            );
            for (const item of response.Items ?? []) {
                if (item.sk?.S && item.data?.B) {
                    chunks.push({ sk: item.sk.S, data: Buffer.from(item.data.B) });
                }
            }
            cursor = response.LastEvaluatedKey;
        } while (cursor);

        chunks.sort((left, right) => left.sk.localeCompare(right.sk));
        if (chunks.length !== manifest.chunkCount) {
            throw new Error(`DynamoDB cache entry is missing chunks (${chunks.length}/${manifest.chunkCount})`);
        }
        for (let index = 0; index < chunks.length; index += 1) {
            if (chunks[index]?.sk !== this.chunkSortKey(manifest.version, index)) {
                throw new Error(`DynamoDB cache entry has an invalid chunk index at ${index}`);
            }
        }
        return Buffer.concat(chunks.map((chunk) => chunk.data), manifest.compressedBytes);
    }

    private async invalidateManifest(pk: string, version: string): Promise<void> {
        try {
            await this.client.send(
                new DeleteItemCommand({
                    TableName: this.tableName,
                    Key: { pk: { S: pk }, sk: { S: META_SORT_KEY } },
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

    private remember(
        key: string,
        compressed: Buffer,
        uncompressedBytes: number,
        expiresAt: number,
    ): void {
        if (!this.memory) return;
        const ttl = expiresAt * 1000 - Date.now();
        if (ttl <= 0) return;
        this.memory.set(key, { compressed, uncompressedBytes, expiresAt }, { ttl });
    }

    private normalizeKey(key: string): string {
        if (typeof key !== "string" || !key.trim()) throw new Error("Cache key is required");
        if (Buffer.byteLength(key, "utf8") > 8 * 1024) {
            throw new Error("Cache key must be at most 8192 UTF-8 bytes");
        }
        return key;
    }

    private async partitionKey(key: string): Promise<string> {
        return `${this.keyPrefix}#${this.namespace}#${await sha256(key)}`;
    }

    private chunkSortKey(version: string, index: number): string {
        return `chunk#${version}#${String(index).padStart(6, "0")}`;
    }

    private nowSeconds(): number {
        return Math.floor(Date.now() / 1000);
    }

    private isConditionalFailure(error: unknown): boolean {
        return !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";
    }
}
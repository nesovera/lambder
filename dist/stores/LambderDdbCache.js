import { BatchWriteItemCommand, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, } from "@aws-sdk/client-dynamodb";
import { getCrypto } from "../shared/node-polyfills.js";
import { brotliCompressText, brotliDecompressText } from "./LambderDdbCompression.js";
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
// Node builtins are loaded lazily through node-polyfills so this module can
// sit in a frontend bundle's import graph (via the package root) without
// breaking; using the cache at runtime still requires Node. Brotli helpers
// are shared with LambderDdbIdempotency via ./LambderDdbCompression.js.
const requireCrypto = async () => {
    const crypto = await getCrypto();
    if (!crypto)
        throw new Error("LambderDdbCache requires a Node.js environment.");
    return crypto;
};
const sha256 = async (value) => {
    const crypto = await requireCrypto();
    return crypto.createHash("sha256").update(value).digest("hex");
};
const randomUUID = async () => {
    const crypto = await requireCrypto();
    return crypto.randomUUID();
};
const positiveInteger = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    tableName;
    keyPrefix;
    namespace;
    client;
    defaultTtlSeconds;
    chunkBytes;
    compressionQuality;
    maxValueBytes;
    memory;
    inFlight = new Map();
    constructor(options) {
        if (!options.tableName.trim())
            throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "CACHE";
        this.namespace = options.namespace?.trim() || "default";
        if (Buffer.byteLength(this.namespace, "utf8") > 128) {
            throw new Error("namespace must be at most 128 UTF-8 bytes");
        }
        this.defaultTtlSeconds = positiveInteger(options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS, "defaultTtlSeconds");
        this.chunkBytes = positiveInteger(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, "chunkBytes");
        if (this.chunkBytes > MAX_SAFE_CHUNK_BYTES) {
            throw new Error(`chunkBytes must not exceed ${MAX_SAFE_CHUNK_BYTES}`);
        }
        this.compressionQuality = options.compressionQuality ?? 5;
        if (!Number.isInteger(this.compressionQuality) || this.compressionQuality < 0 || this.compressionQuality > 11) {
            throw new Error("compressionQuality must be an integer from 0 to 11");
        }
        this.maxValueBytes = positiveInteger(options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES, "maxValueBytes");
        const memoryMaxBytes = options.memoryMaxBytes ?? DEFAULT_MEMORY_BYTES;
        this.memory = memoryMaxBytes === 0
            ? null
            : new LRUCache({
                maxSize: positiveInteger(memoryMaxBytes, "memoryMaxBytes"),
                sizeCalculation: (entry) => entry.compressed.length,
            });
        this.client = options.client ?? new DynamoDBClient({ region: options.region ?? "us-east-1" });
    }
    async get(key) {
        const normalizedKey = this.normalizeKey(key);
        const cached = this.memory?.get(normalizedKey);
        const nowSeconds = this.nowSeconds();
        if (cached && cached.expiresAt > nowSeconds) {
            try {
                const output = await brotliDecompressText(cached.compressed, this.maxValueBytes);
                if (output.length === cached.uncompressedBytes) {
                    return JSON.parse(output.toString("utf8"));
                }
            }
            catch {
                // Fall through to DynamoDB; the in-memory copy is disposable.
            }
        }
        if (cached)
            this.memory?.delete(normalizedKey);
        const pk = await this.partitionKey(normalizedKey);
        const manifest = await this.readManifest(pk);
        if (!manifest || manifest.expiresAt <= nowSeconds)
            return undefined;
        try {
            const compressed = manifest.inlineData ?? await this.readChunks(pk, manifest);
            if (compressed.length !== manifest.compressedBytes) {
                throw new Error("compressed byte length does not match manifest");
            }
            if (await sha256(compressed) !== manifest.checksum) {
                throw new Error("compressed checksum does not match manifest");
            }
            const output = await brotliDecompressText(compressed, this.maxValueBytes);
            if (output.length !== manifest.uncompressedBytes) {
                throw new Error("uncompressed byte length does not match manifest");
            }
            const json = output.toString("utf8");
            const parsed = JSON.parse(json);
            this.remember(normalizedKey, compressed, output.length, manifest.expiresAt);
            return parsed;
        }
        catch (error) {
            await this.invalidateManifest(pk, manifest.version);
            console.warn(`Ignoring corrupt DynamoDB cache entry in ${this.namespace}`, error);
            return undefined;
        }
    }
    async has(key) {
        const normalizedKey = this.normalizeKey(key);
        const cached = this.memory?.get(normalizedKey);
        const nowSeconds = this.nowSeconds();
        if (cached?.expiresAt && cached.expiresAt > nowSeconds)
            return true;
        if (cached)
            this.memory?.delete(normalizedKey);
        const manifest = await this.readManifest(await this.partitionKey(normalizedKey));
        return !!manifest && manifest.expiresAt > nowSeconds;
    }
    async set(key, value, options = {}) {
        const normalizedKey = this.normalizeKey(key);
        const ttlSeconds = positiveInteger(options.ttlSeconds ?? this.defaultTtlSeconds, "ttlSeconds");
        const json = JSON.stringify(value);
        if (json === undefined)
            throw new Error("Cache value must be JSON-serializable");
        const input = Buffer.from(json, "utf8");
        if (input.length > this.maxValueBytes) {
            throw new Error(`Cache value exceeds maxValueBytes (${input.length} > ${this.maxValueBytes})`);
        }
        const compressed = await brotliCompressText(input, this.compressionQuality);
        if (compressed.length > this.maxValueBytes) {
            throw new Error(`Compressed cache value exceeds maxValueBytes (${compressed.length} > ${this.maxValueBytes})`);
        }
        const pk = await this.partitionKey(normalizedKey);
        const version = `${Date.now().toString(36)}-${await randomUUID()}`;
        const expiresAt = this.nowSeconds() + ttlSeconds;
        const chunks = [];
        const inline = compressed.length <= this.chunkBytes;
        if (!inline) {
            for (let offset = 0; offset < compressed.length; offset += this.chunkBytes) {
                chunks.push(compressed.subarray(offset, offset + this.chunkBytes));
            }
        }
        const writes = chunks.map((chunk, index) => ({
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
        await this.client.send(new PutItemCommand({
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
        }));
        this.remember(normalizedKey, compressed, input.length, expiresAt);
    }
    async delete(key) {
        const normalizedKey = this.normalizeKey(key);
        const pk = await this.partitionKey(normalizedKey);
        this.memory?.delete(normalizedKey);
        const keys = [];
        let cursor;
        do {
            const response = await this.client.send(new QueryCommand({
                TableName: this.tableName,
                KeyConditionExpression: "#pk = :pk",
                ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                ExpressionAttributeValues: { ":pk": { S: pk } },
                ProjectionExpression: "#pk, #sk",
                ExclusiveStartKey: cursor,
            }));
            for (const item of response.Items ?? []) {
                if (item.pk && item.sk)
                    keys.push({ pk: item.pk, sk: item.sk });
            }
            cursor = response.LastEvaluatedKey;
        } while (cursor);
        await this.batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
        return keys.length > 0;
    }
    async getOrSet(key, factory, options = {}) {
        const normalizedKey = this.normalizeKey(key);
        const current = this.inFlight.get(normalizedKey);
        if (current)
            return current;
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
    async getOrSetFailOpen(key, factory, options) {
        let factoryStarted = false;
        let factoryCompleted = false;
        let factoryValue;
        const trackedFactory = async () => {
            factoryStarted = true;
            factoryValue = await factory();
            factoryCompleted = true;
            return factoryValue;
        };
        try {
            const existing = await this.get(key);
            if (existing !== undefined)
                return existing;
            return await this.fill(key, trackedFactory, options);
        }
        catch (error) {
            if (factoryStarted && !factoryCompleted)
                throw error;
            console.error(`DynamoDB cache failed open in ${this.namespace} for ${key}`, error);
            if (factoryCompleted)
                return factoryValue;
            return trackedFactory();
        }
    }
    async fill(key, factory, options) {
        const leaseSeconds = positiveInteger(options.leaseSeconds ?? 15, "leaseSeconds");
        const waitForFillMs = positiveInteger(options.waitForFillMs ?? 5_000, "waitForFillMs");
        const pk = await this.partitionKey(key);
        const owner = await randomUUID();
        if (await this.acquireLease(pk, owner, leaseSeconds)) {
            try {
                const value = await factory();
                await this.set(key, value, { ttlSeconds: options.ttlSeconds });
                return value;
            }
            finally {
                await this.releaseLease(pk, owner);
            }
        }
        const deadline = Date.now() + waitForFillMs;
        let delay = 50;
        while (Date.now() < deadline) {
            await sleep(delay + Math.floor(Math.random() * 25));
            const value = await this.get(key);
            if (value !== undefined)
                return value;
            if (await this.acquireLease(pk, owner, leaseSeconds)) {
                try {
                    const loaded = await factory();
                    await this.set(key, loaded, { ttlSeconds: options.ttlSeconds });
                    return loaded;
                }
                finally {
                    await this.releaseLease(pk, owner);
                }
            }
            delay = Math.min(delay * 2, 500);
        }
        throw new Error(`Timed out waiting for DynamoDB cache fill in ${this.namespace}`);
    }
    async acquireLease(pk, owner, leaseSeconds) {
        const now = this.nowSeconds();
        try {
            await this.client.send(new PutItemCommand({
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
            }));
            return true;
        }
        catch (error) {
            if (this.isConditionalFailure(error))
                return false;
            throw error;
        }
    }
    async releaseLease(pk, owner) {
        try {
            await this.client.send(new DeleteItemCommand({
                TableName: this.tableName,
                Key: { pk: { S: pk }, sk: { S: LOCK_SORT_KEY } },
                ConditionExpression: "#owner = :owner",
                ExpressionAttributeNames: { "#owner": "owner" },
                ExpressionAttributeValues: { ":owner": { S: owner } },
            }));
        }
        catch (error) {
            if (!this.isConditionalFailure(error)) {
                console.warn(`Failed to release DynamoDB cache lease in ${this.namespace}`, error);
            }
        }
    }
    async readManifest(pk) {
        const response = await this.client.send(new GetItemCommand({
            TableName: this.tableName,
            Key: { pk: { S: pk }, sk: { S: META_SORT_KEY } },
            ConsistentRead: false,
        }));
        const item = response.Item;
        if (!item)
            return undefined;
        const version = item.version?.S;
        const encoding = item.encoding?.S;
        const chunkCount = Number(item.chunkCount?.N);
        const compressedBytes = Number(item.compressedBytes?.N);
        const uncompressedBytes = Number(item.uncompressedBytes?.N);
        const expiresAt = Number(item.expiresAt?.N);
        const checksum = item.checksum?.S;
        const inlineData = item.data?.B == null ? undefined : Buffer.from(item.data.B);
        const validInline = inlineData !== undefined &&
            chunkCount === 0 &&
            inlineData.length === compressedBytes &&
            compressedBytes <= this.chunkBytes;
        const validChunks = inlineData === undefined &&
            chunkCount > 0 &&
            chunkCount === Math.ceil(compressedBytes / this.chunkBytes);
        if (!version ||
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
            (!validInline && !validChunks)) {
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
    async readChunks(pk, manifest) {
        const prefix = `chunk#${manifest.version}#`;
        const chunks = [];
        let cursor;
        do {
            const response = await this.client.send(new QueryCommand({
                TableName: this.tableName,
                KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
                ExpressionAttributeValues: { ":pk": { S: pk }, ":prefix": { S: prefix } },
                ProjectionExpression: "#sk, #data",
                ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#data": "data" },
                ExclusiveStartKey: cursor,
                ConsistentRead: false,
            }));
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
    async invalidateManifest(pk, version) {
        try {
            await this.client.send(new DeleteItemCommand({
                TableName: this.tableName,
                Key: { pk: { S: pk }, sk: { S: META_SORT_KEY } },
                ConditionExpression: "#version = :version",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: { ":version": { S: version } },
            }));
        }
        catch (error) {
            if (!this.isConditionalFailure(error)) {
                console.warn(`Failed to invalidate corrupt DynamoDB cache manifest in ${this.namespace}`, error);
            }
        }
    }
    async batchWrite(requests) {
        for (let offset = 0; offset < requests.length; offset += BATCH_WRITE_LIMIT) {
            let pending = requests.slice(offset, offset + BATCH_WRITE_LIMIT);
            for (let attempt = 0; pending.length > 0; attempt += 1) {
                if (attempt >= MAX_BATCH_RETRIES) {
                    throw new Error(`DynamoDB cache batch write remained throttled after ${MAX_BATCH_RETRIES} attempts`);
                }
                const response = await this.client.send(new BatchWriteItemCommand({ RequestItems: { [this.tableName]: pending } }));
                pending = response.UnprocessedItems?.[this.tableName] ?? [];
                if (pending.length > 0) {
                    const backoff = Math.min(25 * 2 ** attempt, 1_000) + Math.floor(Math.random() * 50);
                    await sleep(backoff);
                }
            }
        }
    }
    remember(key, compressed, uncompressedBytes, expiresAt) {
        if (!this.memory)
            return;
        const ttl = expiresAt * 1000 - Date.now();
        if (ttl <= 0)
            return;
        this.memory.set(key, { compressed, uncompressedBytes, expiresAt }, { ttl });
    }
    normalizeKey(key) {
        if (typeof key !== "string" || !key.trim())
            throw new Error("Cache key is required");
        if (Buffer.byteLength(key, "utf8") > 8 * 1024) {
            throw new Error("Cache key must be at most 8192 UTF-8 bytes");
        }
        return key;
    }
    async partitionKey(key) {
        return `${this.keyPrefix}#${this.namespace}#${await sha256(key)}`;
    }
    chunkSortKey(version, index) {
        return `chunk#${version}#${String(index).padStart(6, "0")}`;
    }
    nowSeconds() {
        return Math.floor(Date.now() / 1000);
    }
    isConditionalFailure(error) {
        return !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";
    }
}

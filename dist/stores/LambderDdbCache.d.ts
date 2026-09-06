import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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
export declare class LambderDdbCache {
    readonly tableName: string;
    readonly keyPrefix: string;
    readonly namespace: string;
    private readonly client;
    private readonly defaultTtlSeconds;
    private readonly chunkBytes;
    private readonly compressionQuality;
    private readonly maxValueBytes;
    private readonly memory;
    private readonly inFlight;
    constructor(options: LambderDdbCacheOptions);
    get<T>(key: string): Promise<T | undefined>;
    has(key: string): Promise<boolean>;
    set<T>(key: string, value: T, options?: LambderDdbCacheSetOptions): Promise<void>;
    delete(key: string): Promise<boolean>;
    getOrSet<T>(key: string, factory: () => Promise<T>, options?: LambderDdbCacheGetOrSetOptions): Promise<T>;
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
    private invalidateManifest;
    private batchWrite;
    private remember;
    private normalizeKey;
    private partitionKey;
    private chunkSortKey;
    private nowSeconds;
    private isConditionalFailure;
}

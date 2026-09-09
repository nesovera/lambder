import {
    BatchWriteItemCommand,
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LambderDdbCache } from "../src/stores/LambderDdbCache.js";

type Item = Record<string, AttributeValue>;

const conditionalFailure = (): Error =>
    Object.assign(new Error("conditional request failed"), {
        name: "ConditionalCheckFailedException",
    });

class MemoryDynamoClient extends DynamoDBClient {
    readonly items = new Map<string, Item>();
    readonly commands: any[] = [];
    failNextBatch = false;
    failNextGet = false;
    unprocessBatchAttempts = 0;
    queryPageSize = Number.POSITIVE_INFINITY;

    constructor() {
        super({
            region: "us-east-1",
            credentials: { accessKeyId: "test", secretAccessKey: "test" },
        });
    }

    async send(command: any): Promise<any> {
        this.commands.push(command);
        if (command instanceof GetItemCommand) {
            if (this.failNextGet) {
                this.failNextGet = false;
                throw new Error("simulated read failure");
            }
            return { Item: this.items.get(this.keyOf(command.input.Key)) };
        }

        if (command instanceof PutItemCommand) {
            const item = command.input.Item;
            if (!item) throw new Error("PutItem is missing Item");
            const key = this.keyOf(item);
            const existing = this.items.get(key);
            if (command.input.ConditionExpression?.includes("attribute_not_exists") && existing) {
                const now = Number(command.input.ExpressionAttributeValues?.[":now"]?.N);
                const expiresAt = Number(existing.expiresAt?.N);
                if (!(expiresAt < now)) throw conditionalFailure();
            }
            this.items.set(key, item);
            return {};
        }

        if (command instanceof DeleteItemCommand) {
            const key = this.keyOf(command.input.Key);
            const existing = this.items.get(key);
            const expectedOwner = command.input.ExpressionAttributeValues?.[":owner"]?.S;
            const expectedVersion = command.input.ExpressionAttributeValues?.[":version"]?.S;
            if (
                (expectedOwner && existing?.owner?.S !== expectedOwner) ||
                (expectedVersion && existing?.version?.S !== expectedVersion)
            ) {
                throw conditionalFailure();
            }
            this.items.delete(key);
            return {};
        }

        if (command instanceof BatchWriteItemCommand) {
            if (this.failNextBatch) {
                this.failNextBatch = false;
                throw new Error("simulated batch failure");
            }
            const requests = command.input.RequestItems?.["test-cache"] ?? [];
            if (this.unprocessBatchAttempts > 0) {
                this.unprocessBatchAttempts -= 1;
                return { UnprocessedItems: { "test-cache": requests } };
            }
            for (const request of requests) {
                if (request.PutRequest?.Item) {
                    this.items.set(this.keyOf(request.PutRequest.Item), request.PutRequest.Item);
                }
                if (request.DeleteRequest?.Key) {
                    this.items.delete(this.keyOf(request.DeleteRequest.Key));
                }
            }
            return { UnprocessedItems: {} };
        }

        if (command instanceof QueryCommand) {
            const pk = command.input.ExpressionAttributeValues?.[":pk"]?.S;
            const prefix = command.input.ExpressionAttributeValues?.[":prefix"]?.S;
            const matching = [...this.items.values()]
                .filter((item) => item.pk?.S === pk && (!prefix || item.sk?.S?.startsWith(prefix)))
                .sort((left, right) => (left.sk?.S ?? "").localeCompare(right.sk?.S ?? ""));
            const after = command.input.ExclusiveStartKey?.sk?.S;
            const start = after
                ? Math.max(0, matching.findIndex((item) => item.sk?.S === after) + 1)
                : 0;
            const Items = matching.slice(start, start + this.queryPageSize);
            const hasMore = start + Items.length < matching.length;
            const last = Items.at(-1);
            return {
                Items,
                LastEvaluatedKey: hasMore && last ? { pk: last.pk, sk: last.sk } : undefined,
            };
        }

        throw new Error(`Unsupported command: ${command.constructor.name}`);
    }

    corruptFirstChunk(): void {
        const chunk = [...this.items.values()].find((item) => item.sk?.S?.startsWith("chunk#"));
        if (!chunk) throw new Error("No chunk found to corrupt");
        chunk.data = { B: Buffer.from("corrupt") };
    }

    commandCount(name: string): number {
        return this.commands.filter((command) => command.constructor.name === name).length;
    }

    batchSizes(): number[] {
        return this.commands
            .filter((command) => command instanceof BatchWriteItemCommand)
            .map((command) => command.input.RequestItems?.["test-cache"]?.length ?? 0);
    }

    resetCommands(): void {
        this.commands.length = 0;
    }

    private keyOf(item: Item | undefined): string {
        if (!item?.pk?.S || !item.sk?.S) throw new Error("Missing DynamoDB key");
        return `${item.pk.S}|${item.sk.S}`;
    }
}

const createCache = (
    client: MemoryDynamoClient,
    chunkBytes = 512,
    extra: Pick<ConstructorParameters<typeof LambderDdbCache>[0], "compression"> = {},
): LambderDdbCache =>
    new LambderDdbCache({
        tableName: "test-cache",
        namespace: "unit",
        client,
        chunkBytes,
        memoryMaxBytes: 1024 * 1024,
        ...extra,
    });

const largePayload = () => ({
    rows: Array.from({ length: 300 }, (_, index) => ({
        index,
        value: createHash("sha256").update(`row-${index}`).digest("hex"),
    })),
});

const oversizedPayload = () => ({
    data: Array.from({ length: 20_000 }, (_, index) =>
        createHash("sha256").update(`oversized-row-${index}`).digest("hex"),
    ).join(""),
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("LambderDdbCache", () => {
    it("stores small values inline for one-request reads and zero-request memory hits", async () => {
        const client = new MemoryDynamoClient();
        const writer = createCache(client);
        const value = { city: "Istanbul", timezone: "Europe/Istanbul" };

        await writer.set("city", value);

        const manifest = [...client.items.values()].find((item) => item.sk?.S === "meta");
        expect(manifest?.chunkCount?.N).toBe("0");
        expect(manifest?.data?.B?.byteLength).toBeGreaterThan(0);
        expect(client.commandCount("PutItemCommand")).toBe(1);
        expect(client.commandCount("BatchWriteItemCommand")).toBe(0);

        client.resetCommands();
        const reader = createCache(client);
        await expect(reader.get<typeof value>("city")).resolves.toEqual(value);
        expect(client.commandCount("GetItemCommand")).toBe(1);
        expect(client.commandCount("QueryCommand")).toBe(0);

        client.resetCommands();
        await expect(reader.get<typeof value>("city")).resolves.toEqual(value);
        expect(client.commands).toHaveLength(0);

        const checker = createCache(client);
        await expect(checker.has("city")).resolves.toBe(true);
        expect(client.commandCount("GetItemCommand")).toBe(1);
        expect(client.commandCount("QueryCommand")).toBe(0);
    });

    it("allows the default memory cache to be explicitly disabled", async () => {
        const client = new MemoryDynamoClient();
        const cache = new LambderDdbCache({
            tableName: "test-cache",
            namespace: "no-memory",
            client,
            memoryMaxBytes: 0,
        });
        const value = { city: "Ankara" };
        await cache.set("city", value);

        client.resetCommands();
        await expect(cache.get<typeof value>("city")).resolves.toEqual(value);
        expect(client.commandCount("GetItemCommand")).toBe(1);

        client.resetCommands();
        await expect(cache.get<typeof value>("city")).resolves.toEqual(value);
        expect(client.commandCount("GetItemCommand")).toBe(1);
    });

    it("chunks compressed values larger than 400 KiB into safe DynamoDB items", async () => {
        const client = new MemoryDynamoClient();
        const writer = createCache(client, 350 * 1024);
        const value = oversizedPayload();

        await writer.set("oversized", value);

        const stored = [...client.items.values()];
        const manifest = stored.find((item) => item.sk?.S === "meta");
        const chunks = stored.filter((item) => item.sk?.S?.startsWith("chunk#"));
        const compressedBytes = Number(manifest?.storedBytes?.N);
        expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeGreaterThan(1024 * 1024);
        expect(compressedBytes).toBeGreaterThan(400 * 1024);
        expect(compressedBytes).toBeLessThan(1024 * 1024);
        expect(manifest?.data).toBeUndefined();
        expect(Number(manifest?.chunkCount?.N)).toBe(chunks.length);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((item) => (item.data?.B?.byteLength ?? 0) <= 350 * 1024)).toBe(true);

        client.resetCommands();
        await expect(writer.get<typeof value>("oversized")).resolves.toEqual(value);
        expect(client.commands).toHaveLength(0);

        client.resetCommands();
        await expect(createCache(client, 350 * 1024).get<typeof value>("oversized")).resolves.toEqual(value);
        expect(client.commandCount("GetItemCommand")).toBe(1);
        expect(client.commandCount("QueryCommand")).toBe(1);
    });

    it("compresses, chunks, restores, checks, and deletes JSON values", async () => {
        const client = new MemoryDynamoClient();
        const writer = createCache(client);
        const value = largePayload();

        await writer.set("cities", value, { ttlSeconds: 60 });

        const stored = [...client.items.values()];
        const manifest = stored.find((item) => item.sk?.S === "meta");
        const chunks = stored.filter((item) => item.sk?.S?.startsWith("chunk#"));
        expect(manifest?.encoding?.S).toBe("br");
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((item) => (item.data?.B?.byteLength ?? 0) <= 512)).toBe(true);

        const reader = createCache(client);
        await expect(reader.get<typeof value>("cities")).resolves.toEqual(value);
        await expect(reader.has("cities")).resolves.toBe(true);
        await expect(writer.delete("cities")).resolves.toBe(true);
        await expect(writer.has("cities")).resolves.toBe(false);
    });

    it("compression: false stores values plain, chunked and verified the same way", async () => {
        const client = new MemoryDynamoClient();
        const writer = createCache(client, 512, { compression: false });
        const value = largePayload();
        const json = JSON.stringify(value);

        await writer.set("cities", value, { ttlSeconds: 60 });

        const stored = [...client.items.values()];
        const manifest = stored.find((item) => item.sk?.S === "meta");
        expect(manifest?.encoding?.S).toBe("identity");
        expect(Number(manifest?.storedBytes?.N)).toBe(Buffer.byteLength(json));
        expect(Number(manifest?.uncompressedBytes?.N)).toBe(Buffer.byteLength(json));
        const chunks = stored.filter((item) => item.sk?.S?.startsWith("chunk#"));
        expect(chunks.length).toBeGreaterThan(1);
        expect(Buffer.concat(chunks.map((item) => Buffer.from(item.data!.B!))).toString("utf8")).toBe(json);

        // Memory layer, then a fresh instance reading DynamoDB.
        await expect(writer.get<typeof value>("cities")).resolves.toEqual(value);
        await expect(createCache(client, 512, { compression: false }).get<typeof value>("cities")).resolves.toEqual(value);
    });

    it("minBytes stores small values plain and large ones compressed", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client, 512, { compression: { minBytes: 1024 } });
        const large = largePayload();

        await cache.set("small", { city: "Istanbul" });
        await cache.set("large", large);

        const manifests = [...client.items.values()].filter((item) => item.sk?.S === "meta");
        expect(manifests.map((item) => item.encoding?.S)).toEqual(["identity", "br"]);
        await expect(cache.get("small")).resolves.toEqual({ city: "Istanbul" });
        await expect(cache.get("large")).resolves.toEqual(large);
    });

    it("reads values written under the other compression setting", async () => {
        const client = new MemoryDynamoClient();
        const value = largePayload();
        await createCache(client, 512, { compression: false }).set("plain", value);
        await createCache(client, 512).set("brotli", value);

        // Fresh instances: the reads come from DynamoDB, not the memory layer.
        await expect(createCache(client, 512).get("plain")).resolves.toEqual(value);
        await expect(createCache(client, 512, { compression: false }).get("brotli")).resolves.toEqual(value);
    });

    it("ignores an identity manifest whose stored and uncompressed lengths differ", async () => {
        const client = new MemoryDynamoClient();
        await createCache(client, 512, { compression: false }).set("city", { city: "Istanbul" });
        const manifest = [...client.items.values()].find((item) => item.sk?.S === "meta")!;
        manifest.uncompressedBytes = { N: String(Number(manifest.storedBytes!.N) + 1) };

        await expect(createCache(client, 512, { compression: false }).get("city")).resolves.toBeUndefined();
    });

    it("caps batch writes at 25 items and retries only unprocessed chunks", async () => {
        const client = new MemoryDynamoClient();
        client.unprocessBatchAttempts = 1;
        const cache = createCache(client, 256);

        await cache.set("batched", largePayload());

        const chunkCount = [...client.items.values()].filter((item) =>
            item.sk?.S?.startsWith("chunk#"),
        ).length;
        expect(chunkCount).toBeGreaterThan(25);
        expect(client.batchSizes().every((size) => size > 0 && size <= 25)).toBe(true);
        expect(client.commandCount("BatchWriteItemCommand")).toBe(
            Math.ceil(chunkCount / 25) + 1,
        );
    });

    it("reassembles chunk queries across DynamoDB pagination", async () => {
        const client = new MemoryDynamoClient();
        const value = largePayload();
        await createCache(client, 256).set("paginated", value);
        const chunkCount = [...client.items.values()].filter((item) =>
            item.sk?.S?.startsWith("chunk#"),
        ).length;
        client.queryPageSize = 3;
        client.resetCommands();

        await expect(createCache(client, 256).get<typeof value>("paginated")).resolves.toEqual(value);
        expect(client.commandCount("GetItemCommand")).toBe(1);
        expect(client.commandCount("QueryCommand")).toBe(Math.ceil(chunkCount / 3));
    });

    it("rejects expired values even while DynamoDB TTL has not deleted them", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-02T12:00:00Z"));
        const client = new MemoryDynamoClient();
        const cache = createCache(client);

        await cache.set("short", { value: 1 }, { ttlSeconds: 2 });
        vi.advanceTimersByTime(3_000);

        await expect(cache.get("short")).resolves.toBeUndefined();
        await expect(cache.has("short")).resolves.toBe(false);
        expect(client.items.size).toBeGreaterThan(0);
    });

    it("invalidates a manifest when a stored chunk fails integrity checks", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        await createCache(client).set("corrupt", largePayload());
        client.corruptFirstChunk();

        await expect(createCache(client).get("corrupt")).resolves.toBeUndefined();
        expect([...client.items.values()].some((item) => item.sk?.S === "meta")).toBe(false);
        expect(warning).toHaveBeenCalledOnce();
    });

    it("does not publish a manifest when chunk persistence fails", async () => {
        const client = new MemoryDynamoClient();
        client.failNextBatch = true;

        await expect(createCache(client).set("failed", largePayload())).rejects.toThrow(
            "simulated batch failure",
        );
        expect([...client.items.values()].some((item) => item.sk?.S === "meta")).toBe(false);
    });

    it("deduplicates concurrent fills in one Lambda execution", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        let release: ((value: { ready: boolean }) => void) | undefined;
        const gate = new Promise<{ ready: boolean }>((resolve) => {
            release = resolve;
        });
        const factory = vi.fn(() => gate);

        const first = cache.getOrSet("shared", factory);
        await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
        const second = cache.getOrSet("shared", factory);
        release?.({ ready: true });

        await expect(Promise.all([first, second])).resolves.toEqual([
            { ready: true },
            { ready: true },
        ]);
        expect(factory).toHaveBeenCalledOnce();
    });

    it("fails open on cache reads without repeating the loader", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        client.failNextGet = true;
        const factory = vi.fn(async () => ({ ready: true }));

        await expect(createCache(client).getOrSet("read-failure", factory)).resolves.toEqual({
            ready: true,
        });
        expect(factory).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledOnce();
    });

    it("returns a completed loader value when cache publication fails", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        client.failNextBatch = true;
        const value = largePayload();
        const factory = vi.fn(async () => value);

        await expect(createCache(client).getOrSet("write-failure", factory)).resolves.toEqual(value);
        expect(factory).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledOnce();
    });

    it("propagates loader failures without retrying the loader", async () => {
        const client = new MemoryDynamoClient();
        const factory = vi.fn(async () => {
            throw new Error("loader failed");
        });

        await expect(createCache(client).getOrSet("loader-failure", factory)).rejects.toThrow(
            "loader failed",
        );
        expect(factory).toHaveBeenCalledOnce();
    });

    it("serves getOrSet hits without invoking the loader", async () => {
        const client = new MemoryDynamoClient();
        await createCache(client).set("warm", { ready: true });
        const factory = vi.fn(async () => ({ ready: false }));

        await expect(createCache(client).getOrSet("warm", factory)).resolves.toEqual({
            ready: true,
        });
        expect(factory).not.toHaveBeenCalled();
    });

    it("takes over an expired fill lease from a crashed process", async () => {
        const client = new MemoryDynamoClient();
        const pk = `CACHE#unit#${createHash("sha256").update("expired-lease").digest("hex")}`;
        client.items.set(`${pk}|lock`, {
            pk: { S: pk },
            sk: { S: "lock" },
            owner: { S: "crashed-process" },
            expiresAt: { N: String(Math.floor(Date.now() / 1000) - 10) },
        });
        const factory = vi.fn(async () => ({ ready: true }));

        await expect(createCache(client).getOrSet("expired-lease", factory)).resolves.toEqual({
            ready: true,
        });
        expect(factory).toHaveBeenCalledOnce();
        expect(client.items.has(`${pk}|lock`)).toBe(false);
        expect(client.items.get(`${pk}|meta`)).toBeDefined();
    });

    it("waits for a concurrent process's fill instead of running its own loader", async () => {
        const client = new MemoryDynamoClient();
        const pk = `CACHE#unit#${createHash("sha256").update("contended").digest("hex")}`;
        client.items.set(`${pk}|lock`, {
            pk: { S: pk },
            sk: { S: "lock" },
            owner: { S: "other-process" },
            expiresAt: { N: String(Math.floor(Date.now() / 1000) + 60) },
        });
        const value = { filled: "elsewhere" };
        const factory = vi.fn(async () => ({ filled: "locally" }));

        const waiting = createCache(client).getOrSet("contended", factory, {
            waitForFillMs: 3_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await createCache(client).set("contended", value);

        await expect(waiting).resolves.toEqual(value);
        expect(factory).not.toHaveBeenCalled();
    });

    it("fails open with the loader when a fill lease never frees", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        const pk = `CACHE#unit#${createHash("sha256").update("locked-out").digest("hex")}`;
        client.items.set(`${pk}|lock`, {
            pk: { S: pk },
            sk: { S: "lock" },
            owner: { S: "other-process" },
            expiresAt: { N: String(Math.floor(Date.now() / 1000) + 60) },
        });
        const factory = vi.fn(async () => ({ ready: true }));

        await expect(
            createCache(client).getOrSet("locked-out", factory, { waitForFillMs: 1 }),
        ).resolves.toEqual({ ready: true });
        expect(factory).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledOnce();
        expect(client.items.has(`${pk}|meta`)).toBe(false);
    });

    it("serves the newest version after overwriting a chunked value", async () => {
        const client = new MemoryDynamoClient();
        const writer = createCache(client);
        const first = { ...largePayload(), tag: "first" };
        const second = { ...largePayload(), tag: "second" };
        await writer.set("versioned", first);
        await writer.set("versioned", second);

        const versions = new Set(
            [...client.items.values()]
                .filter((item) => item.sk?.S?.startsWith("chunk#"))
                .map((item) => item.sk?.S?.split("#")[1]),
        );
        expect(versions.size).toBe(2);
        await expect(createCache(client).get<typeof second>("versioned")).resolves.toEqual(second);
    });

    it("invalidates a manifest whose inline data fails the checksum", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        await createCache(client).set("inline-corrupt", { city: "Izmir" });
        const meta = [...client.items.values()].find((item) => item.sk?.S === "meta");
        const data = Buffer.from(meta?.data?.B ?? []);
        if (data.length === 0) throw new Error("expected inline manifest data");
        data[0] = (data[0] ?? 0) ^ 0xff;
        meta!.data = { B: data };

        await expect(createCache(client).get("inline-corrupt")).resolves.toBeUndefined();
        expect([...client.items.values()].some((item) => item.sk?.S === "meta")).toBe(false);
        expect(warning).toHaveBeenCalledOnce();
    });

    it("gives up when batch writes stay throttled", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        const client = new MemoryDynamoClient();
        client.unprocessBatchAttempts = 100;
        let settled = false;
        const outcome = createCache(client, 256)
            .set("throttled", largePayload())
            .then(
                () => "resolved",
                (error: Error) => error.message,
            )
            .finally(() => {
                settled = true;
            });
        while (!settled) {
            await new Promise((resolve) => setImmediate(resolve));
            await vi.advanceTimersByTimeAsync(2_000);
        }
        await expect(outcome).resolves.toContain("remained throttled");
    });

    it("rejects invalid construction options", () => {
        const client = new MemoryDynamoClient();
        const base = { tableName: "test-cache", client };
        expect(() => new LambderDdbCache({ ...base, tableName: "  " })).toThrow();
        expect(() => new LambderDdbCache({ ...base, chunkBytes: 512 * 1024 })).toThrow();
        expect(() => new LambderDdbCache({ ...base, chunkBytes: 0 })).toThrow();
        expect(() => new LambderDdbCache({ ...base, compression: { quality: 12 } })).toThrow();
        expect(() => new LambderDdbCache({ ...base, compression: { quality: 1.5 } })).toThrow();
        expect(() => new LambderDdbCache({ ...base, compression: { minBytes: -1 } })).toThrow();
        expect(() => new LambderDdbCache({ ...base, namespace: "n".repeat(129) })).toThrow();
        expect(() => new LambderDdbCache({ ...base, defaultTtlSeconds: 0 })).toThrow();
        expect(() => new LambderDdbCache({ ...base, memoryMaxBytes: -1 })).toThrow();
    });

    it("rejects invalid keys and oversized or unserializable values", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        await expect(cache.get("  ")).rejects.toThrow("Cache key is required");
        await expect(cache.get("k".repeat(9_000))).rejects.toThrow("8192");
        await expect(cache.set("nothing", undefined)).rejects.toThrow("JSON-serializable");

        const bounded = new LambderDdbCache({
            tableName: "test-cache",
            client,
            maxValueBytes: 1024,
        });
        await expect(bounded.set("big", { data: "x".repeat(2_000) })).rejects.toThrow(
            "maxValueBytes",
        );
    });
});

describe("LambderDdbCache - grouped keys", () => {
    /** The sort keys of every stored item, for asserting the on-table layout. */
    const sortKeysOf = (client: MemoryDynamoClient): string[] =>
        [...client.items.values()].map((item) => item.sk?.S ?? "").sort();

    it("keeps entries of one partition together and reads each one back", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);

        await cache.set({ pk: "division:ist-34", sk: "1700:1800" }, { heroes: 3 });
        await cache.set({ pk: "division:ist-34", sk: "1700:1900" }, { heroes: 7 });
        await cache.set({ pk: "division:ist-35", sk: "1700:1800" }, { heroes: 1 });

        // The two windows of ist-34 share a partition; ist-35 has its own.
        const partitions = new Set([...client.items.values()].map((item) => item.pk?.S));
        expect(partitions.size).toBe(2);
        expect(sortKeysOf(client)).toEqual(["sk#1700:1800#meta", "sk#1700:1800#meta", "sk#1700:1900#meta"]);

        const reader = createCache(client);
        await expect(reader.get({ pk: "division:ist-34", sk: "1700:1800" })).resolves.toEqual({ heroes: 3 });
        await expect(reader.get({ pk: "division:ist-34", sk: "1700:1900" })).resolves.toEqual({ heroes: 7 });
        await expect(reader.get({ pk: "division:ist-35", sk: "1700:1800" })).resolves.toEqual({ heroes: 1 });
        await expect(reader.has({ pk: "division:ist-34", sk: "1700:2000" })).resolves.toBe(false);
    });

    it("reads a grouped entry in one request, as an ungrouped one does", async () => {
        const client = new MemoryDynamoClient();
        await createCache(client).set({ pk: "division:ist-34", sk: "1700:1800" }, { heroes: 3 });

        client.resetCommands();
        await createCache(client).get({ pk: "division:ist-34", sk: "1700:1800" });
        expect(client.commandCount("GetItemCommand")).toBe(1);
        expect(client.commandCount("QueryCommand")).toBe(0);
    });

    it("stores a plain-string key exactly as before, beside grouped entries in the same partition", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);

        await cache.set("division:ist-34", { summary: true });
        await cache.set({ pk: "division:ist-34", sk: "1700:1800" }, { heroes: 3 });

        // The legacy layout is untouched, so a live table needs no migration.
        expect(sortKeysOf(client)).toEqual(["meta", "sk#1700:1800#meta"]);

        // Deleting the plain entry leaves the grouped one alone, and vice versa.
        await expect(cache.delete("division:ist-34")).resolves.toBe(true);
        expect(sortKeysOf(client)).toEqual(["sk#1700:1800#meta"]);
        await expect(createCache(client).get({ pk: "division:ist-34", sk: "1700:1800" })).resolves.toEqual({ heroes: 3 });

        await cache.set("division:ist-34", { summary: true });
        await expect(cache.delete({ pk: "division:ist-34", sk: "1700:1800" })).resolves.toBe(true);
        expect(sortKeysOf(client)).toEqual(["meta"]);
    });

    it("chunks a grouped value under its own sort key and reassembles it", async () => {
        const client = new MemoryDynamoClient();
        const key = { pk: "division:ist-34", sk: "1700:1900" };
        const value = largePayload();

        await createCache(client, 256).set(key, value);

        const chunks = [...client.items.values()].filter((item) => item.sk?.S?.includes("#chunk#"));
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) expect(chunk.sk?.S?.startsWith("sk#1700:1900#chunk#")).toBe(true);

        await expect(createCache(client, 256).get(key)).resolves.toEqual(value);
    });

    it("escapes # and ~ in a sort key instead of refusing them", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);

        await cache.set({ pk: "reports", sk: "a#b" }, { which: "hash" });
        await cache.set({ pk: "reports", sk: "a~b" }, { which: "tilde" });
        await cache.set({ pk: "reports", sk: "a~1b" }, { which: "escape-lookalike" });

        // ~ escapes as ~0 and # as ~1, so the three stay distinct on the table.
        expect(sortKeysOf(client)).toEqual(["sk#a~01b#meta", "sk#a~0b#meta", "sk#a~1b#meta"]);

        const reader = createCache(client);
        await expect(reader.get({ pk: "reports", sk: "a#b" })).resolves.toEqual({ which: "hash" });
        await expect(reader.get({ pk: "reports", sk: "a~b" })).resolves.toEqual({ which: "tilde" });
        await expect(reader.get({ pk: "reports", sk: "a~1b" })).resolves.toEqual({ which: "escape-lookalike" });
        // Escaped keys come back exactly as written, but they range in ENCODED
        // order: a#b sorts last here because its escape starts with ~1.
        await expect(reader.listSortKeys("reports")).resolves.toEqual(["a~1b", "a~b", "a#b"]);
    });

    it("a sort key ending in the delimiter cannot reach another entry's items", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);

        await cache.set({ pk: "reports", sk: "a#" }, { which: "trailing" });
        await cache.set({ pk: "reports", sk: "a##" }, { which: "double" });

        await expect(cache.delete({ pk: "reports", sk: "a#" })).resolves.toBe(true);
        await expect(createCache(client).get({ pk: "reports", sk: "a##" })).resolves.toEqual({ which: "double" });
    });

    it("deletes a whole partition without knowing its sort keys", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client, 256);

        await cache.set({ pk: "division:ist-34", sk: "1700:1800" }, { heroes: 3 });
        await cache.set({ pk: "division:ist-34", sk: "1700:1900" }, largePayload());  // chunked
        await cache.set("division:ist-34", { summary: true });
        await cache.set({ pk: "division:ist-35", sk: "1700:1800" }, { heroes: 1 });

        await expect(cache.deletePartition("division:ist-34")).resolves.toBe(3);

        await expect(cache.get({ pk: "division:ist-34", sk: "1700:1800" })).resolves.toBeUndefined();
        await expect(cache.get({ pk: "division:ist-34", sk: "1700:1900" })).resolves.toBeUndefined();
        await expect(cache.get("division:ist-34")).resolves.toBeUndefined();
        // Chunks went with it, and the neighbouring partition is untouched.
        expect([...client.items.values()].every((item) => item.sk?.S === "sk#1700:1800#meta")).toBe(true);
        await expect(cache.get({ pk: "division:ist-35", sk: "1700:1800" })).resolves.toEqual({ heroes: 1 });
    });

    it("deletePartition drops the in-memory copies of that partition only", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        await cache.set({ pk: "division:ist-34", sk: "1700:1800" }, { heroes: 3 });
        await cache.set({ pk: "division:ist-35", sk: "1700:1800" }, { heroes: 1 });

        await cache.deletePartition("division:ist-34");

        client.resetCommands();
        // Gone, not served from memory...
        await expect(cache.get({ pk: "division:ist-34", sk: "1700:1800" })).resolves.toBeUndefined();
        expect(client.commandCount("GetItemCommand")).toBe(1);
        // ...while the other partition still answers without touching DynamoDB.
        client.resetCommands();
        await expect(cache.get({ pk: "division:ist-35", sk: "1700:1800" })).resolves.toEqual({ heroes: 1 });
        expect(client.commands).toHaveLength(0);
    });

    it("lists live sort keys, filtered by raw prefix and limit", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);

        await cache.set({ pk: "division:ist-34", sk: "1700:1800" }, { heroes: 1 });
        await cache.set({ pk: "division:ist-34", sk: "1700:1900" }, { heroes: 2 });
        await cache.set({ pk: "division:ist-34", sk: "1800:1900" }, { heroes: 3 }, { ttlSeconds: 60 });
        await cache.set("division:ist-34", { summary: true });

        // A plain-string entry has no sort key, so it never appears.
        await expect(cache.listSortKeys("division:ist-34")).resolves.toEqual(["1700:1800", "1700:1900", "1800:1900"]);
        await expect(cache.listSortKeys("division:ist-34", { prefix: "1700:" })).resolves.toEqual(["1700:1800", "1700:1900"]);
        await expect(cache.listSortKeys("division:ist-34", { limit: 2 })).resolves.toEqual(["1700:1800", "1700:1900"]);
        await expect(cache.listSortKeys("division:ist-35")).resolves.toEqual([]);

        // Expired entries drop out even before DynamoDB's TTL sweep removes them.
        vi.setSystemTime(Date.now() + 120_000);
        await expect(cache.listSortKeys("division:ist-34")).resolves.toEqual(["1700:1800", "1700:1900"]);
    });

    it("single-flights and leases per entry, not per partition", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        const calls: string[] = [];
        const loader = (name: string) => async () => {
            calls.push(name);
            return { name };
        };

        const [first, second, third] = await Promise.all([
            cache.getOrSet({ pk: "division:ist-34", sk: "1700:1800" }, loader("a")),
            cache.getOrSet({ pk: "division:ist-34", sk: "1700:1800" }, loader("a-again")),
            cache.getOrSet({ pk: "division:ist-34", sk: "1700:1900" }, loader("b")),
        ]);

        // Same entry deduplicates; a sibling entry in the same partition is not blocked by it.
        expect(calls).toEqual(["a", "b"]);
        expect(first).toEqual({ name: "a" });
        expect(second).toEqual({ name: "a" });
        expect(third).toEqual({ name: "b" });

        const locks = [...client.items.values()].filter((item) => item.sk?.S?.endsWith("#lock"));
        expect(locks).toHaveLength(0);  // both leases released
    });

    it("keeps adversarial sort keys distinct, addressable and independently deletable", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        // Every string up to length 3 over the characters the escape scheme
        // has to survive: the delimiter, the escape character, and the digits
        // its escape sequences use.
        const keys: string[] = [];
        const build = (prefix: string, depth: number) => {
            if (prefix) keys.push(prefix);
            if (depth === 0) return;
            for (const char of ["a", "#", "~", "0", "1"]) build(prefix + char, depth - 1);
        };
        build("", 3);

        for (const [index, sk] of keys.entries()) await cache.set({ pk: "adversarial", sk }, { index });

        // Distinct on the table, and each one reads back its own value.
        expect(new Set([...client.items.values()].map((item) => item.sk?.S)).size).toBe(keys.length);
        const reader = createCache(client);
        for (const [index, sk] of keys.entries()) {
            await expect(reader.get({ pk: "adversarial", sk })).resolves.toEqual({ index });
        }
        await expect(cache.listSortKeys("adversarial")).resolves.toHaveLength(keys.length);

        // Deleting one entry never reaches a neighbour, however the two escape.
        for (const [index, sk] of keys.entries()) {
            await expect(cache.delete({ pk: "adversarial", sk })).resolves.toBe(true);
            await expect(cache.listSortKeys("adversarial")).resolves.toHaveLength(keys.length - index - 1);
        }
    });

    it("rejects an empty or oversized sort key", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        await expect(cache.get({ pk: "reports", sk: "  " })).rejects.toThrow("Cache sort key is required");
        await expect(cache.get({ pk: "  ", sk: "daily" })).rejects.toThrow("Cache key is required");
        await expect(cache.get({ pk: "reports", sk: "s".repeat(901) })).rejects.toThrow("900");
        // Escaping counts toward the limit: 500 hashes are 1000 bytes encoded.
        await expect(cache.get({ pk: "reports", sk: "#".repeat(500) })).rejects.toThrow("900");
    });
});

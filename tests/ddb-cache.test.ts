/**
 * The DynamoDB cache against an in-memory table: the manifest-and-chunks
 * layout, the in-memory layer in front of it, the fill lease, and the escaped
 * sort keys that let one partition hold a group of entries.
 *
 * The rules worth stating twice are about what a read does with what it finds.
 * An entry this read can prove wrong (chunks that do not add up, bytes that
 * fail the checksum) is dropped so the next reader refills it; a table that
 * answers badly is not, because deleting a healthy entry over one throttle
 * orphans its chunks and sends every later reader to the origin. Expiry is
 * driven through the store's own injected clock rather than the world's, so a
 * TTL boundary is crossed without moving system time.
 */

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
import { LambderDdbCache, type LambderDdbCacheGetOrSetOptions } from "../src/stores/LambderDdbCache.js";
import { LambderMemoryCache } from "../src/stores/LambderMemoryCache.js";
import type { LambderCache } from "../src/shared/contracts/LambderCache.js";

type Item = Record<string, AttributeValue>;

const conditionalFailure = (): Error =>
    Object.assign(new Error("conditional request failed"), {
        name: "ConditionalCheckFailedException",
    });

/** The refusal DynamoDB answers a conditional write with, carrying the item when the write asked for it. */
const refusal = (input: { ReturnValuesOnConditionCheckFailure?: string }, existing: Item | undefined): Error =>
    Object.assign(conditionalFailure(), input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" && existing ? { Item: existing } : {});

/**
 * A ConditionExpression judged the way DynamoDB judges it, for the grammar
 * the cache writes: attribute_exists, attribute_not_exists, =, < and <=,
 * joined by AND and OR, with parentheses. A comparison with a missing
 * attribute is false, as it is on the table.
 */
const conditionHolds = (
    input: { ConditionExpression?: string, ExpressionAttributeNames?: Record<string, string>, ExpressionAttributeValues?: Record<string, AttributeValue> },
    existing: Item | undefined,
): boolean => {
    if (!input.ConditionExpression) return true;
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const attributeOf = (path: string) => existing?.[names[path] ?? path];
    const scalarOf = (value: AttributeValue | undefined) => value?.N !== undefined ? Number(value.N) : value?.S;
    const tokens = input.ConditionExpression.match(/\(|\)|<=|<|=|[#:]?\w+/g) ?? [];
    let position = 0;
    const next = () => tokens[position++]!;

    const disjunction = (): boolean => {
        let holds = conjunction();
        while (tokens[position] === "OR") { next(); const right = conjunction(); holds = holds || right; }
        return holds;
    };
    const conjunction = (): boolean => {
        let holds = term();
        while (tokens[position] === "AND") { next(); const right = term(); holds = holds && right; }
        return holds;
    };
    const term = (): boolean => {
        const token = next();
        if (token === "(") { const holds = disjunction(); next(); return holds; }
        if (token === "attribute_exists" || token === "attribute_not_exists") {
            next();
            const present = attributeOf(next()) !== undefined;
            next();
            return token === "attribute_exists" ? present : !present;
        }
        const operator = next();
        const left = scalarOf(attributeOf(token));
        const right = scalarOf(values[next()]);
        if (left === undefined || right === undefined || typeof left !== typeof right) return false;
        if (operator === "=") return left === right;
        if (operator === "<") return left < right;
        if (operator === "<=") return left <= right;
        throw new Error(`Unsupported operator ${operator} in ${input.ConditionExpression}`);
    };
    return disjunction();
};

class MemoryDynamoClient extends DynamoDBClient {
    readonly items = new Map<string, Item>();
    readonly commands: any[] = [];
    failNextBatch = false;
    failNextGet = false;
    failNextQuery = false;
    unprocessBatchAttempts = 0;
    queryPageSize = Number.POSITIVE_INFINITY;
    /** A replica that has the manifest but not yet its chunks: eventually consistent queries find none. */
    chunksLagOnReplica = false;
    /**
     * The table as a lagging replica holds it, while replicaFallsBehind() is
     * in force: eventually consistent reads (GetItem and Query) answer from
     * it, while consistent reads and every write, conditional ones included,
     * go to the leader (`items`), as they do on DynamoDB.
     */
    private replicaItems: Map<string, Item> | undefined;

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
            return { Item: this.readableItems(command.input.ConsistentRead).get(this.keyOf(command.input.Key)) };
        }

        if (command instanceof PutItemCommand) {
            const item = command.input.Item;
            if (!item) throw new Error("PutItem is missing Item");
            const key = this.keyOf(item);
            const existing = this.items.get(key);
            if (!conditionHolds(command.input, existing)) throw refusal(command.input, existing);
            this.items.set(key, item);
            return command.input.ReturnValues === "ALL_OLD" && existing ? { Attributes: existing } : {};
        }

        if (command instanceof DeleteItemCommand) {
            const key = this.keyOf(command.input.Key);
            const existing = this.items.get(key);
            if (!conditionHolds(command.input, existing)) throw refusal(command.input, existing);
            this.items.delete(key);
            return command.input.ReturnValues === "ALL_OLD" && existing ? { Attributes: existing } : {};
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
            if (this.failNextQuery) {
                this.failNextQuery = false;
                // What a throttle, a partition split or a socket timeout looks
                // like from here: not an answer about the entry at all.
                throw new Error("simulated query failure");
            }
            const pk = command.input.ExpressionAttributeValues?.[":pk"]?.S;
            const prefix = command.input.ExpressionAttributeValues?.[":prefix"]?.S;
            const lagging = this.chunksLagOnReplica && !command.input.ConsistentRead;
            const matching = [...this.readableItems(command.input.ConsistentRead).values()]
                .filter((item) => item.pk?.S === pk && (!prefix || item.sk?.S?.startsWith(prefix)))
                .filter((item) => !(lagging && item.sk?.S?.includes("chunk#")))
                // By UTF-8 bytes, as DynamoDB orders a string sort key.
                .sort((left, right) => Buffer.compare(Buffer.from(left.sk?.S ?? ""), Buffer.from(right.sk?.S ?? "")));
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

    /**
     * The replica stops applying writes here: until replicaCatchesUp(), an
     * eventually consistent read sees the table as it is now, and nothing
     * written after.
     */
    replicaFallsBehind(): void {
        this.replicaItems = new Map(this.items);
    }

    replicaCatchesUp(): void {
        this.replicaItems = undefined;
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

    private readableItems(consistent: boolean | undefined): Map<string, Item> {
        return consistent || !this.replicaItems ? this.items : this.replicaItems;
    }

    private keyOf(item: Item | undefined): string {
        if (!item?.pk?.S || !item.sk?.S) throw new Error("Missing DynamoDB key");
        return `${item.pk.S}|${item.sk.S}`;
    }
}

const createCache = (
    client: MemoryDynamoClient,
    chunkBytes = 512,
    extra: Pick<ConstructorParameters<typeof LambderDdbCache>[0], "compression" | "now"> = {},
): LambderDdbCache =>
    new LambderDdbCache({
        tableName: "test-cache",
        namespace: "unit",
        client,
        chunkBytes,
        memoryMaxBytes: 1024 * 1024,
        ...extra,
    });

/** The item key of a plain-string entry's manifest in the "unit" namespace, as the client's map holds it. */
const manifestKeyOf = (key: string): string =>
    `CACHE#unit#${createHash("sha256").update(key).digest("hex")}|meta`;

/**
 * Another container's fill lease on a plain-string entry, as the store
 * writes one: on the manifest item, with no value, expiring at `expiresAt`
 * (the first second it no longer holds).
 */
const seedLease = (client: MemoryDynamoClient, key: string, owner: string, expiresAt: number): void => {
    const [pk] = manifestKeyOf(key).split("|");
    client.items.set(manifestKeyOf(key), {
        pk: { S: pk! },
        sk: { S: "meta" },
        leaseOwner: { S: owner },
        expiresAt: { N: String(expiresAt) },
    });
};

/** A loader that stays out until the test lets it answer, and says when it was called. */
const gatedLoader = <T>(value: T) => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const loader = vi.fn(async () => { await gate; return value; });
    return { loader, open: () => open() };
};

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

    it("keeps each remembered value in a buffer of exactly its own size, so the memory budget counts what is held", async () => {
        // A compressed value is a view onto zlib's 16 KB output chunk; kept
        // as it is, a few dozen counted bytes would pin the whole chunk.
        const cache = createCache(new MemoryDynamoClient());
        await cache.set("compressible", { text: "lambder ".repeat(2_000) });

        const memory = (cache as unknown as { memory: Map<string, { stored: Buffer }> & { values(): IterableIterator<{ stored: Buffer }> } }).memory;
        const [entry] = [...memory.values()];
        expect(entry?.stored.byteLength).toBeLessThan(1024);
        expect(entry?.stored.buffer.byteLength).toBe(entry?.stored.byteLength);
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
        let clockMillis = Date.UTC(2026, 7, 2, 12, 0, 0);
        const client = new MemoryDynamoClient();
        const cache = createCache(client, 512, { now: () => clockMillis });

        await cache.set("short", { value: 1 }, { ttlSeconds: 2 });
        clockMillis += 3_000;

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

    it("keeps the manifest when the chunk read fails in transit, since a throttle is not corruption", async () => {
        // A throttled Query is not corruption: deleting the manifest over it
        // would orphan its chunks until their TTL and send every later reader
        // to the origin. Only what this read can prove wrong is dropped.
        const client = new MemoryDynamoClient();
        const value = largePayload();
        await createCache(client).set("busy", value);
        client.failNextQuery = true;

        const reader = createCache(client);
        await expect(reader.get("busy")).rejects.toThrow("simulated query failure");

        expect([...client.items.values()].some((item) => item.sk?.S === "meta")).toBe(true);
        // And once DynamoDB answers again, the entry is still the entry.
        await expect(reader.get<typeof value>("busy")).resolves.toEqual(value);
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

    it("ends on the value the table holds when two writes of one key overlap in one process", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        await cache.set("overlap", largePayload());
        // The first write's cleanup of the chunked value it replaced is slow.
        const send = client.send.bind(client);
        vi.spyOn(client, "send").mockImplementation(async (command: any) => {
            const requests = Object.values(command.input?.RequestItems ?? {}).flat() as { DeleteRequest?: unknown }[];
            if (command instanceof BatchWriteItemCommand && requests.some((request) => request.DeleteRequest)) {
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
            return await send(command);
        });

        await Promise.all([cache.set("overlap", { tag: "A" }), cache.set("overlap", { tag: "B" })]);

        // Whichever manifest landed last is what the table holds, and what
        // the writing container's memory layer has to serve.
        const inTable = await createCache(client).get("overlap");
        expect([{ tag: "A" }, { tag: "B" }]).toContainEqual(inTable);
        await expect(cache.get("overlap")).resolves.toEqual(inTable);
    });

    it("keeps no memory copy of a write the table applied first when overlapping writes answer in the other order", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        const send = client.send.bind(client);
        let firstApplied = false;
        let answerFirst: () => void = () => undefined;
        const firstAnswer = new Promise<void>((resolve) => { answerFirst = resolve; });
        vi.spyOn(client, "send").mockImplementation(async (command: any) => {
            const answer = await send(command);
            if (command instanceof PutItemCommand) {
                // The write the table applies first answers last.
                if (!firstApplied) { firstApplied = true; await firstAnswer; }
                else setTimeout(answerFirst, 20);
            }
            return answer;
        });

        await Promise.all([cache.set("overlap", { tag: "A" }), cache.set("overlap", { tag: "B" })]);

        const inTable = await createCache(client).get("overlap");
        await expect(cache.get("overlap")).resolves.toEqual(inTable);
    });

    it("does not put a value back in memory when its read answers after a delete in the same instance", async () => {
        // Regression: the read kept what it found once its reply arrived, and
        // the instance served the deleted value from memory until its TTL.
        const client = new MemoryDynamoClient();
        await createCache(client).set("raced", { tag: "old" });
        const cache = createCache(client);
        const send = client.send.bind(client);
        let readHeld = false;
        let answerRead: () => void = () => undefined;
        const readAnswer = new Promise<void>((resolve) => { answerRead = resolve; });
        vi.spyOn(client, "send").mockImplementation(async (command: any) => {
            const answer = await send(command);
            // The first read finds the entry, and its reply is held up in transit.
            if (command instanceof GetItemCommand && !readHeld) { readHeld = true; await readAnswer; }
            return answer;
        });

        const read = cache.get("raced");
        await vi.waitFor(() => expect(readHeld).toBe(true));
        await expect(cache.delete("raced")).resolves.toBe(true);
        answerRead();

        await expect(read).resolves.toEqual({ tag: "old" });
        await expect(cache.get("raced")).resolves.toBeUndefined();
    });

    it("keeps every one of several parallel fills in memory, since a write of one key never costs another its copy", async () => {
        // Regression: any finished write kept every other key's read or write
        // in flight from remembering what it got, so of five parallel fills
        // on a cold container one stayed in memory.
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        const keys = ["a", "b", "c", "d", "e"];
        const send = client.send.bind(client);
        vi.spyOn(client, "send").mockImplementation(async (command: any) => {
            // Every table call takes a moment, as a real one does, so the
            // five fills are in flight together.
            await new Promise((resolve) => setTimeout(resolve, 2));
            return await send(command);
        });

        await Promise.all(keys.map((key) => cache.getOrSet(key, async () => ({ key }))));

        client.resetCommands();
        for (const key of keys) await expect(cache.get(key)).resolves.toEqual({ key });
        expect(client.commands).toHaveLength(0);
    });

    it("answers false from delete when all that is left of the key is orphan chunks or a 7.x lock item, and removes the chunks", async () => {
        const client = new MemoryDynamoClient();
        const [pk] = manifestKeyOf("abandoned").split("|");
        const expiresAt = { N: String(Math.floor(Date.now() / 1000) + 60) };
        // A write that failed between its chunks and its manifest, and a
        // fill lease as 7.x kept it, beside the manifest item.
        client.items.set(`${pk}|chunk#m8x2k1-lost#000000`, { pk: { S: pk! }, sk: { S: "chunk#m8x2k1-lost#000000" }, data: { B: Buffer.from("x") }, expiresAt });
        client.items.set(`${pk}|lock`, { pk: { S: pk! }, sk: { S: "lock" }, owner: { S: "7.x" }, expiresAt });

        await expect(createCache(client).delete("abandoned")).resolves.toBe(false);
        expect([...client.items.values()].some((item) => item.sk?.S?.startsWith("chunk#"))).toBe(false);
    });

    it("hands a failed-open value back as the JSON a hit would, a Date as its string", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        client.failNextGet = true;
        const at = new Date(0);

        const value = await createCache(client).getOrSet("fail-open-shape", async () => ({ at, gone: undefined }));
        expect(value).toEqual({ at: at.toISOString() });
        expect(Object.keys(value)).toEqual(["at"]);
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
        seedLease(client, "expired-lease", "crashed-process", Math.floor(Date.now() / 1000) - 10);
        const factory = vi.fn(async () => ({ ready: true }));

        await expect(createCache(client).getOrSet("expired-lease", factory)).resolves.toEqual({
            ready: true,
        });
        expect(factory).toHaveBeenCalledOnce();
        // The fill published over the lapsed lease: a value, and no lease left.
        const manifest = client.items.get(manifestKeyOf("expired-lease"));
        expect(manifest?.version?.S).toBeDefined();
        expect(manifest?.leaseOwner).toBeUndefined();
    });

    it("waits for a concurrent process's fill instead of running its own loader", async () => {
        const client = new MemoryDynamoClient();
        seedLease(client, "contended", "other-process", Math.floor(Date.now() / 1000) + 60);
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
        seedLease(client, "locked-out", "other-process", Math.floor(Date.now() / 1000) + 60);
        const factory = vi.fn(async () => ({ ready: true }));

        await expect(
            createCache(client).getOrSet("locked-out", factory, { waitForFillMs: 1 }),
        ).resolves.toEqual({ ready: true });
        expect(factory).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledOnce();
        // Still the holder's lease, with no value published under it.
        const manifest = client.items.get(manifestKeyOf("locked-out"));
        expect(manifest?.leaseOwner?.S).toBe("other-process");
        expect(manifest?.version).toBeUndefined();
    });

    it("serves the newest version after overwriting a chunked value, and deletes the old version's chunks", async () => {
        const client = new MemoryDynamoClient();
        const writer = createCache(client);
        const first = { ...largePayload(), tag: "first" };
        const second = { ...largePayload(), tag: "second" };
        await writer.set("versioned", first);
        await writer.set("versioned", second);

        const chunkVersions = () => new Set(
            [...client.items.values()]
                .filter((item) => item.sk?.S?.startsWith("chunk#"))
                .map((item) => item.sk?.S?.split("#")[1]),
        );
        const meta = [...client.items.values()].find((item) => item.sk?.S === "meta");
        expect(chunkVersions()).toEqual(new Set([meta?.version?.S]));
        await expect(createCache(client).get<typeof second>("versioned")).resolves.toEqual(second);

        // An inline value replacing a chunked one leaves no chunks at all.
        await writer.set("versioned", { tag: "small" });
        expect(chunkVersions().size).toBe(0);
    });

    it("keeps the stored value when deleting the replaced version's chunks fails", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        const writer = createCache(client);
        await writer.set("versioned", { ...largePayload(), tag: "first" });
        const second = { tag: "second" };
        const send = client.send.bind(client);
        vi.spyOn(client, "send").mockImplementation(async (command: any) => {
            if (command instanceof BatchWriteItemCommand && command.input.RequestItems?.["test-cache"]?.[0]?.DeleteRequest) {
                throw new Error("simulated batch failure");
            }
            return await send(command);
        });

        await expect(writer.set("versioned", second)).resolves.toBeUndefined();
        expect(warning).toHaveBeenCalledOnce();
        await expect(createCache(client).get<typeof second>("versioned")).resolves.toEqual(second);
    });

    it("rereads consistently before calling an entry corrupt, so replica lag does not delete a fresh value", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        const value = largePayload();
        await createCache(client).set("fresh", value);
        client.chunksLagOnReplica = true;

        await expect(createCache(client).get<typeof value>("fresh")).resolves.toEqual(value);
        expect([...client.items.values()].some((item) => item.sk?.S === "meta")).toBe(true);
        expect(warning).not.toHaveBeenCalled();
    });

    it("serves the newer value to a reader whose manifest was replaced while it read", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        const writer = createCache(client);
        await writer.set("moving", { ...largePayload(), tag: "old" });
        const newer = { ...largePayload(), tag: "new" };
        const send = client.send.bind(client);
        let replaced = false;
        vi.spyOn(client, "send").mockImplementation(async (command: any) => {
            // The overwrite lands between this reader's manifest read and its chunk query.
            if (command instanceof QueryCommand && !replaced) {
                replaced = true;
                await writer.set("moving", newer);
            }
            return await send(command);
        });

        await expect(createCache(client).get<typeof newer>("moving")).resolves.toEqual(newer);
        expect(warning).not.toHaveBeenCalled();
    });

    it("waits as long as the holder's lease by default before running its own loader", async () => {
        vi.useFakeTimers();
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        seedLease(client, "slow", "other-process", Math.floor(Date.now() / 1000) + 60);
        const factory = vi.fn(async () => ({ filled: "locally" }));
        const waiting = createCache(client).getOrSet("slow", factory, { leaseSeconds: 8 });

        // Six seconds in, inside the 8 s lease: the holder may still be loading.
        await vi.advanceTimersByTimeAsync(6_000);
        expect(factory).not.toHaveBeenCalled();
        await createCache(client).set("slow", { filled: "elsewhere" });
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(waiting).resolves.toEqual({ filled: "elsewhere" });
        expect(factory).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it("is still waiting when a crashed holder's lease frees, and takes it over", async () => {
        // A lease expires in whole seconds, so it frees up to a second after
        // it runs out: from the start of a second, the latest case.
        vi.useFakeTimers();
        vi.setSystemTime(Math.ceil(Date.now() / 1000) * 1000);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        // A two-second lease taken this second by a holder that then crashed.
        seedLease(client, "crashed", "crashed-process", Math.floor(Date.now() / 1000) + 2 + 1);
        const factory = vi.fn(async () => ({ filled: "here" }));
        const waiting = createCache(client).getOrSet("crashed", factory, { leaseSeconds: 2 });

        await vi.advanceTimersByTimeAsync(4_000);

        await expect(waiting).resolves.toEqual({ filled: "here" });
        expect(factory).toHaveBeenCalledOnce();
        expect(error).not.toHaveBeenCalled();
        expect(client.items.get(manifestKeyOf("crashed"))?.version?.S).toBeDefined();
    });

    it("keeps a fill's lease on the entry's manifest item, a miss to every read, expiring for the TTL sweep", async () => {
        const client = new MemoryDynamoClient();
        const filling = createCache(client);
        const reader = createCache(client);
        const key = { pk: "store:nyc-01", sk: "1700:1800" };
        const { loader, open } = gatedLoader({ heroes: 3 });

        const takenBy = Math.floor(Date.now() / 1000);
        const fill = filling.getOrSet(key, loader, { leaseSeconds: 20 });
        await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());

        const [lease, ...others] = [...client.items.values()];
        expect(others).toHaveLength(0);
        expect(lease?.sk?.S).toBe("sk#1700:1800#meta");
        expect(lease?.leaseOwner?.S).toBeDefined();
        expect(lease?.version).toBeUndefined();
        // The first second the lease no longer holds, which is also when the
        // table's TTL may take an abandoned one away.
        expect(Number(lease?.expiresAt?.N)).toBeGreaterThanOrEqual(takenBy + 21);
        expect(Number(lease?.expiresAt?.N)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 21);
        await expect(reader.get(key)).resolves.toBeUndefined();
        await expect(reader.has(key)).resolves.toBe(false);
        await expect(reader.listSortKeys("store:nyc-01")).resolves.toEqual([]);

        // A lease is no entry to count, and dropping the partition drops it,
        // so the fill that started before stores nothing.
        await expect(reader.deletePartition("store:nyc-01")).resolves.toBe(0);
        open();
        await expect(fill).resolves.toEqual({ heroes: 3 });
        expect(client.items.size).toBe(0);
    });

    it("refuses a fill whose lease a set and a delete replaced while it loaded, and deletes the chunks it wrote", async () => {
        // Regression: the fill stored "old" after the invalidation, and every
        // container served it for the entry's TTL.
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        const filling = createCache(client);
        const writer = createCache(client);
        const stale = { ...largePayload(), tag: "old" };
        const { loader, open } = gatedLoader(stale);

        const fill = filling.getOrSet("invalidated", loader);
        await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
        // Another container records a change and invalidates the entry while
        // the loader, which read its source before the change, is still busy.
        await writer.set("invalidated", { tag: "new" });
        await writer.delete("invalidated");
        open();

        await expect(fill).resolves.toEqual(stale);
        expect(error).not.toHaveBeenCalled();
        expect(client.items.size).toBe(0);
        await expect(filling.get("invalidated")).resolves.toBeUndefined();
        await expect(createCache(client).get("invalidated")).resolves.toBeUndefined();
    });

    it("tells a holder whose loader ran past the lease that its value was not stored", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        let clockMillis = Date.UTC(2026, 7, 2, 12, 0, 0);
        const client = new MemoryDynamoClient();
        const first = createCache(client, 512, { now: () => clockMillis });
        const second = createCache(client, 512, { now: () => clockMillis });
        const slow = gatedLoader({ tag: "first" });
        const next = gatedLoader({ tag: "second" });

        const firstFill = first.getOrSet("lapsed", slow.loader, { leaseSeconds: 1 });
        await vi.waitFor(() => expect(slow.loader).toHaveBeenCalledOnce());
        // The lease runs out with the loader still busy; a waiter takes it
        // over and is loading itself when the first holder's value arrives.
        clockMillis += 5_000;
        const secondFill = second.getOrSet("lapsed", next.loader, { leaseSeconds: 1 });
        await vi.waitFor(() => expect(next.loader).toHaveBeenCalledOnce());
        slow.open();

        await expect(firstFill).resolves.toEqual({ tag: "first" });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("ran past its lease"));
        next.open();
        await expect(secondFill).resolves.toEqual({ tag: "second" });
        await expect(createCache(client).get("lapsed")).resolves.toEqual({ tag: "second" });
        warn.mockRestore();
    });

    it("refuses the first holder's publish once a waiter took its lapsed lease over", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        let clockMillis = Date.UTC(2026, 7, 2, 12, 0, 0);
        const client = new MemoryDynamoClient();
        const first = createCache(client, 512, { now: () => clockMillis });
        const second = createCache(client, 512, { now: () => clockMillis });
        const late = { ...largePayload(), tag: "first" };
        const { loader, open } = gatedLoader(late);

        const firstFill = first.getOrSet("taken-over", loader, { leaseSeconds: 1 });
        await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
        // The first holder's lease runs out while its loader is still busy,
        // and another container takes the lease over and fills the entry.
        clockMillis += 5_000;
        await expect(second.getOrSet("taken-over", async () => ({ tag: "second" }), { leaseSeconds: 1 })).resolves.toEqual({ tag: "second" });
        open();

        await expect(firstFill).resolves.toEqual(late);
        expect(error).not.toHaveBeenCalled();
        await expect(createCache(client).get("taken-over")).resolves.toEqual({ tag: "second" });
        await expect(first.get("taken-over")).resolves.toEqual({ tag: "second" });
        expect([...client.items.values()].some((item) => item.sk?.S?.startsWith("chunk#"))).toBe(false);
    });

    it("takes the lease over a manifest this instance cannot read, rather than waiting out its TTL", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        const value = largePayload();
        // Chunked under a smaller chunkBytes, which this instance's reads refuse.
        await createCache(client, 256).set("rechunked", value);
        const factory = vi.fn(async () => value);

        const startedAt = Date.now();
        await expect(createCache(client, 512).getOrSet("rechunked", factory)).resolves.toEqual(value);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(factory).toHaveBeenCalledOnce();
        expect(error).not.toHaveBeenCalled();

        // Stored again as this instance stores it, with none of the old chunks left.
        const meta = client.items.get(manifestKeyOf("rechunked"));
        const chunkVersions = new Set(
            [...client.items.values()]
                .filter((item) => item.sk?.S?.startsWith("chunk#"))
                .map((item) => item.sk?.S?.split("#")[1]),
        );
        expect(chunkVersions).toEqual(new Set([meta?.version?.S]));
        await expect(createCache(client, 512).get("rechunked")).resolves.toEqual(value);
    });

    it("counts a publish as landed when the SDK's retry of it is refused over its own manifest", async () => {
        // Read as refused, the fill would delete the chunks of the manifest it
        // had just published, and the entry would read as corrupt.
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        const value = largePayload();
        const send = client.send.bind(client);
        vi.spyOn(client, "send").mockImplementation(async (command: any) => {
            if (command instanceof PutItemCommand && command.input.Item?.version && command.input.ConditionExpression) {
                // The publish lands, its answer is lost, and the retry meets it.
                await send(command);
            }
            return await send(command);
        });

        await expect(createCache(client).getOrSet("retried", async () => value)).resolves.toEqual(value);
        await expect(createCache(client).get("retried")).resolves.toEqual(value);
        expect(warning).not.toHaveBeenCalled();
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

        await cache.set({ pk: "store:nyc-01", sk: "1700:1800" }, { heroes: 3 });
        await cache.set({ pk: "store:nyc-01", sk: "1700:1900" }, { heroes: 7 });
        await cache.set({ pk: "store:nyc-02", sk: "1700:1800" }, { heroes: 1 });

        // The two windows of nyc-01 share a partition; nyc-02 has its own.
        const partitions = new Set([...client.items.values()].map((item) => item.pk?.S));
        expect(partitions.size).toBe(2);
        expect(sortKeysOf(client)).toEqual(["sk#1700:1800#meta", "sk#1700:1800#meta", "sk#1700:1900#meta"]);

        const reader = createCache(client);
        await expect(reader.get({ pk: "store:nyc-01", sk: "1700:1800" })).resolves.toEqual({ heroes: 3 });
        await expect(reader.get({ pk: "store:nyc-01", sk: "1700:1900" })).resolves.toEqual({ heroes: 7 });
        await expect(reader.get({ pk: "store:nyc-02", sk: "1700:1800" })).resolves.toEqual({ heroes: 1 });
        await expect(reader.has({ pk: "store:nyc-01", sk: "1700:2000" })).resolves.toBe(false);
    });

    it("reads a grouped entry in one request, as an ungrouped one does", async () => {
        const client = new MemoryDynamoClient();
        await createCache(client).set({ pk: "store:nyc-01", sk: "1700:1800" }, { heroes: 3 });

        client.resetCommands();
        await createCache(client).get({ pk: "store:nyc-01", sk: "1700:1800" });
        expect(client.commandCount("GetItemCommand")).toBe(1);
        expect(client.commandCount("QueryCommand")).toBe(0);
    });

    it("stores a plain-string key under its plain layout, beside grouped entries in the same partition", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);

        await cache.set("store:nyc-01", { summary: true });
        await cache.set({ pk: "store:nyc-01", sk: "1700:1800" }, { heroes: 3 });

        // A plain key uses the bare item keys, beside the grouped entry's.
        expect(sortKeysOf(client)).toEqual(["meta", "sk#1700:1800#meta"]);

        // Deleting the plain entry leaves the grouped one alone, and vice versa.
        await expect(cache.delete("store:nyc-01")).resolves.toBe(true);
        expect(sortKeysOf(client)).toEqual(["sk#1700:1800#meta"]);
        await expect(createCache(client).get({ pk: "store:nyc-01", sk: "1700:1800" })).resolves.toEqual({ heroes: 3 });

        await cache.set("store:nyc-01", { summary: true });
        await expect(cache.delete({ pk: "store:nyc-01", sk: "1700:1800" })).resolves.toBe(true);
        expect(sortKeysOf(client)).toEqual(["meta"]);
    });

    it("chunks a grouped value under its own sort key and reassembles it", async () => {
        const client = new MemoryDynamoClient();
        const key = { pk: "store:nyc-01", sk: "1700:1900" };
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

        await cache.set({ pk: "store:nyc-01", sk: "1700:1800" }, { heroes: 3 });
        await cache.set({ pk: "store:nyc-01", sk: "1700:1900" }, largePayload());  // chunked
        await cache.set("store:nyc-01", { summary: true });
        await cache.set({ pk: "store:nyc-02", sk: "1700:1800" }, { heroes: 1 });

        await expect(cache.deletePartition("store:nyc-01")).resolves.toBe(3);

        await expect(cache.get({ pk: "store:nyc-01", sk: "1700:1800" })).resolves.toBeUndefined();
        await expect(cache.get({ pk: "store:nyc-01", sk: "1700:1900" })).resolves.toBeUndefined();
        await expect(cache.get("store:nyc-01")).resolves.toBeUndefined();
        // Chunks went with it, and the neighbouring partition is untouched.
        expect([...client.items.values()].every((item) => item.sk?.S === "sk#1700:1800#meta")).toBe(true);
        await expect(cache.get({ pk: "store:nyc-02", sk: "1700:1800" })).resolves.toEqual({ heroes: 1 });
    });

    it("deletePartition drops the in-memory copies of that partition only", async () => {
        const client = new MemoryDynamoClient();
        const cache = createCache(client);
        await cache.set({ pk: "store:nyc-01", sk: "1700:1800" }, { heroes: 3 });
        await cache.set({ pk: "store:nyc-02", sk: "1700:1800" }, { heroes: 1 });

        await cache.deletePartition("store:nyc-01");

        client.resetCommands();
        // Gone, not served from memory...
        await expect(cache.get({ pk: "store:nyc-01", sk: "1700:1800" })).resolves.toBeUndefined();
        expect(client.commandCount("GetItemCommand")).toBe(1);
        // ...while the other partition still answers without touching DynamoDB.
        client.resetCommands();
        await expect(cache.get({ pk: "store:nyc-02", sk: "1700:1800" })).resolves.toEqual({ heroes: 1 });
        expect(client.commands).toHaveLength(0);
    });

    it("lists live sort keys, filtered by raw prefix and limit", async () => {
        let clockMillis = Date.now();
        const client = new MemoryDynamoClient();
        const cache = createCache(client, 512, { now: () => clockMillis });

        await cache.set({ pk: "store:nyc-01", sk: "1700:1800" }, { heroes: 1 });
        await cache.set({ pk: "store:nyc-01", sk: "1700:1900" }, { heroes: 2 });
        await cache.set({ pk: "store:nyc-01", sk: "1800:1900" }, { heroes: 3 }, { ttlSeconds: 60 });
        await cache.set("store:nyc-01", { summary: true });

        // A plain-string entry has no sort key, so it never appears.
        await expect(cache.listSortKeys("store:nyc-01")).resolves.toEqual(["1700:1800", "1700:1900", "1800:1900"]);
        await expect(cache.listSortKeys("store:nyc-01", { prefix: "1700:" })).resolves.toEqual(["1700:1800", "1700:1900"]);
        await expect(cache.listSortKeys("store:nyc-01", { limit: 2 })).resolves.toEqual(["1700:1800", "1700:1900"]);
        await expect(cache.listSortKeys("store:nyc-02")).resolves.toEqual([]);

        // Expired entries drop out even before DynamoDB's TTL sweep removes them.
        clockMillis += 120_000;
        await expect(cache.listSortKeys("store:nyc-01")).resolves.toEqual(["1700:1800", "1700:1900"]);
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
            cache.getOrSet({ pk: "store:nyc-01", sk: "1700:1800" }, loader("a")),
            cache.getOrSet({ pk: "store:nyc-01", sk: "1700:1800" }, loader("a-again")),
            cache.getOrSet({ pk: "store:nyc-01", sk: "1700:1900" }, loader("b")),
        ]);

        // Same entry deduplicates; a sibling entry in the same partition is not blocked by it.
        expect(calls).toEqual(["a", "b"]);
        expect(first).toEqual({ name: "a" });
        expect(second).toEqual({ name: "a" });
        expect(third).toEqual({ name: "b" });

        const leases = [...client.items.values()].filter((item) => item.leaseOwner);
        expect(leases).toHaveLength(0);  // both published over their leases
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

/**
 * One set of rules, both caches. Code is written against LambderCache and
 * tested over LambderMemoryCache, which is only sound while the memory cache
 * answers as the table-backed one does: the same keys refused, the same JSON
 * round trip, the same expiry, the same listing. Each rule below runs over
 * both, through one clock that moves only when the test moves it.
 */
describe.each([
    {
        name: "LambderDdbCache",
        create: (now: () => number): LambderCache => createCache(new MemoryDynamoClient(), 512, { now }),
    },
    {
        name: "LambderMemoryCache",
        create: (now: () => number): LambderCache => new LambderMemoryCache({ now }),
    },
])("LambderCache conformance: $name", ({ create }) => {
    const START = 1_700_000_000_000;
    let clock = START;
    const build = () => { clock = START; return create(() => clock); };

    it("hands back a parse of what was stored, never the object itself", async () => {
        const cache = build();
        const value = { list: [1, 2], at: new Date(START) };
        await cache.set("round-trip", value);
        value.list.push(3);

        const read = await cache.get<{ list: number[]; at: string }>("round-trip");
        expect(read).toEqual({ list: [1, 2], at: new Date(START).toISOString() });
        expect(await cache.get("round-trip")).not.toBe(read);
    });

    it("answers undefined for an absent key and false from has()", async () => {
        const cache = build();
        await expect(cache.get("absent")).resolves.toBeUndefined();
        await expect(cache.has("absent")).resolves.toBe(false);
    });

    it("expires an entry at its TTL, the expiry second itself included", async () => {
        const cache = build();
        await cache.set("short", "value", { ttlSeconds: 10 });
        clock = START + 9_000;
        await expect(cache.get("short")).resolves.toBe("value");
        await expect(cache.has("short")).resolves.toBe(true);
        clock = START + 10_000;
        await expect(cache.get("short")).resolves.toBeUndefined();
        await expect(cache.has("short")).resolves.toBe(false);
    });

    it("refuses a value JSON cannot represent, and keys the table would refuse", async () => {
        const cache = build();
        await expect(cache.set("nothing", undefined)).rejects.toThrow("Cache value must be JSON-serializable");
        await expect(cache.get("  ")).rejects.toThrow("Cache key is required");
        await expect(cache.get({ pk: "reports", sk: "  " })).rejects.toThrow("Cache sort key is required");
        await expect(cache.get({ pk: "reports", sk: "#".repeat(500) })).rejects.toThrow("900");
    });

    it("deletes one entry and says whether there was one", async () => {
        const cache = build();
        await cache.set("gone", 1);
        await expect(cache.delete("gone")).resolves.toBe(true);
        await expect(cache.get("gone")).resolves.toBeUndefined();
        await expect(cache.delete("gone")).resolves.toBe(false);
    });

    it("answers false from delete while a fill is loading the key, since a load in progress is no entry", async () => {
        // Regression: the DynamoDB cache counted the fill's lease as an entry.
        const cache = build();
        const { loader, open } = gatedLoader({ tag: "old" });

        const fill = cache.getOrSet("filling", loader);
        await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
        await expect(cache.delete("filling")).resolves.toBe(false);
        open();

        await expect(fill).resolves.toEqual({ tag: "old" });
        await expect(cache.get("filling")).resolves.toBeUndefined();
    });

    it("counts no entry past its TTL as deleted, from delete or deletePartition", async () => {
        // Regression: the DynamoDB cache counted an expired manifest the
        // table's TTL had not removed yet.
        const cache = build();
        await cache.set("short", 1, { ttlSeconds: 10 });
        await cache.set({ pk: "store", sk: "short" }, 2, { ttlSeconds: 10 });
        await cache.set({ pk: "store", sk: "long" }, 3, { ttlSeconds: 100 });
        clock = START + 10_000;

        await expect(cache.delete("short")).resolves.toBe(false);
        await expect(cache.deletePartition("store")).resolves.toBe(1);
    });

    it("lists a partition's sort keys in order, by prefix and up to a limit, and leaves plain keys out", async () => {
        const cache = build();
        await cache.set({ pk: "store", sk: "1800:1900" }, 3);
        await cache.set({ pk: "store", sk: "1700:1800" }, 2);
        await cache.set({ pk: "store", sk: "0900:1000" }, 1);
        await cache.set({ pk: "other", sk: "1700:1800" }, 4);
        await cache.set("store", "a plain key sharing the partition");

        await expect(cache.listSortKeys("store")).resolves.toEqual(["0900:1000", "1700:1800", "1800:1900"]);
        await expect(cache.listSortKeys("store", { prefix: "1" })).resolves.toEqual(["1700:1800", "1800:1900"]);
        await expect(cache.listSortKeys("store", { limit: 1 })).resolves.toEqual(["0900:1000"]);
    });

    it("orders a key before one it is a prefix of when the longer one goes on below \"#\", as the table does", async () => {
        const cache = build();
        await cache.set({ pk: "cities", sk: "New York" }, 1);
        await cache.set({ pk: "cities", sk: "New York City" }, 2);
        await cache.set({ pk: "cities", sk: "New Yorker" }, 3);

        await expect(cache.listSortKeys("cities")).resolves.toEqual(["New York City", "New York", "New Yorker"]);
        await expect(cache.listSortKeys("cities", { prefix: "New", limit: 1 })).resolves.toEqual(["New York City"]);
    });

    it("drops a partition's grouped entries in one call and counts them", async () => {
        const cache = build();
        await cache.set({ pk: "store", sk: "a" }, 1);
        await cache.set({ pk: "store", sk: "b" }, 2);
        await cache.set({ pk: "other", sk: "a" }, 3);

        await expect(cache.deletePartition("store")).resolves.toBe(2);
        await expect(cache.listSortKeys("store")).resolves.toEqual([]);
        await expect(cache.get({ pk: "other", sk: "a" })).resolves.toBe(3);
    });

    it("loads once for concurrent getOrSet calls, then serves what it stored", async () => {
        const cache = build();
        const loader = vi.fn(async () => ({ city: "New York" }));

        const [first, second] = await Promise.all([cache.getOrSet("city", loader), cache.getOrSet("city", loader)]);
        expect(first).toEqual({ city: "New York" });
        expect(second).toEqual({ city: "New York" });
        expect(loader).toHaveBeenCalledOnce();
        await expect(cache.getOrSet("city", loader)).resolves.toEqual({ city: "New York" });
        expect(loader).toHaveBeenCalledOnce();
    });

    it("hands each call that shares a load or a read a parse of its own", async () => {
        // Regression: every call that joined one fill got the same object, so
        // one caller's change to its answer showed in the others'.
        const cache = build();
        const loader = async () => ({ list: [1] });

        const [first, second] = await Promise.all([cache.getOrSet("shared", loader), cache.getOrSet("shared", loader)]);
        expect(second).not.toBe(first);
        first.list.push(2);
        expect(second).toEqual({ list: [1] });

        const [hit, joiner] = await Promise.all([cache.getOrSet("shared", loader), cache.getOrSet("shared", loader)]);
        expect(joiner).not.toBe(hit);
        expect(joiner).toEqual({ list: [1] });
    });

    it("leaves a loader's undefined uncached, quietly, and asks the loader again next time", async () => {
        const cache = build();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const loader = vi.fn(async () => undefined);

        try {
            await expect(cache.getOrSet("not-found", loader)).resolves.toBeUndefined();
            await expect(cache.has("not-found")).resolves.toBe(false);
            await expect(cache.getOrSet("not-found", loader)).resolves.toBeUndefined();
            expect(loader).toHaveBeenCalledTimes(2);
            expect(error).not.toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });

    it("answers the stored JSON on the call that filled the entry, as on every later one", async () => {
        const cache = build();
        const loader = async () => ({ at: new Date("2026-01-02T03:04:05.000Z"), gone: undefined, count: 1 });

        const first = await cache.getOrSet("shape", loader);
        const later = await cache.getOrSet("shape", loader);
        expect(first).toEqual({ at: "2026-01-02T03:04:05.000Z", count: 1 });
        expect(Object.keys(first)).toEqual(["at", "count"]);
        expect(later).toEqual(first);
    });

    it("propagates a loader that throws", async () => {
        const cache = build();
        await expect(cache.getOrSet("broken", async () => { throw new Error("origin down"); })).rejects.toThrow("origin down");
    });

    it("never stores a slow fill's value over a set and a delete that landed while it loaded", async () => {
        // Regression: the fill stored "old" over the delete, to be served for
        // the entry's whole TTL.
        const cache = build();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { loader, open } = gatedLoader({ tag: "old" });

        const fill = cache.getOrSet("raced", loader);
        await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
        await cache.set("raced", { tag: "new" });
        // A call after the write reads it, rather than joining the load it overtook.
        await expect(cache.getOrSet("raced", async () => ({ tag: "other" }))).resolves.toEqual({ tag: "new" });
        await cache.delete("raced");
        open();

        await expect(fill).resolves.toEqual({ tag: "old" });
        await expect(cache.get("raced")).resolves.toBeUndefined();
        expect(error).not.toHaveBeenCalled();
    });

    it("never stores a slow fill's value over a deletePartition that landed while it loaded", async () => {
        const cache = build();
        const key = { pk: "store", sk: "a" };
        const { loader, open } = gatedLoader({ tag: "old" });

        const fill = cache.getOrSet(key, loader);
        await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
        await expect(cache.deletePartition("store")).resolves.toBe(0);
        open();

        await expect(fill).resolves.toEqual({ tag: "old" });
        await expect(cache.get(key)).resolves.toBeUndefined();
    });

    it("throws an invalid getOrSet option to the caller before loading, rather than failing open", async () => {
        // Regression: the check ran inside the fail-open, so a bad option
        // logged, handed the loader's value back and left caching off.
        const cache = build();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const loader = vi.fn(async () => "value");
        // The table's own options reach its twin through the interface too.
        const leaseOptions: LambderDdbCacheGetOrSetOptions[] = [{ leaseSeconds: 0 }, { waitForFillMs: 1.5 }];

        await expect(cache.getOrSet("options", loader, { ttlSeconds: 0 })).rejects.toThrow("ttlSeconds");
        await expect(cache.getOrSet("options", loader, leaseOptions[0])).rejects.toThrow("leaseSeconds");
        await expect(cache.getOrSet("options", loader, leaseOptions[1])).rejects.toThrow("waitForFillMs");
        expect(loader).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });
});

describe("LambderMemoryCache", () => {
    it("refuses a value past maxValueBytes, as the DynamoDB cache does", async () => {
        const cache = new LambderMemoryCache({ maxValueBytes: 10 });
        await expect(cache.set("big", "x".repeat(20))).rejects.toThrow("Cache value exceeds maxValueBytes");
    });

    it("orders sort keys by their UTF-8 bytes, as DynamoDB orders a range key", async () => {
        const cache = new LambderMemoryCache();
        // "B" (0x42) sorts before "a" (0x61) by bytes, the opposite of a locale compare.
        await cache.set({ pk: "p", sk: "a" }, 1);
        await cache.set({ pk: "p", sk: "B" }, 2);
        await expect(cache.listSortKeys("p")).resolves.toEqual(["B", "a"]);
    });

    it("forgets everything on reset()", async () => {
        const cache = new LambderMemoryCache();
        await cache.set("k", 1);
        cache.reset();
        await expect(cache.get("k")).resolves.toBeUndefined();
    });
});

/**
 * A replica that has not applied the latest writes answers every eventually
 * consistent read, while consistent reads and conditional writes see the
 * leader. The cache has to be right on such a table, not only on one that
 * answers every read with the latest write: a lease claimed, a value
 * published or an entry deleted a moment ago is invisible to a plain read.
 */
describe("LambderDdbCache under replica lag", () => {
    it("does not load again in a waiter whose replica has not seen the holder's fill when the lease frees", async () => {
        const client = new MemoryDynamoClient();
        client.replicaFallsBehind();
        let loads = 0;
        const loader = async () => { loads += 1; await new Promise((resolve) => setTimeout(resolve, 100)); return { loaded: loads }; };

        const holder = createCache(client).getOrSet("hot-key", loader);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const waiter = createCache(client).getOrSet("hot-key", loader);

        expect(await Promise.all([holder, waiter])).toEqual([{ loaded: 1 }, { loaded: 1 }]);
        expect(loads).toBe(1);
    });

    it("does not load again in a container arriving just after another's fill", async () => {
        const client = new MemoryDynamoClient();
        client.replicaFallsBehind();
        let loads = 0;
        await createCache(client).getOrSet("key", async () => ({ loaded: ++loads }));
        expect(await createCache(client).getOrSet("key", async () => ({ loaded: ++loads }))).toEqual({ loaded: 1 });
        expect(loads).toBe(1);
    });

    it("serves a value its lease claim was refused over from the refusal, without reading the manifest again", async () => {
        const client = new MemoryDynamoClient();
        client.replicaFallsBehind();
        const inline = { tag: "filled elsewhere" };
        const chunked = { ...largePayload(), tag: "filled elsewhere" };
        await createCache(client).set("inline", inline);
        await createCache(client).set("chunked", chunked);
        const loader = vi.fn(async () => ({ tag: "loaded here" }));

        // The read that misses on the replica, then the refused claim, which
        // carries the leader's item: nothing more for an inline value...
        client.resetCommands();
        await expect(createCache(client).getOrSet("inline", loader)).resolves.toEqual(inline);
        expect(client.commandCount("GetItemCommand")).toBe(1);
        expect(client.commandCount("QueryCommand")).toBe(0);

        // ...and one consistent read of the chunks for a chunked one.
        client.resetCommands();
        await expect(createCache(client).getOrSet("chunked", loader)).resolves.toEqual(chunked);
        expect(client.commandCount("GetItemCommand")).toBe(1);
        const queries = client.commands.filter((command) => command instanceof QueryCommand);
        expect(queries.map((command) => command.input.ConsistentRead)).toEqual([true]);
        expect(loader).not.toHaveBeenCalled();
    });

    it("deletes a value another container published a moment ago, before any replica has it", async () => {
        // Regression: delete looked the entry up with an eventually consistent
        // Query, missed it, answered false, and the value read before the
        // change was served for its whole TTL.
        const client = new MemoryDynamoClient();
        client.replicaFallsBehind();
        const stale = { ...largePayload(), tag: "read before the change" };
        await createCache(client).getOrSet("invalidated", async () => stale);

        await expect(createCache(client).delete("invalidated")).resolves.toBe(true);

        client.replicaCatchesUp();
        await expect(createCache(client).get("invalidated")).resolves.toBeUndefined();
        expect(client.items.size).toBe(0);
    });

    it("refuses the publish of a fill whose lease a delete removed before any replica had it", async () => {
        // Regression: the delete's Query missed the lease, so the fill, whose
        // loader read its source before the change, published over the delete.
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const client = new MemoryDynamoClient();
        client.replicaFallsBehind();
        const stale = { ...largePayload(), tag: "read before the change" };
        const { loader, open } = gatedLoader(stale);

        const fill = createCache(client).getOrSet("invalidated", loader);
        await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
        // A lease is no entry, so there was nothing to delete, but it goes.
        await expect(createCache(client).delete("invalidated")).resolves.toBe(false);
        open();

        await expect(fill).resolves.toEqual(stale);
        client.replicaCatchesUp();
        await expect(createCache(client).get("invalidated")).resolves.toBeUndefined();
        expect(client.items.size).toBe(0);
        expect(error).not.toHaveBeenCalled();
    });

    it("drops a partition's values and leases written a moment ago, before any replica has them", async () => {
        const client = new MemoryDynamoClient();
        client.replicaFallsBehind();
        await createCache(client).set({ pk: "store", sk: "published" }, { tag: "stale" });
        const { loader, open } = gatedLoader({ tag: "read before the change" });
        const fill = createCache(client).getOrSet({ pk: "store", sk: "filling" }, loader);
        await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());

        await expect(createCache(client).deletePartition("store")).resolves.toBe(1);
        open();
        await fill;

        client.replicaCatchesUp();
        await expect(createCache(client).get({ pk: "store", sk: "published" })).resolves.toBeUndefined();
        await expect(createCache(client).get({ pk: "store", sk: "filling" })).resolves.toBeUndefined();
        expect(client.items.size).toBe(0);
    });

    it("reads a key it deleted a moment ago from the leader, so a replica's old copy is neither served nor kept", async () => {
        // Regression: the read after the delete reached a replica that still
        // had the value, answered it as a hit and kept it in the memory layer,
        // to be served with no table call until its TTL.
        const client = new MemoryDynamoClient();
        await createCache(client).set("changed", { tag: "old" });
        client.replicaFallsBehind();
        const cache = createCache(client);
        const loader = vi.fn(async () => ({ tag: "new" }));

        await cache.delete("changed");
        await expect(cache.getOrSet("changed", loader)).resolves.toEqual({ tag: "new" });
        expect(loader).toHaveBeenCalledOnce();

        client.replicaCatchesUp();
        await expect(cache.get("changed")).resolves.toEqual({ tag: "new" });
    });

    it("reads a key after its own overlapping writes from the leader, never the replica's older value", async () => {
        const client = new MemoryDynamoClient();
        await createCache(client).set("overlap", { tag: "old" });
        client.replicaFallsBehind();
        const cache = createCache(client);
        const send = client.send.bind(client);
        let firstApplied = false;
        let answerFirst: () => void = () => undefined;
        const firstAnswer = new Promise<void>((resolve) => { answerFirst = resolve; });
        vi.spyOn(client, "send").mockImplementation(async (command: any) => {
            const answer = await send(command);
            if (command instanceof PutItemCommand) {
                // The write the table applies first answers last, so the
                // two overlap and leave no memory copy: the next read goes
                // to the table.
                if (!firstApplied) { firstApplied = true; await firstAnswer; }
                else setTimeout(answerFirst, 20);
            }
            return answer;
        });

        await Promise.all([cache.set("overlap", { tag: "A" }), cache.set("overlap", { tag: "B" })]);
        const read = await cache.get("overlap");
        expect([{ tag: "A" }, { tag: "B" }]).toContainEqual(read);

        client.replicaCatchesUp();
        await expect(createCache(client).get("overlap")).resolves.toEqual(read);
        await expect(cache.get("overlap")).resolves.toEqual(read);
    });

    it("reads a partition it dropped a moment ago from the leader", async () => {
        const client = new MemoryDynamoClient();
        const key = { pk: "store", sk: "a" };
        await createCache(client).set(key, { tag: "old" });
        client.replicaFallsBehind();
        const cache = createCache(client);

        await cache.deletePartition("store");
        await expect(cache.get(key)).resolves.toBeUndefined();
        await expect(cache.has(key)).resolves.toBe(false);

        client.replicaCatchesUp();
        client.resetCommands();
        await expect(cache.get(key)).resolves.toBeUndefined();
        expect(client.commandCount("GetItemCommand")).toBe(1);
    });
});

import type { AttributeValue, DynamoDBClient, UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import {
    assertPartitionKeyFits, createDynamoClientLoader, isConditionalCheckFailure, isKeyRangeThrottle,
    type LambderDynamoClientReady,
} from "./LambderDdbSdk.js";
import { assertNumberAtLeast } from "../shared/util/LambderOptionChecks.js";
import { LambderExpiringMap } from "../shared/util/LambderExpiringMap.js";
import { joinKeyFields } from "../shared/util/joinKeyFields.js";
import {
    RATE_LIMIT_WINDOWS,
    type LambderRateLimiter,
    type LambderRateLimitExceeded,
    type LambderRateLimitPolicy,
    type LambderRateLimitResult,
    type LambderRateLimitWindow,
} from "../shared/contracts/LambderRateLimiter.js";

export interface LambderDdbRateLimiterOptions {
    tableName: string;
    /** Region the client is created for on first use; the SDK's default chain otherwise. */
    region?: string;
    /** Partition key prefix, keeps counters separated from other systems in a shared table. Default: "RL". */
    keyPrefix?: string;
    /** Multiplier applied to the window length when setting the item TTL. */
    ttlWindowMultiplier?: number;
    client?: DynamoDBClient;
    /**
     * The clock the windows are computed against, injectable the way
     * LambderMemoryRateLimiter's is, so the conformance suite can drive both
     * implementations across a window boundary through one clock.
     */
    now?: () => number;
}

/** How long a key refused during a throttle is told to wait: long enough to let the partition recover, short enough for a legitimate caller. */
const THROTTLED_RETRY_SECONDS = 5;

/**
 * Most (tracker key, window) pairs the limiter remembers from throttles at
 * once. Only a key seen during a key-range throttle is remembered, for
 * THROTTLED_RETRY_SECONDS, so this is reached only by a flood spread over
 * that many keys at once, where the ones closest to expiring go first.
 */
const THROTTLED_WINDOW_MEMORY_ENTRIES = 10_000;

/** One window a policy caps, as the current call counts it. */
type LambderCappedWindow = { key: LambderRateLimitWindow; seconds: number; limit: number; start: number };

/**
 * What the limiter remembers of a window during a key-range throttle: the
 * count it read there at or over the limit, or, when its read was throttled
 * as well, the throttle the call was answered with.
 */
type LambderThrottledWindowMemory = { count: number } | { unreadable: unknown };

/** The table key of one window's counter. */
const counterKeyOf = (partitionKey: string, window: LambderCappedWindow): Record<string, AttributeValue> => ({
    pk: { S: partitionKey },
    sk: { S: `${window.key}#${window.start}` },
});

/** The same counter's key in the limiter's memory of throttled windows, its fields kept apart as the table's two attributes keep them. */
const rememberedWindowKeyOf = (partitionKey: string, window: LambderCappedWindow): string =>
    joinKeyFields(partitionKey, window.key, String(window.start));

/**
 * Fixed-window rate limiter backed by DynamoDB.
 *
 * Each window is one item counted with a conditional `ADD`, so the increment
 * and the limit check are one atomic request. Windows are evaluated smallest
 * first and evaluation stops at the first exceeded one, which keeps blocked
 * requests cheap and spares the larger counters. Attempts count, not
 * successes: a counter checked before the refusing one keeps its increment,
 * since a compensating decrement would give up the conditional-ADD
 * atomicity. Items carry an `expiresAt` attribute for DynamoDB TTL.
 *
 * The tracker key is caller data (an address, a session key, whatever a
 * policy handler returned), so a key whose partition key would pass
 * DynamoDB's 2048-byte limit is refused here, before any window is counted.
 * At the table it would come back as a ValidationException, which is not a
 * conditional-check failure: it would escape as a store error, and a caller
 * failing open on it would count nothing, leaving the limit silently off.
 * Lambder's own engine folds an over-long key into a digest first, so a key
 * that gets here came from a direct caller.
 *
 * A DynamoDB error propagates: a limiter cannot say whether the caller is
 * over its limit when it cannot reach the table, and whether an unanswerable
 * limit lets the request through is the application's call, made once for
 * every limiter at `rateLimits.failOpen`.
 *
 * A throttle on the key's range can be an answer instead. DynamoDB
 * throttles a partition's writes at roughly a thousand a second, and the SDK
 * retries first, so a throttle whose reason is KeyRangeThroughputExceeded
 * means the partition holding this counter is flooded. A partition holds a
 * range of keys, though, not one: a flood on one address, or a session or
 * cache spike on a shared table, throttles every counter on the same
 * partition. The key's own counts tell the flood from its neighbours: the
 * throttled window's and every capped window's after it, the ones this
 * attempt has not been counted against yet, each read with a consistent
 * GetItem, in parallel (reads have their own throughput, which the throttled
 * writes leave alone). A key at or over the limit of any of them is the
 * flood: it is refused, since passed on as a failure `failOpen` would wave
 * the flood through unmetered, and the Retry-After is a few seconds, the
 * time the partition takes to recover, rather than the window's reset. A key
 * over its daily cap whose per-minute counter has just started again is the
 * flood as much as one over its per-minute cap. Under every limit, or when a
 * read fails too, the key is a neighbour: the throttle propagates like any
 * other store failure and `failOpen` decides, as it does for a throttle of
 * the table or the account (its provisioned capacity, an on-demand maximum,
 * the account's quota), so no caller under its limit is refused because the
 * table is busy with somebody else.
 *
 * A flood repeats, and each repeat would cost the partition another
 * throttled write and another consistent read, until the reads throttle too
 * and the flood fails open. So the process remembers, for
 * THROTTLED_RETRY_SECONDS, each window it read at its limit, and refuses the
 * key's next attempts from memory without touching the table, which also
 * lets the partition recover for the neighbours. A count only rises within
 * its window, so the table would answer the same. A window whose read was
 * throttled as well is remembered too, with the throttle it was answered
 * with: a next attempt whose write is throttled there again skips the read
 * and throws that same throttle, which `rateLimits.failOpen` logs once
 * rather than once per request.
 *
 * Table shape: string hash key `pk`, string range key `sk`, TTL on `expiresAt`.
 * Items are prefixed `RL#` by default, so the table can be shared with
 * LambderDdbCache (`CACHE#`) and LambderDdbIdempotencyStore (`IDEM#`) without key
 * collisions.
 */
export class LambderDdbRateLimiter implements LambderRateLimiter {
    readonly tableName: string;
    readonly keyPrefix: string;

    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    private readonly ready: () => Promise<LambderDynamoClientReady>;
    private readonly ttlWindowMultiplier: number;
    private readonly now: () => number;
    /** The windows seen during key-range throttles, by (partition key, window, window start); see the class doc. */
    private readonly throttledWindows: LambderExpiringMap<LambderThrottledWindowMemory>;

    constructor(options: LambderDdbRateLimiterOptions) {
        if (!options.tableName.trim()) throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "RL";

        this.ttlWindowMultiplier = assertNumberAtLeast(options.ttlWindowMultiplier ?? 2, 1, "ttlWindowMultiplier");

        this.now = options.now ?? (() => Date.now());
        this.throttledWindows = new LambderExpiringMap({ now: this.now, maxEntries: THROTTLED_WINDOW_MEMORY_ENTRIES });
        this.ready = createDynamoClientLoader({ user: "LambderDdbRateLimiter", region: options.region, client: options.client });
    }

    /** The clock the windows are computed against, for the engine's Retry-After. */
    clockMilliseconds(): number {
        return this.now();
    }

    /**
     * Increment every configured window for `trackerKey` (IP, session, user id, ...)
     * and report whether any of them is over its limit, with the window's
     * reset time when so.
     */
    async isRateLimited(
        trackerKey: string,
        policy: LambderRateLimitPolicy,
    ): Promise<LambderRateLimitResult> {
        const nowSeconds = Math.floor(this.now() / 1000);
        // Once for the whole call, and before the first window is counted: a
        // key the table will not take fails every window the same way, so
        // refusing it here is the difference between one clear error and a
        // policy that counts nothing while reporting nothing.
        const partitionKey = this.partitionKeyFor(trackerKey);
        const windows: LambderCappedWindow[] = RATE_LIMIT_WINDOWS
            .filter(({ key }) => policy[key])
            .map(({ key, seconds }) => ({ key, seconds, limit: policy[key]!, start: Math.floor(nowSeconds / seconds) * seconds }));

        // A window this process read at its limit during a throttle refuses
        // without touching the table (see the class doc).
        const rememberedAtLimit = windows.find((window) => {
            const remembered = this.throttledWindows.get(rememberedWindowKeyOf(partitionKey, window));
            return remembered !== undefined && "count" in remembered && remembered.count >= window.limit;
        });
        if (rememberedAtLimit) return { window: rememberedAtLimit.key, limit: rememberedAtLimit.limit, resetAt: nowSeconds + THROTTLED_RETRY_SECONDS };

        for (const [index, window] of windows.entries()) {
            try {
                if (await this.incrementWindow(partitionKey, window, nowSeconds)) return { window: window.key, limit: window.limit, resetAt: window.start + window.seconds };
            } catch (error) {
                // A key-range throttle may be the limiter's own answer (see
                // the class doc); anything else is the table failing, which
                // only the caller can decide what to do about.
                if (!isKeyRangeThrottle(error)) throw error;
                return await this.answerKeyRangeThrottle(partitionKey, windows.slice(index), nowSeconds, error);
            }
        }
        return false;
    }

    /** The item's partition key, refused when the tracker key makes it one DynamoDB will not take. */
    private partitionKeyFor(trackerKey: string): string {
        return assertPartitionKeyFits({
            user: "LambderDdbRateLimiter",
            what: "tracker key",
            partitionKey: `${this.keyPrefix}#${trackerKey}`,
            remedy: "Shorten the key the policy hands the limiter.",
        });
    }

    /**
     * Increments one window counter. True when the limit was already reached
     * (the refused condition is the limiter's own answer); any other failure
     * throws.
     */
    private async incrementWindow(partitionKey: string, window: LambderCappedWindow, nowSeconds: number): Promise<boolean> {
        const expiresAt = nowSeconds + Math.ceil(window.seconds * this.ttlWindowMultiplier);
        const input: UpdateItemCommandInput = {
            TableName: this.tableName,
            Key: counterKeyOf(partitionKey, window),
            UpdateExpression: "ADD #count :one SET #expiresAt = if_not_exists(#expiresAt, :expiresAt)",
            ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
            ExpressionAttributeNames: { "#count": "count", "#expiresAt": "expiresAt" },
            ExpressionAttributeValues: {
                ":one": { N: "1" },
                ":expiresAt": { N: String(expiresAt) },
                ":limit": { N: String(window.limit) },
            },
        };

        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.UpdateItemCommand(input));
            return false;
        } catch (error) {
            if (isConditionalCheckFailure(error)) return true;
            throw error;
        }
    }

    /**
     * The answer to a key-range throttle on the first of `uncounted`: that
     * window and every capped one after it, the windows this attempt has not
     * been counted against. The windows before it counted this attempt and
     * allowed it, so reading them could only turn the attempt that filled
     * one into a refusal.
     *
     * Each count is read strongly consistent: the count that decides is the
     * one the throttled writes were racing to raise, and a replica lagging
     * behind them could read a key that has just reached its limit as under
     * it. Any window at or over its limit refuses, and is remembered (see the
     * class doc). Otherwise the throttle is thrown on, and when a read was
     * throttled too, the throttled window is remembered with it, so the
     * key's next attempts skip the read and throw that same throttle.
     */
    private async answerKeyRangeThrottle(
        partitionKey: string,
        uncounted: LambderCappedWindow[],
        nowSeconds: number,
        throttle: unknown,
    ): Promise<LambderRateLimitExceeded> {
        const throttledWindowKey = rememberedWindowKeyOf(partitionKey, uncounted[0]!);
        const remembered = this.throttledWindows.get(throttledWindowKey);
        if (remembered !== undefined && "unreadable" in remembered) throw remembered.unreadable;

        const { client, sdk } = await this.ready();
        const reads = await Promise.allSettled(uncounted.map(async (window) => {
            const { Item } = await client.send(new sdk.GetItemCommand({ TableName: this.tableName, Key: counterKeyOf(partitionKey, window), ConsistentRead: true }));
            return Number(Item?.count?.N ?? 0);
        }));
        const rememberUntil = nowSeconds + THROTTLED_RETRY_SECONDS;
        let refusing: LambderCappedWindow | undefined;
        for (const [index, read] of reads.entries()) {
            const window = uncounted[index]!;
            if (read.status === "fulfilled" && read.value >= window.limit) {
                this.throttledWindows.set(rememberedWindowKeyOf(partitionKey, window), { count: read.value }, rememberUntil);
                refusing ??= window;
            }
        }
        if (refusing) return { window: refusing.key, limit: refusing.limit, resetAt: rememberUntil };

        if (reads.some((read) => read.status === "rejected" && isKeyRangeThrottle(read.reason))) {
            this.throttledWindows.set(throttledWindowKey, { unreadable: throttle }, rememberUntil);
        }
        throw throttle;
    }
}

export default LambderDdbRateLimiter;

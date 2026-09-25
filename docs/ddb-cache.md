# LambderDdbCache

Standalone, persistent JSON cache backed by a DynamoDB table. Server-only (uses the AWS SDK + zlib); importing the `lambder` package root in a frontend bundle stays safe because Node modules are loaded lazily.

```typescript
import { LambderDdbCache } from "lambder";

const cache = new LambderDdbCache({
    tableName: "myapp-cache",
    region: "us-east-1",
    namespace: "geo",            // isolates keys per domain / version
    defaultTtlSeconds: 24 * 3600,
    memoryMaxBytes: 32 * 1024 * 1024,   // optional in-memory LRU layer (default 16MB)
});

const city = await cache.getOrSet(`city:${slug}`, async () => fetchCityFromDb(slug), {
    ttlSeconds: 7 * 24 * 3600,
});
// Also: cache.get(key), cache.set(key, value, { ttlSeconds }), cache.has(key), cache.delete(key)
```

A key can also be a `{ pk, sk }` pair, which keeps related entries in one partition so the whole group can be dropped or listed without knowing its members. See [Grouped keys](#grouped-keys).

## How it works

- Values are JSON-serialized and **Brotli-compressed** by default (`compression` option, the same one `LambderDdbIdempotencyStore` and sessions take); the manifest records each value's encoding, so the option can be switched on or off on a live table and values written under either setting keep reading.
- Small values (≤ ~350KB compressed) are stored inline in a single manifest item; larger values are split into **versioned binary chunks** written before the manifest, so readers only ever see complete versions (no torn reads). Overwriting a value deletes the chunks of the version it replaced, so a large value refreshed often does not pile up copies until their TTL.
- Integrity is verified with SHA-256 checksums. A read that finds chunks missing or failing the check reads the manifest and chunks again with a consistent read before it calls the entry corrupt: a replica that lags, or a newer write that replaced the version mid-read, is not corruption. Only an entry that fails the consistent read too is dropped.
- An **in-memory LRU layer** serves repeat reads within warm Lambda invocations. `memoryMaxBytes` bounds it by what each entry actually holds (its bytes, its key and a fixed overhead). It is per container: a value another container updates with `set` is served stale here until this copy's own expiry, up to `defaultTtlSeconds`, the same way a `delete` elsewhere leaves this copy in place. Short TTLs where readers have to see a change quickly, `memoryMaxBytes: 0` where they have to see it at once. Within the container, writes keep it exact: a read whose reply arrives after a `set`, `delete` or `deletePartition` there never puts the replaced value back, and two overlapping writes of one key leave no copy. For a few seconds after the container writes a key, it reads that key with consistent reads, so the next read fetches what the table applied last rather than what a lagging replica still holds. A write of one key never costs another key its copy.
- **Single-flight + DynamoDB lease**: concurrent `getOrSet` calls for the same key are deduplicated in-process, and a short-lived lease written onto the entry's manifest item ensures only one Lambda instance fills a missing key while others poll for the result, by default for as long as the lease lasts. The lease is taken with a conditional write that is refused while a live value is there, so when the read that found the key missing came from a replica that had not yet seen another instance's fill, the refusal says so and hands back that value's manifest, which serves the value (its chunks read consistently when it has any) instead of a second load.
- **A write wins over a fill in progress.** A fill publishes only while its lease is still on the manifest item. `set` replaces the manifest, and `delete` and `deletePartition` remove it, so a fill whose loader was already running (and may have read the source before the change) is refused: it deletes the chunks it wrote and hands its value back to its callers uncached. A waiter that takes over a lease whose holder ran past `leaseSeconds` takes it with the same conditional write, so the first holder's late publish is refused as well, and logged with `console.warn`: a loader slower than the lease is refused by every takeover and the entry never fills, so give such a call a `leaseSeconds` longer than its loader takes. A `getOrSet` call made after the write starts a load of its own rather than joining the overtaken one. `delete` removes the manifest item by its key and `deletePartition` finds the partition's items with a consistent Query, so neither misses a value or a lease another container wrote a moment before, which a replica may not have seen yet.
- `getOrSet` answers the stored JSON, parsed, on every call, the one that filled the entry included: a `Date` the loader returned is its ISO string the first time as it is every later time. Calls that share one load each get a parse of their own, so one caller changing its answer never changes another's. A loader that answers `undefined` has nothing to cache, and the next call asks it again; answer `null` to cache "not found".
- **Fail-open**: cache infrastructure errors (read/lease/write) fall back to calling the loader directly, and its value is handed back uncached in the same JSON shape a hit has; loader errors propagate to the caller. An invalid `getOrSet` option (`ttlSeconds`, `leaseSeconds`, `waitForFillMs`) is the caller's error, not the cache's: it throws before anything is read or loaded.
- `namespace` isolates key spaces; use a version-suffixed namespace (e.g. `` `v${webVersion}` ``) to invalidate everything on deploy.

## Grouped keys

A plain string key addresses one entry and nothing else, so invalidating a family of entries means remembering every key you ever wrote. Passing `{ pk, sk }` instead puts the entries in one partition:

```typescript
const key = (storeId: string, from: number, to: number) =>
    ({ pk: `store:${storeId}`, sk: `${from}:${to}` });

await cache.getOrSet(key("nyc-01", from, to), loadStore);

// Later, when the store changes: drop every cached window of it,
// without knowing which windows exist.
await cache.deletePartition("store:nyc-01");

// What is currently cached for it:
await cache.listSortKeys("store:nyc-01");                  // ["1700:1800", "1700:1900"]
await cache.listSortKeys("store:nyc-01", { prefix: "17" }); // prefix-filtered, limit optional
```

Every other method takes the same pair: `get`, `set`, `has`, `delete` and `getOrSet` behave exactly as they do for a plain key, on that one entry. Reads stay a single request, the in-memory layer, single-flight and the fill lease are all per entry, so two windows of the same store fill concurrently.

### How the keys are laid out

Only the `pk` part is hashed into the DynamoDB partition key. The sort key is stored readable, which is what lets `deletePartition` and `listSortKeys` work with a Query instead of a table scan:

```
pk = "CACHE#" + namespace + "#" + sha256(pk part)
sk = "sk#" + escaped(sort key) + "#" + ("meta" | "chunk#<version>#<index>")
```

One store with two cached windows, the second one large enough to be chunked:

```
pk                              sk
CACHE#v1#39bd0f5294832…         sk#1700:1800#meta
CACHE#v1#39bd0f5294832…         sk#1700:1900#meta
CACHE#v1#39bd0f5294832…         sk#1700:1900#chunk#m8x2k1-a1b2#000000
CACHE#v1#39bd0f5294832…         sk#1700:1900#chunk#m8x2k1-a1b2#000001
```

A plain string key uses the bare item keys (`meta`, `chunk#...`), so both forms can share a partition: `cache.set("store:nyc-01", summary)` and `cache.set({ pk: "store:nyc-01", sk: "1700:1800" }, window)` coexist, and deleting either leaves the other alone. `deletePartition` removes both, since it drops everything stored under that `pk`.

The `meta` item holds either the entry's value (its manifest) or, while a `getOrSet` fills a missing entry, only that fill's lease; readers take a lease with no value as a miss. [DynamoDB tables](./dynamodb-tables.md#cache-item-structure) lists the attributes of each item.

### What to know before grouping

- **`#` is escaped, not refused.** The store separates its own key segments with `#`, so a caller's `~` is stored as `~0` and `#` as `~1`. Keys come back exactly as written. Two consequences: an escaped key ranges in encoded order, so sort keys containing `#` or `~` sort into the `~` range rather than where the raw byte would put them, and the 900-byte sort key limit applies to the ESCAPED form.
- **Partitions concentrate traffic.** Every plain key gets its own partition today, which spreads load perfectly. Grouping deliberately puts entries together, and one DynamoDB partition serves 3000 RCU / 1000 WCU. Group by something whose members are read at a human scale (one store, one organization), not by something that funnels your whole read volume into one key.
- **Listing reads the whole partition.** `listSortKeys` projects only the sort key, the expiry and the version, but DynamoDB charges for the items it reads, chunk items included, so a partition holding chunked (multi-hundred-KB) values is expensive to list. `prefix` narrows the range that is read; `limit` caps the results, not the read. Grouping small values is cheap; grouping large ones, list sparingly.
- **Other containers keep their memory copies.** `deletePartition`, like `delete`, clears the in-memory layer of the container that calls it. Copies held by other warm Lambda containers still serve until their own TTL expires.

## Table setup

Same shape as every other Lambder DynamoDB store. It can share a table with the rate limiter and the idempotency store (key prefixes prevent collisions); see [DynamoDB tables](./dynamodb-tables.md).

```hcl
resource "aws_dynamodb_table" "myapp-cache" {
  name         = "myapp-cache"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute { name = "pk" type = "S" }
  attribute { name = "sk" type = "S" }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
```

Required IAM actions on the table: `dynamodb:GetItem`, `PutItem`, `DeleteItem`, `Query`, `BatchWriteItem`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `tableName` | required | DynamoDB table (pk/sk string keys, `expiresAt` TTL attribute) |
| `region` | SDK default | AWS region; left out, the SDK's own default chain (`AWS_REGION`, the Lambda environment, the shared config) decides |
| `keyPrefix` | `"CACHE"` | Partition key prefix, so cache items stay separate from other systems in a shared table |
| `namespace` | `"default"` | Key-space isolation prefix |
| `defaultTtlSeconds` | 1 year | TTL applied when `set`/`getOrSet` omit `ttlSeconds` |
| `memoryMaxBytes` | 16MB | In-memory LRU budget; `0` disables the memory layer |
| `compression` | `true` (`{ minBytes: 0, quality: 5 }`) | Brotli compression of stored values: `false` stores them plain, `{ minBytes, quality }` overrides the defaults; switchable on a live table |
| `maxValueBytes` | 32MB | Largest value the store will write, measured on the JSON and again on the stored bytes; a bigger one throws instead of being chunked without bound |
| `chunkBytes` | 350KB | Size of one chunk item, and the size at which a value stops being stored inline in its manifest. Capped at 380KB, inside DynamoDB's 400KB item limit |
| `client` | shared default | Supply your own `DynamoDBClient`. Left out, every DynamoDB store for one region shares one client, so one connection pool |
| `now` | `Date.now` | The clock entries are expired against, for tests |

`set` and `getOrSet` take per-call options too:

| Option | Default | Description |
| --- | --- | --- |
| `ttlSeconds` | `defaultTtlSeconds` | How long this value stays readable |
| `leaseSeconds` | 15 | How long the fill lease one container takes on a missing key is honoured by the others (`getOrSet`). Longer than the loader's worst case: a loader still running when its lease lapses has its value refused by the waiter that took the lease over, and is told so with `console.warn` |
| `waitForFillMs` | (`leaseSeconds` + 1) × 1000 | How long a container waits for somebody else's fill before giving up; it polls and takes the lease itself if the holder never publishes (`getOrSet`). The extra second covers the lease expiring in whole seconds |

## Methods

| Method | Description |
| --- | --- |
| `get(key)` | The stored value, or `undefined` when missing or expired |
| `set(key, value, { ttlSeconds })` | Store a JSON-serializable value |
| `has(key)` | Whether a live entry exists |
| `delete(key)` | Remove one entry (its manifest, with any fill lease on it, and its chunks); `true` when a live value was there (a fill's lease, or a value past its TTL that the table has not removed yet, is none) |
| `getOrSet(key, loader, options)` | Read, or fill once under a lease and store |
| `deletePartition(pk)` | Remove every entry stored under one `pk`; returns how many live values it removed |
| `listSortKeys(pk, { prefix, limit })` | The live sort keys under one `pk`, in table order |

`key` is a string or `{ pk, sk }` ([Grouped keys](#grouped-keys)); `deletePartition` and `listSortKeys` take the `pk` part on its own.

Exported types: `LambderCacheKey`, `LambderCacheSetOptions`, `LambderCacheListOptions` (shared with `LambderMemoryCache`), `LambderDdbCacheOptions`, `LambderDdbCacheGetOrSetOptions`, `LambderCompressionOption`.

## The LambderCache interface and the memory twin

`LambderDdbCache` implements `LambderCache`, the seven methods above. Type
your caches against the interface and a test can hold a `LambderMemoryCache`
where production holds the table:

```typescript
import { LambderDdbCache, LambderMemoryCache, type LambderCache } from "lambder";

export const geoCache: LambderCache = process.env.NODE_ENV === "test"
    ? new LambderMemoryCache()
    : new LambderDdbCache({ tableName: "myapp-cache", namespace: "geo" });
```

A cache the app constructs itself is the app's, so `lambder/testing` does not
swap it (see [Testing](./testing.md#what-the-app-constructs-itself)); the
memory twin is what a test swaps it for, by whatever means the app's tests
already use for its own modules.

`LambderMemoryCache` keeps the same rules, and a conformance suite drives both
through them: it refuses the keys and values the table refuses, stores a
value's JSON and hands back a fresh parse of it, expires entries on the same
TTL (the expiry second itself included), lists sort keys in the table's order
(UTF-8 bytes, escaped as above), counts only live entries in what `delete` and
`deletePartition` answer, and shares one load among concurrent `getOrSet`
calls for a key, handing each a parse of its own. `getOrSet` answers as the table does too: the
stored JSON parsed on every call, the filling one included, a loader's
`undefined` handed back uncached, quietly, so the next call loads again, a
fill that a `set`, `delete` or `deletePartition` of its key overtook handed
back uncached rather than stored over the write, and an invalid option
thrown before the loader runs. It has
none of the table's machinery (compression, chunks, the cross-container
lease) and holds at most `maxEntries` entries (100,000 by default), evicting
the ones closest to expiring first.

| Option | Default | Description |
| --- | --- | --- |
| `defaultTtlSeconds` | 1 year | As the table's |
| `maxValueBytes` | 32MB | As the table's, measured on the JSON |
| `maxEntries` | 100,000 | Ceiling on entries held at once |
| `now` | `Date.now` | The clock entries are expired against |

`reset()` forgets every entry. Exported types: `LambderCache`,
`LambderCacheSetOptions`, `LambderCacheListOptions`,
`LambderMemoryCacheOptions`.

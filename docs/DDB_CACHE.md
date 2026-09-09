# LambderDdbCache — DynamoDB-Backed Compressed Cache

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

- Values are JSON-serialized and **Brotli-compressed** by default (`compression` option, the same one `LambderDdbIdempotency` and sessions take); the manifest records each value's encoding, so the option can be switched on or off on a live table and values written under either setting keep reading.
- Small values (≤ ~350KB compressed) are stored inline in a single manifest item; larger values are split into **versioned binary chunks** written before the manifest, so readers only ever see complete versions (no torn reads).
- Integrity is verified with SHA-256 checksums.
- An **in-memory LRU layer** serves repeat reads within warm Lambda invocations.
- **Single-flight + DynamoDB lease**: concurrent `getOrSet` calls for the same key are deduplicated in-process, and a short-lived lock item ensures only one Lambda instance fills a missing key while others poll for the result.
- **Fail-open**: cache infrastructure errors (read/lease/write) fall back to calling the loader directly; loader errors propagate to the caller.
- `namespace` isolates key spaces — use a version-suffixed namespace (e.g. `` `v${webVersion}` ``) to invalidate everything on deploy.

## Grouped keys

A plain string key addresses one entry and nothing else, so invalidating a family of entries means remembering every key you ever wrote. Passing `{ pk, sk }` instead puts the entries in one partition:

```typescript
const key = (divisionId: string, from: number, to: number) =>
    ({ pk: `division:${divisionId}`, sk: `${from}:${to}` });

await cache.getOrSet(key("ist-34", from, to), loadDivision);

// Later, when the division changes: drop every cached window of it,
// without knowing which windows exist.
await cache.deletePartition("division:ist-34");

// What is currently cached for it:
await cache.listSortKeys("division:ist-34");                  // ["1700:1800", "1700:1900"]
await cache.listSortKeys("division:ist-34", { prefix: "17" }); // prefix-filtered, limit optional
```

Every other method takes the same pair: `get`, `set`, `has`, `delete` and `getOrSet` behave exactly as they do for a plain key, on that one entry. Reads stay a single request, the in-memory layer, single-flight and the fill lease are all per entry, so two windows of the same division fill concurrently.

### How the keys are laid out

Only the `pk` part is hashed into the DynamoDB partition key. The sort key is stored readable, which is what lets `deletePartition` and `listSortKeys` work with a Query instead of a table scan:

```
pk = "CACHE#" + namespace + "#" + sha256(pk part)
sk = "sk#" + escaped(sort key) + "#" + ("meta" | "lock" | "chunk#<version>#<index>")
```

One division with two cached windows, the second one large enough to be chunked:

```
pk                              sk
CACHE#v1#39bd0f5294832…         sk#1700:1800#meta
CACHE#v1#39bd0f5294832…         sk#1700:1900#meta
CACHE#v1#39bd0f5294832…         sk#1700:1900#chunk#m8x2k1-a1b2#000000
CACHE#v1#39bd0f5294832…         sk#1700:1900#chunk#m8x2k1-a1b2#000001
```

A plain string key keeps the exact layout it has always had (bare `meta`, `lock`, `chunk#...` items), so **a live table needs no migration** and both forms can share a partition: `cache.set("division:ist-34", summary)` and `cache.set({ pk: "division:ist-34", sk: "1700:1800" }, window)` coexist, and deleting either leaves the other alone. `deletePartition` removes both, since it drops everything stored under that `pk`.

### What to know before grouping

- **`#` is escaped, not refused.** The store separates its own key segments with `#`, so a caller's `~` is stored as `~0` and `#` as `~1`. Keys come back exactly as written. Two consequences: an escaped key ranges in encoded order, so sort keys containing `#` or `~` sort into the `~` range rather than where the raw byte would put them, and the 900-byte sort key limit applies to the ESCAPED form.
- **Partitions concentrate traffic.** Every plain key gets its own partition today, which spreads load perfectly. Grouping deliberately puts entries together, and one DynamoDB partition serves 3000 RCU / 1000 WCU. Group by something whose members are read at a human scale (one division, one organization), not by something that funnels your whole read volume into one key.
- **Listing reads the whole partition.** `listSortKeys` projects only the key and expiry, but DynamoDB charges for the items it reads, chunk items included, so a partition holding chunked (multi-hundred-KB) values is expensive to list. `prefix` narrows the range that is read; `limit` caps the results, not the read. Grouping small values is cheap; grouping large ones, list sparingly.
- **Other containers keep their memory copies.** `deletePartition`, like `delete`, clears the in-memory layer of the container that calls it. Copies held by other warm Lambda containers still serve until their own TTL expires.

## Table setup

Same shape as the Lambder session table — they can even share a table (namespaces prevent collisions), though a dedicated table is cleaner:

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
|---|---|---|
| `tableName` | required | DynamoDB table (pk/sk string keys, `expiresAt` TTL attribute) |
| `region` | `"us-east-1"` | AWS region |
| `namespace` | `"default"` | Key-space isolation prefix |
| `defaultTtlSeconds` | 1 year | TTL applied when `set`/`getOrSet` omit `ttlSeconds` |
| `memoryMaxBytes` | 16MB | In-memory LRU budget; `0` disables the memory layer |
| `compression` | `true` (`{ minBytes: 0, quality: 5 }`) | Brotli compression of stored values: `false` stores them plain, `{ minBytes, quality }` overrides the defaults; switchable on a live table |

## Methods

| Method | Description |
|---|---|
| `get(key)` | The stored value, or `undefined` when missing or expired |
| `set(key, value, { ttlSeconds })` | Store a JSON-serializable value |
| `has(key)` | Whether a live entry exists |
| `delete(key)` | Remove one entry (manifest, lease and chunks); `true` when something was there |
| `getOrSet(key, factory, options)` | Read, or fill once under a lease and store |
| `deletePartition(pk)` | Remove every entry stored under one `pk`; returns how many |
| `listSortKeys(pk, { prefix, limit })` | The live sort keys under one `pk`, in table order |

`key` is a string or `{ pk, sk }` ([Grouped keys](#grouped-keys)); `deletePartition` and `listSortKeys` take the `pk` part on its own.

Exported types: `LambderCacheKey`, `LambderDdbCacheOptions`, `LambderDdbCacheSetOptions`, `LambderDdbCacheGetOrSetOptions`, `LambderDdbCacheListOptions`, `LambderCompressionOption`.

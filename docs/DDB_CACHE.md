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

## How it works

- Values are JSON-serialized and **Brotli-compressed**.
- Small values (≤ ~350KB compressed) are stored inline in a single manifest item; larger values are split into **versioned binary chunks** written before the manifest, so readers only ever see complete versions (no torn reads).
- Integrity is verified with SHA-256 checksums.
- An **in-memory LRU layer** serves repeat reads within warm Lambda invocations.
- **Single-flight + DynamoDB lease**: concurrent `getOrSet` calls for the same key are deduplicated in-process, and a short-lived lock item ensures only one Lambda instance fills a missing key while others poll for the result.
- **Fail-open**: cache infrastructure errors (read/lease/write) fall back to calling the loader directly; loader errors propagate to the caller.
- `namespace` isolates key spaces — use a version-suffixed namespace (e.g. `` `v${webVersion}` ``) to invalidate everything on deploy.

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

Exported types: `LambderDdbCacheOptions`, `LambderDdbCacheSetOptions`, `LambderDdbCacheGetOrSetOptions`.

# LambderDdbIdempotency

DynamoDB-backed idempotency records: one item per (identity, api, key) scope,
claimed atomically with a conditional put. Server-only.

Most applications never call this store directly. Lambder's
[declarative idempotency](./api-policies.md#idempotency) drives it for every
API that opts in, which is the intended path. The direct API below is for the
cases the framework does not cover: a webhook receiver, a queue consumer, a
job runner that needs the same at-most-once guarantee.

```typescript
import { LambderDdbIdempotency } from "lambder";

const store = new LambderDdbIdempotency({ tableName: "app-policies", region: "us-east-1" });
```

## Lifecycle

```
peek(scope)                        // optional cheap read: a completed record to replay
  ↓ miss
begin(scope, { pendingTtlSeconds })
  ├─ "new"      → this request owns the scope (ownerToken proves it)
  │                 ... run the work ...
  │                 complete(scope, ownerToken, { statusCode, headers, body, ttlSeconds })
  │                 or abandon(scope, ownerToken) when there is nothing to store
  ├─ "pending"  → another request owns it right now (answer 409)
  └─ "done"     → the stored response; replay it verbatim
```

The first request claims the scope as `pending`; concurrent duplicates see
`pending`; once the response is stored via `complete()`, replays get it back
verbatim until the TTL. Records whose `expiresAt` has passed count as absent:
DynamoDB TTL deletion is lazy, so expiry is enforced in the condition rather
than left to TTL.

## Owner tokens

Every claim carries a random `ownerToken`, and `complete()` and `abandon()` are
conditional on still holding it. An original that outlives its pending TTL and
loses the scope to a retry can no longer overwrite or delete the retry's claim;
both settle calls become silent no-ops instead.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `tableName` | required | DynamoDB table (pk/sk string keys, `expiresAt` TTL attribute) |
| `region` | SDK default | AWS region |
| `keyPrefix` | `"IDEM"` | Partition key prefix, so records stay separate from other systems in a shared table |
| `compression` | `true` (`{ minBytes: 1024, quality: 5 }`) | Brotli compression of stored bodies. `false` stores every body plain; an object overrides the defaults. Records of either shape read back, so it can be switched on a live table |
| `client` | new client | Supply your own `DynamoDBClient` |

## Methods

| Method | Returns | Description |
| --- | --- | --- |
| `peek(scopeKey)` | `LambderIdempotencyDoneRecord \| null` | The stored response when a completed, unexpired record exists. An eventually-consistent read: a miss only means the caller proceeds to `begin()`, whose read is authoritative |
| `begin(scopeKey, { pendingTtlSeconds })` | `{ state: "new", ownerToken } \| { state: "pending" } \| { state: "done", ...record }` | Claim the scope |
| `complete(scopeKey, ownerToken, { statusCode, headers, body, ttlSeconds })` | `"stored" \| "too-large" \| "lost"` | Store the response for replay |
| `abandon(scopeKey, ownerToken)` | `void` | Release the claim without storing a response, so a retry can execute |

`complete()`'s answers:

| Result | Meaning |
| --- | --- |
| `"stored"` | The response is recorded and will replay until its TTL |
| `"too-large"` | Even compressed, the body exceeds the item budget. Nothing was written, and the caller should release the claim |
| `"lost"` | The `ownerToken` no longer matches: the claim expired and a retry took the scope over. Nothing was written |

## Stored bodies

Bodies of 1KB or more are Brotli-compressed by default, stored as `bodyBr`
bytes beside `bodyBytes`, the body's UTF-8 byte length. That length both bounds
the decompression and verifies it, so a truncated or tampered record fails to
decode rather than decoding to something merely plausible. It is the same
scheme and `compression` option `LambderDdbCache` and sessions use.

The item budget is ~350KB, applied to the bytes actually stored, and DynamoDB's
400KB item limit is what it leaves headroom under. JSON envelopes typically
shrink 5-10x, so even large responses usually stay replayable.

Response headers are stored as a normalized multi-value map, so headers set
during the original request replay too. A corrupt headers attribute replays
with no headers rather than failing the request.

## Item layout

```
pk = "<keyPrefix>#<scopeKey>"   e.g. "IDEM#<session>#order.create#<key>"
sk = "idem"
```

The `IDEM#` prefix means the table can be shared with `LambderDdbCache`
(`CACHE#`) and `LambderDdbRateLimiter` (`RL#`) without key collisions. Keep
sessions in their own table so IAM can be scoped to them separately.

## Table setup

See [DynamoDB tables](./dynamodb-tables.md) for the Terraform, TTL setting and
IAM policy. Required IAM actions on the table: `dynamodb:GetItem`, `PutItem`,
`DeleteItem`.

## Exported types

`LambderDdbIdempotencyOptions`, `LambderIdempotencyBeginResult`,
`LambderIdempotencyDoneRecord`, `LambderCompressionOption`.

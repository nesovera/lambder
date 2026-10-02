# LambderDdbIdempotencyStore

DynamoDB-backed idempotency records: one item per (identity, api, key) scope,
claimed atomically with a conditional put. Server-only.

Most applications never call this store directly. Lambder's
[declarative idempotency](./api-policies.md#idempotency) drives it for every
API that opts in, which is the intended path. The direct API below is for the
cases the framework does not cover: a webhook receiver, a queue consumer, a
job runner that needs the same at-most-once guarantee.

```typescript
import { LambderDdbIdempotencyStore } from "lambder";

const store = new LambderDdbIdempotencyStore({ tableName: "app-policies", region: "us-east-1" });
```

## Lifecycle

```
peek(scope)                        // optional cheap read: a completed record to replay
  ↓ miss
begin(scope, { pendingTtlSeconds, fingerprint })
  ├─ "new"      → this request owns the scope (ownerToken proves it)
  │                 ... run the work ...
  │                 complete(scope, ownerToken, { statusCode, headers, body, fingerprint, ttlSeconds })
  │                 or abandon(scope, ownerToken) when there is nothing to store
  ├─ "pending"  → another request owns it right now (answer 409), with its fingerprint
  └─ "done"     → the stored response and its fingerprint; replay it verbatim
```

`fingerprint` is a digest of the request the scope was claimed for (its
payload and the guard inputs that count). The store keeps it on the claim
and on the settled record and hands it back with `"pending"` and `"done"`,
and the engine refuses a key that arrives with a different one
(`lambder/idempotency-key-reused`) instead of replaying another request's
answer.

An item that keeps no `fingerprint` was not written by this store, so no
request can be shown to be the one it belongs to. It reads as a different
request's (the fingerprint comes back as `""`, which no request has): the
engine answers the key-reused 409, which a key scope moves past, rather than
replaying an answer it cannot tie to the request or running the request over
a claim that may still be in flight.

`begin` is one conditional write either way: a refused claim comes back with
the item that refused it (`ReturnValuesOnConditionCheckFailure: "ALL_OLD"`),
so there is no read after it. That item is also how a claim the SDK retried,
after the first attempt had already landed, recognizes itself: the item
carries this call's own `ownerToken`, and the claim is answered `"new"` rather
than `"pending"`, which answered the original 409.

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

`complete()` requires the claim to be BOTH still owned and still live: an owner
whose claim ran out reports `"lost"` whether or not DynamoDB's TTL deletion has
caught up with the expired item, which is what the in-memory store reports for
the same call.

`abandon()` is owner-only too, and it releases only a claim that is still
pending (`ownerToken = :owner AND #state = :pending`): a settled record stays,
even when the owner that stored it asks. A `complete()` can fail after it
landed (a timeout on the SDK's last attempt), and the engine releases the
claim after any failed `complete()`; deleting the stored answer there would
hand the client's retry a free scope, and the operation would run twice.
Kept, the retry replays it.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `tableName` | required | DynamoDB table (pk/sk string keys, `expiresAt` TTL attribute) |
| `region` | SDK default | AWS region |
| `keyPrefix` | `"IDEM"` | Partition key prefix, so records stay separate from other systems in a shared table |
| `compression` | `true` (`{ minBytes: 1024, quality: 5 }`) | Brotli compression of stored bodies. `false` stores every body plain; an object overrides the defaults. Records of either shape read back, so it can be switched on a live table |
| `client` | shared default | Supply your own `DynamoDBClient`. Left out, every DynamoDB store for one region shares one client, so one connection pool |
| `now` | `Date.now` | The clock claims and records are expired against, for tests |

## Methods

| Method | Returns | Description |
| --- | --- | --- |
| `peek(scopeKey)` | `LambderIdempotencyDoneRecord \| null` | The stored response when a completed, unexpired record exists. An eventually-consistent read: a miss only means the caller proceeds to `begin()`, whose read is authoritative |
| `begin(scopeKey, { pendingTtlSeconds, fingerprint })` | `{ state: "new", ownerToken } \| { state: "pending", fingerprint } \| { state: "done", ...record }` | Claim the scope, keeping the request's fingerprint |
| `complete(scopeKey, ownerToken, { statusCode, headers, body, fingerprint, ttlSeconds })` | `"stored" \| "too-large" \| "lost"` | Store the response for replay |
| `abandon(scopeKey, ownerToken)` | `void` | Release a claim that is still pending without storing a response, so a retry can execute. A settled record stays |

`complete()`'s answers:

| Result | Meaning |
| --- | --- |
| `"stored"` | The response is recorded and will replay until its TTL |
| `"too-large"` | The body is past 32MB, or even compressed it exceeds the item budget. Nothing was written, and the caller should release the claim |
| `"lost"` | The claim is no longer the caller's: the `ownerToken` does not match, or the claim itself has expired. Nothing was written |

## Stored bodies

Bodies of 1KB or more are Brotli-compressed by default, stored as `bodyBr`
bytes beside `bodyBytes`, the body's UTF-8 byte length. That length both bounds
the decompression and verifies it, so a truncated or tampered record fails to
decode rather than decoding to something merely plausible. It is the same
scheme and `compression` option `LambderDdbCache` and sessions use.

An empty body is never compressed, whatever `minBytes` says: there would be no
length to verify on the way back, so a 204 or an empty 200 is stored plain and
replays as the empty body it was. In the other direction, 32MB is the ceiling
both ways: a body past it answers `"too-large"` however small it compresses,
and a stored `bodyBytes` larger than it is a record this store did not write,
refused rather than taken as a licence to decompress that far.

The item budget is ~350KB, applied to the bytes actually stored, and DynamoDB's
400KB item limit is what it leaves headroom under. JSON envelopes typically
shrink 5-10x, so even large responses usually stay replayable.

Response headers are stored as a normalized multi-value map, so headers set
during the original request replay too. A corrupt headers attribute replays
with no headers rather than failing the request.

## Item layout

```
pk = "<keyPrefix>#<scopeKey>"   e.g. "IDEM#s:<digest>|order.create|key:<digest>"
sk = "idem"
```

The scope key starts with who the request is, then the API name, then the
client's key, with every field escaped and joined by `|` so no two different
field lists can produce one string. There are three forms of the first field:

| Form | When |
| --- | --- |
| `s:<digest>` | A session API: the signed-in user's sessionKey is the identity, so every session of one user shares the scope |
| `i:<digest>` | A public API with `idempotency.callerIdentity` configured, which returns who the caller is (an API key, a tenant, a verified email) |
| `k` | A public API with no `callerIdentity`: the key alone is the scope |

Every field but the API name is caller data, so the engine writes each as a
digest of fixed length, 64 hex characters after its kind (`s:`, `i:`, and
`key:` for the client's key), whatever the value's own length. A partition
key shows which API its record answers and never whose it is (the record's
body is the answer as it was sent, whatever that holds): with
sessions configured the digest is an HMAC keyed by a subkey of the
`sessionSalt`, which no read of the table can test a guess against, and
without them a plain SHA-256, which keeps the values out of the table but
lets a reader test guesses (see [What a table read
shows](./api-policies.md#what-a-table-read-shows)). And no credential, however
long (a device token several kilobytes long is the kind `callerIdentity` is
documented to read), pushes the partition key past DynamoDB's limit below,
where the store's refusal would be a throw that `failOpen` turns into no
idempotency for that caller. Changing the `sessionSalt` starts every record
afresh.

A `k` scope carries no identity, so its keys have to be unguessable: anyone who
can present one replays the answer stored under it, and a replay happens before
guards run. `callerIdentity` is what turns that bearer token back into
something scoped to one caller.

The whole partition key, prefix included, has to fit DynamoDB's 2048-byte
limit. Lambder's engine keeps its scopes inside it (see above); a direct
caller's key is written as given, and a longer one is refused by every
method that touches the table, with
an error that names the limit, rather than reaching the table and coming back
as a `ValidationException`.

The `IDEM#` prefix means the table can be shared with `LambderDdbCache`
(`CACHE#`) and `LambderDdbRateLimiter` (`RL#`) without key collisions. Keep
sessions in their own table so IAM can be scoped to them separately.

## Table setup

See [DynamoDB tables](./ddb-tables.md) for the Terraform, TTL setting and
IAM policy. Required IAM actions on the table: `dynamodb:GetItem`, `PutItem`,
`DeleteItem`.

## Exported types

`LambderDdbIdempotencyStoreOptions`, `LambderCompressionOption`, and from the shared
vocabulary (`shared/contracts/LambderIdempotencyStore`, which the engine and every store
import and nothing else) `LambderIdempotencyStore` (the interface this class
implements), `LambderIdempotencyBeginResult`, `LambderIdempotencyDoneRecord`.

`LambderMemoryIdempotencyStore` is the in-memory implementation with the same
semantics, for tests and the mock runtime. Its options are `maxBodyBytes` (what
stands in for the item budget, unbounded by default), `now` (the clock, so a
test can expire a claim without waiting) and `maxEntries`.

`maxEntries` is the one way it differs from a table. A process cannot hold
records without bound, so it holds at most 100,000 by default and past that
the SETTLED records go, soonest expiry first: a retry whose record was dropped
executes again instead of replaying. Pending claims are never dropped to make
room, because losing one lets two concurrent retries execute at once, which is
the thing idempotency exists to prevent. A claim that cannot be made room for
is reported as `"pending"` instead, with the caller's own fingerprint, so the
engine answers the in-flight 409 (retried under the same key) rather than the
key-reused one, the duplicate is refused rather than run, and the saturation
is logged once.

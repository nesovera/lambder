# DynamoDB tables

Four Lambder systems store data in DynamoDB, and all four use the same table
shape: a string hash key `pk`, a string range key `sk`, and TTL on an
`expiresAt` attribute.

| System | Item prefix | Needed for |
| --- | --- | --- |
| Sessions | (its own table) | `addSessionApi`, `addSessionRoute`, the session controller |
| [`LambderDdbCache`](./ddb-cache.md) | `CACHE#` | Cached values |
| [`LambderDdbRateLimiter`](./ddb-rate-limiter.md) | `RL#` | Rate-limit counters |
| [`LambderDdbIdempotencyStore`](./ddb-idempotency.md) | `IDEM#` | Idempotency claims and replays |

## How many tables

The three non-session systems prefix their keys, so **they can share one
table** without collisions. That is the common setup: one `app-policies` table
for rate limits and idempotency, and either the same table or a dedicated one
for the cache.

**Keep sessions in their own table.** Not because of key collisions, but so
IAM can be scoped to it separately: the session table is the one whose contents
identify users, and a cache or rate-limit role should not be able to read it.

## Which region

Every one of them takes an optional `region`, and leaving it out means the AWS
SDK's own default chain: `AWS_REGION` (which Lambda sets to the function's
region), then the shared config file, then the rest of the chain. That is
usually what you want, since the table is normally in the region the function
runs in.

All four follow the same chain, so they land in the same region unless told
otherwise. Name `region` only for a table that lives somewhere other than the
function.

## Table creation

The same definition works for every one of them; only the name changes.

```hcl
resource "aws_dynamodb_table" "lambder_sessions" {
  name         = "lambder-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    enabled        = true
    attribute_name = "expiresAt"
  }

  tags = {
    Purpose = "Session Management"
  }
}
```

### Enabling TTL in the console

TTL automatically removes expired records, saving storage costs. It is
recommended everywhere and required nowhere: every system also enforces expiry
in its own read conditions, because DynamoDB's TTL deletion is lazy.

1. Go to the DynamoDB console
2. Select your table (`lambder-sessions`)
3. Open the **Additional settings** tab
4. Click **Edit** under **Time to Live (TTL)**
5. Enable TTL
6. Set the **TTL attribute** to `expiresAt`
7. Save

## IAM permissions

Grant only what the systems on that table actually use.

| System | Actions |
| --- | --- |
| Sessions | `GetItem`, `PutItem`, `DeleteItem`, `Query`, `UpdateItem` |
| `LambderDdbCache` | `GetItem`, `PutItem`, `DeleteItem`, `Query`, `BatchWriteItem` |
| `LambderDdbRateLimiter` | `UpdateItem`, `GetItem` |
| `LambderDdbIdempotencyStore` | `GetItem`, `PutItem`, `DeleteItem` |

A session-table policy, for example:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:123456789012:table/lambder-sessions"
      ]
    }
  ]
}
```

## Session record structure

Each session is stored as:

```json
{
  "pk": "HMAC-SHA256(sessionSalt, sessionKey)",
  "sk": "sha256(cookie secret)",
  "csrfTokenHash": "sha256(csrf token)",
  "sessionKey": "user_123",
  "dataBr": "<binary: Brotli of the data JSON>",
  "dataBytes": 61,
  "createdAt": 1697712000,
  "lastAccessedAt": 1697712300,
  "expiresAt": 1700304000,
  "ttlInSeconds": 2592000,
  "dataVersion": 0
}
```

The bearer secrets are stored only as hashes, and the partition key is the
sessionKey keyed by the salt; see
[Sessions](./sessions.md#how-the-secrets-are-stored) for why, and why fast
sha256 is the right construction here.

Session data is Brotli-compressed by default, `dataBr` beside its JSON byte
length `dataBytes`; with the store's `compression` off, or below its
`minBytes`, the data is a plain `data` map attribute instead. Records written
under either setting read back, so the setting can be switched on or off on a
live table. Sessions configured with `dataRefresh` also carry `dataExpiresAt`.

`dataVersion` starts at 0 and goes up by one, through an `ADD` in the same
`UpdateItem`, on every write of the data or of `dataExpiresAt`. The store's
conditional writes compare it, so data derived from an earlier read never
lands over a newer write or a revocation mark. An item without it is not a
record this store wrote, and reads as no session.

The key attribute names are configurable through `LambderDdbSessionStore`'s
`partitionKey` and `sortKey` options if your table already uses different
ones, along with `tableName`, `region` and `compression`. These belong to the
store rather than to the `session` option, which holds only what is true of
every store.

## Cache item structure

`LambderDdbCache` keeps each entry in one manifest item, plus chunk items for a
value too large to hold inline (the keys are laid out in
[LambderDdbCache](./ddb-cache.md#how-the-keys-are-laid-out)). The manifest item
holds one of two things. A value:

```json
{
  "pk": "CACHE#geo#sha256(key)",
  "sk": "meta",
  "version": "m8x2k1-<uuid>",
  "encoding": "br",
  "chunkCount": 0,
  "storedBytes": 812,
  "uncompressedBytes": 2048,
  "checksum": "sha256(stored bytes)",
  "data": "<binary: the stored bytes, for a value held inline>",
  "createdAt": 1697712000,
  "expiresAt": 1729248000
}
```

or, while a `getOrSet` fills a missing entry, only that fill's lease:

```json
{
  "pk": "CACHE#geo#sha256(key)",
  "sk": "meta",
  "leaseOwner": "<uuid of the filling call>",
  "expiresAt": 1697712016
}
```

`expiresAt` is the first second an item no longer counts: the value's TTL, or
the end of the lease, so the table's TTL also removes a lease its holder
abandoned. Readers take an item with no `version` as a miss, and the fill's
publish replaces the lease item with its value. `encoding` is `br` for a
Brotli-compressed value and `identity` for one stored as plain JSON bytes.

A value too large to hold inline has no `data` and `chunkCount` chunk items
beside its manifest, each `{ pk, sk: "chunk#<version>#<index>", data,
expiresAt }` carrying the value's own `expiresAt`. `version` is fresh on every
write, so the chunks of two versions never mix. A grouped key puts
`sk#<escaped sort key>#` in front of every item's `sk`.

## Capacity

`PAY_PER_REQUEST` is the right default for all four: session and policy traffic
follows request traffic, and none of these tables has a steady baseline worth
provisioning for. Three things to keep in mind if you switch to provisioned
capacity:

- Sessions use consistent reads, which cost twice an eventually-consistent one
  and are bounded by 4KB per read unit. Compressed session data (the default)
  keeps a growing session inside one unit for longer.
- `LambderDdbCache` reads eventually consistent except where a replica's lag
  would matter: a key the same instance wrote in the last few seconds, the
  chunks of a value its fill lease was refused over (the read that missed it
  reached a replica that had not seen it yet), a reread of chunks that did not
  add up before it calls an entry corrupt, and the Queries of `delete` (the
  entry's chunks) and `deletePartition`.
- `LambderDdbCache` partitions concentrate traffic when grouped keys are used;
  one DynamoDB partition serves 3000 RCU and 1000 WCU. See
  [What to know before grouping](./ddb-cache.md#what-to-know-before-grouping).

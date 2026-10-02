# DynamoDB tables

Five Lambder systems store data in DynamoDB, and all five use the same table
shape: a string hash key `pk`, a string range key `sk`, and TTL on an
`expiresAt` attribute.

| System | Item prefix | Needed for |
| --- | --- | --- |
| Sessions | (its own table) | Endpoints whose guards need a session, `addSessionRoute`, the session controller |
| [`LambderDdbCache`](./ddb-cache.md) | `CACHE#` | Cached values |
| [`LambderDdbRateLimiter`](./ddb-rate-limiter.md) | `RL#` | Rate-limit counters |
| [`LambderDdbIdempotencyStore`](./ddb-idempotency.md) | `IDEM#` | Idempotency claims and replays |
| [`LambderDdbOneShotSecretStore`](./secrets.md#one-shot-secrets) | `OTS#` | Codes and tokens handed out once, as digests |

## How many tables

The four non-session systems prefix their keys, so **they can share one
table** without collisions. That is the common setup: one `app-policies` table
for rate limits, idempotency and one-shot secrets, and either the same table
or a dedicated one for the cache.

**Keep sessions in their own table.** Not because of key collisions, but so
IAM can be scoped to it separately: the session table is the one whose contents
identify users, and a cache or rate-limit role should not be able to read it.

## Which region

Every one of them takes an optional `region`, and leaving it out means the AWS
SDK's own default chain: `AWS_REGION` (which Lambda sets to the function's
region), then the shared config file, then the rest of the chain. That is
usually what you want, since the table is normally in the region the function
runs in.

All five follow the same chain, so they land in the same region unless told
otherwise. Name `region` only for a table that lives somewhere other than the
function.

## Which client

All five speak DynamoDB's item-level API through `@aws-sdk/client-dynamodb`,
the one package they need, loaded on first use. Each takes an optional
`client`, a `DynamoDBClient`; left out, every store for one region shares one
client, so one connection pool and one credential lookup on a cold container.

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
| `LambderDdbOneShotSecretStore` | `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` |

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

Each session is stored as below, shown as plain JSON: on the table the hashes,
`csrfTokenHash` and `sessionKey` are strings (`S`), the times, counts and
`dataBytes` numbers (`N`), and `dataBr` a binary (`B`).

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
`minBytes`, the data is a plain `data` attribute instead, its JSON as
attribute values: an object as a map (`M`), an array as a list (`L`), strings,
numbers, booleans and `null` as `S`, `N`, `BOOL` and `NULL`. That is the item
`@aws-sdk/lib-dynamodb`'s document client writes for the same data, so a table
that client wrote reads unchanged. Records written under either setting read
back, so the setting can be switched on or off on a live table. Sessions
configured with `dataRefresh` also carry `dataExpiresAt`.

A record has to fit DynamoDB's 400KB item limit, and the data is the part of
it that grows. As stored (compressed, or the plain map as DynamoDB sizes it),
it may take 392KB, which leaves the record's other attributes 8KB; its JSON
may be 32MB at most, which is also the length a stored `dataBytes` is trusted
up to. A create or an update whose data is past either refuses before it
writes, with an error naming the size and the limit, rather than reaching the
table and coming back as a `ValidationException` that names neither. A record
declaring more than 32MB reads as no session rather than being decompressed.

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

`PAY_PER_REQUEST` is the right default for all five: session and policy traffic
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

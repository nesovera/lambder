# DynamoDB tables

Four Lambder systems store data in DynamoDB, and all four use the same table
shape: a string hash key `pk`, a string range key `sk`, and TTL on an
`expiresAt` attribute.

| System | Item prefix | Needed for |
| --- | --- | --- |
| Sessions | (its own table) | `addSessionApi`, `addSessionRoute`, the session controller |
| [`LambderDdbCache`](./ddb-cache.md) | `CACHE#` | Cached values |
| [`LambderDdbRateLimiter`](./ddb-rate-limiter.md) | `RL#` | Rate-limit counters |
| [`LambderDdbIdempotency`](./ddb-idempotency.md) | `IDEM#` | Idempotency claims and replays |

## How many tables

The three non-session systems prefix their keys, so **they can share one
table** without collisions. That is the common setup: one `app-policies` table
for rate limits and idempotency, and either the same table or a dedicated one
for the cache.

**Keep sessions in their own table.** Not because of key collisions, but so
IAM can be scoped to it separately: the session table is the one whose contents
identify users, and a cache or rate-limit role should not be able to read it.

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
| `LambderDdbRateLimiter` | `UpdateItem` |
| `LambderDdbIdempotency` | `GetItem`, `PutItem`, `DeleteItem` |

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
  "pk": "sha256(sessionKey + sessionSalt)",
  "sk": "sha256(cookie secret)",
  "csrfTokenHash": "sha256(csrf token)",
  "sessionKey": "user_123",
  "dataBr": "<binary: Brotli of the data JSON>",
  "dataBytes": 61,
  "createdAt": 1697712000,
  "lastAccessedAt": 1697712300,
  "expiresAt": 1700304000,
  "ttlInSeconds": 2592000
}
```

The bearer secrets are stored only as hashes; see
[Sessions](./sessions.md#how-the-secrets-are-stored) for why, and why fast
sha256 is the right construction here.

Session data is Brotli-compressed by default, `dataBr` beside its JSON byte
length `dataBytes`; with `session.compression` off, or below its `minBytes`,
the data is a plain `data` map attribute instead. Records written under either
setting read back, so the setting can be switched on or off on a live table.
Sessions configured with `dataRefresh` also carry `dataExpiresAt`.

The key attribute names are configurable with the session's `partitionKey` and
`sortKey` options if your table already uses different ones.

## Capacity

`PAY_PER_REQUEST` is the right default for all four: session and policy traffic
follows request traffic, and none of these tables has a steady baseline worth
provisioning for. Two things to keep in mind if you switch to provisioned
capacity:

- Sessions use consistent reads, which cost twice an eventually-consistent one
  and are bounded by 4KB per read unit. Compressed session data (the default)
  keeps a growing session inside one unit for longer.
- `LambderDdbCache` partitions concentrate traffic when grouped keys are used;
  one DynamoDB partition serves 3000 RCU and 1000 WCU. See
  [What to know before grouping](./ddb-cache.md#what-to-know-before-grouping).

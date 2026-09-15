# LambderDdbRateLimiter

A standalone fixed-window rate limiter backed by DynamoDB. Server-only. It
works with or without the framework: Lambder's
[declarative rate-limit policies](./api-policies.md#rate-limits) are built on
it, and you can call it directly for anything else (a webhook, a background
job, a route).

```typescript
import { LambderDdbRateLimiter } from "lambder";

const limiter = new LambderDdbRateLimiter({
    tableName: "app-policies",
    region: "us-east-1",
});

const exceeded = await limiter.isRateLimited(ctx.ip, { perMin: 5, perHour: 30 });
if (exceeded) {
    // { window: "perMin", limit: 5, resetAt: 1700000060 }
    // Clamped to at least 1, the way the engine's own refusal does it: a
    // window that resets this second would otherwise send "Retry-After: 0".
    refuse("Too many attempts.", { statusCode: 429, headers: { "Retry-After": String(Math.max(1, exceeded.resetAt - nowSeconds)) } });
}
```

## How it works

Each window is a single item counted with a conditional `ADD`, so the increment
and the limit check happen atomically in one request. Windows are evaluated
from smallest to largest and evaluation stops at the first exceeded window,
which keeps blocked requests cheap and spares the larger counters.

**One round trip per window.** A `{ perMin, perHour, perDay }` policy is three
conditional `UpdateItem` calls on the request's critical path, run in sequence
and stopped at the first exceeded window: that is what lets a blocked request
skip the counters behind it, and it is the per-request cost to size latency
against.

**Attempts count, not successes.** A counter checked before the refusing one
keeps its increment; there is no compensating decrement, which would give up
the conditional-ADD atomicity. This matters when stacking policies: order them
so the counter you want charged on a refusal is checked first.

Items carry an `expiresAt` attribute for DynamoDB TTL, so expired counters
clean themselves up.

**A DynamoDB error propagates.** A limiter says whether the caller is over its
limit, and it cannot answer that when it cannot reach the table, so it does not
answer: the error reaches the caller. Whether an unanswerable limit lets the
request through is the application's decision, and for the policies Lambder
runs it is made once, for every limiter, at
[`rateLimits.failOpen`](./api-policies.md#rate-limits), which logs the failure
with the policy and window it was checking. Calling the limiter directly means
making that decision at the call site.

## Windows

A policy is a partial map of window caps. A window that is absent or `0` is not
enforced.

| Window | Length |
| --- | --- |
| `perMin` | 60 seconds |
| `per10Min` | 10 minutes |
| `perHour` | 1 hour |
| `perDay` | 24 hours |
| `perWeek` | 7 days |
| `perMonth` | 30 days |

They are fixed windows, not sliding ones: `perMin` resets at the top of each
wall-clock minute, and `resetAt` is that boundary.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `tableName` | required | DynamoDB table (pk/sk string keys, `expiresAt` TTL attribute) |
| `region` | SDK default | AWS region |
| `keyPrefix` | `"RL"` | Partition key prefix, so counters stay separate from other systems in a shared table |
| `ttlWindowMultiplier` | `2` | Multiplier applied to the window length when setting the item TTL. Must be at least 1 |
| `client` | new client | Supply your own `DynamoDBClient` |
| `now` | `Date.now` | The clock the windows are computed against, for tests |

## Methods

| Method | Returns | Description |
| --- | --- | --- |
| `isRateLimited(trackerKey, policy)` | `false \| { window, limit, resetAt }` | Increment every configured window for `trackerKey` (an IP, session, user id, email) and report whether any is over its limit |

`resetAt` is the epoch second at which the exceeded fixed window resets, which
is what a `Retry-After` header derives from.

## Item layout

```
pk = "<keyPrefix>#<trackerKey>"        e.g. "RL#1.2.3.4"
sk = "<window>#<windowStart>"          e.g. "perMin#1700000040"
```

The `RL#` prefix means the table can be shared with `LambderDdbCache`
(`CACHE#`) and `LambderDdbIdempotencyStore` (`IDEM#`) without key collisions. Keep
sessions in their own table so IAM can be scoped to them separately.

A tracker key is caller data, and a DynamoDB partition key stops at 2048
bytes. Lambder's own policy engine never gets near it: the variable half of a
key (a session key, whatever a custom handler returned) is replaced by
`<kind>:h:<sha256 hex>` once it passes 1024 bytes, so distinct callers stay on
distinct counters and short keys stay readable in the table. Calling the
limiter directly, a key whose `RL#<trackerKey>` passes 2048 bytes is refused
here with an error naming the byte count, before any window is counted: left
to DynamoDB it would come back as a `ValidationException`, which a caller
failing open on storage errors turns into no limit at all.

## Table setup

Same shape as every other Lambder DynamoDB store; see
[DynamoDB tables](./dynamodb-tables.md) for the Terraform, TTL setting and IAM
policy. Required IAM actions on the table: `dynamodb:UpdateItem`.

## Exported types

`LambderDdbRateLimiterOptions`, and from the shared vocabulary
`LambderRateLimiter` (the interface this class implements, one method:
`isRateLimited`), `LambderRateLimitWindow`, `LambderRateLimitPolicy`,
`LambderRateLimitExceeded`, `LambderRateLimitResult`, and the
`RATE_LIMIT_WINDOWS` table the window type derives from.
`LambderMemoryRateLimiter` is the in-memory implementation with the same
semantics, for tests and the mock runtime. Its options are `now` (the clock, so
a test can cross a window boundary without waiting) and `maxEntries`.

`maxEntries` is the one way it differs from the table. A process cannot hold
counters without bound, so it holds at most 100,000 at once and past that the
counters closest to their window's end are dropped: a key whose counter was
dropped starts that window again from zero. It takes one distinct key per
counter to get there, which a limit keyed per IP under a flood from many of
them can do, and the counters with the most life left (the long-window ones)
are the last to go. A deployment where that matters wants this store, whose
counters are not held in the process at all.

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
    failOpen: true,
});

const exceeded = await limiter.isRateLimited(ctx.ip, { perMin: 5, perHour: 30 });
if (exceeded) {
    // { window: "perMin", limit: 5, resetAt: 1700000060 }
    refuse("Too many attempts.", { statusCode: 429, headers: { "Retry-After": String(exceeded.resetAt - nowSeconds) } });
}
```

## How it works

Each window is a single item counted with a conditional `ADD`, so the increment
and the limit check happen atomically in one request. Windows are evaluated
from smallest to largest and evaluation stops at the first exceeded window,
which keeps blocked requests cheap and spares the larger counters.

**Attempts count, not successes.** A counter checked before the refusing one
keeps its increment; there is no compensating decrement, which would give up
the conditional-ADD atomicity. This matters when stacking policies: order them
so the counter you want charged on a refusal is checked first.

Items carry an `expiresAt` attribute for DynamoDB TTL, so expired counters
clean themselves up.

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
| `failOpen` | `false` | Allow the request when DynamoDB itself errors |
| `client` | new client | Supply your own `DynamoDBClient` |

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
(`CACHE#`) and `LambderDdbIdempotency` (`IDEM#`) without key collisions. Keep
sessions in their own table so IAM can be scoped to them separately.

## Table setup

Same shape as every other Lambder DynamoDB store; see
[DynamoDB tables](./dynamodb-tables.md) for the Terraform, TTL setting and IAM
policy. Required IAM actions on the table: `dynamodb:UpdateItem`.

## Exported types

`LambderDdbRateLimiterOptions`, `LambderRateLimitWindow`,
`LambderRateLimitPolicy`, `LambderRateLimitExceeded`, `LambderRateLimitResult`,
and the `RATE_LIMIT_WINDOWS` table the window type derives from.

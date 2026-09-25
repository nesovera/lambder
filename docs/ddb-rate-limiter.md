# LambderDdbRateLimiter

A standalone fixed-window rate limiter backed by DynamoDB. Server-only. It
works with or without the framework: Lambder's
[declarative rate-limit policies](./api-policies.md#rate-limits) are built on
it, and you can call it directly for anything else (a background job, a
script).

Inside a request, charge a named policy with `ctx.rateLimit(policy, key)`
instead of calling the limiter ([Charging a policy from
code](./api-policies.md#charging-a-policy-from-code)): it counts on the same
limiter, and adds what a direct call skips, which is `failOpen`, the key
bounding described below, the standard 429 refusal, and the memory limiter
`lambder/testing` puts under the instance.

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

**A throttle on a flooded key is an answer, not a failure.** DynamoDB
throttles a partition's writes at roughly a thousand a second, and the SDK
retries before it gives up, so a throttle whose reason is the key's range
(`KeyRangeThroughputExceeded` in the error's `ThrottlingReasons`) means the
partition holding the counter is flooded. A partition holds a range of keys,
though, not one: a flood on one address, or a session or cache spike on a
shared table, throttles every counter on the same partition. So the limiter
reads the key's own counts: the throttled window's, and every capped window's
after it, the ones this attempt has not been counted against yet (the ones
before it counted the attempt and let it through). Each is a strongly
consistent `GetItem`, sent in parallel; reads have their own throughput,
which the throttled writes leave alone.

- **Any of them at or over its limit**, and the key is the flood. The limiter
  answers it as over the limit, with a Retry-After of 5 seconds rather than
  the window's reset, whatever `failOpen` says: passed on as a failure, a
  fail-open setting would let the flood through unmetered. A later window
  counts as much as the throttled one: at a minute's rollover a flooding key's
  per-minute counter starts again from zero while its daily cap is spent.
- **Under every limit**, the key is a neighbour of the flood, and the throttle
  is passed on like any other failure, for `failOpen` to decide. A read that
  fails as well passes the throttle on the same way.

A flood repeats, and each repeat would cost the partition another throttled
write and another consistent read, until the reads throttle too and the flood
fails open. So each process remembers, for those 5 seconds, every window it
read at its limit, and refuses the key's next attempts from memory without
touching the table, which also lets the partition recover for its
neighbours. A count only rises within its window, so the table would answer
the same. A key whose read was throttled as well is remembered with the
throttle it was answered with: while its writes stay throttled, its next
attempts skip the read and throw that same error, which
[`rateLimits.failOpen`](./api-policies.md#rate-limits) logs once rather than
once per request. The memory holds at most 10,000 windows, and a neighbour is
never answered from it.

A throttle of the table or the account (provisioned capacity running out, an
on-demand maximum, the account's quota) says nothing about any one partition,
so it is passed on the same way. Answered as over the limit, either would
refuse callers under their limit on every limited endpoint for as long as
something else (a cache refill in a shared table, a traffic spike) kept the
table busy. A local DynamoDB names no throttling reasons, and its throttles are
passed on too. The `@aws-sdk/client-dynamodb` peer dependency starts at
3.868.0, the first version whose errors carry the reasons.

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
| `client` | shared default | Supply your own `DynamoDBClient`. Left out, every DynamoDB store for one region shares one client, so one connection pool |
| `now` | `Date.now` | The clock the windows are computed against, for tests |

## Methods

| Method | Returns | Description |
| --- | --- | --- |
| `isRateLimited(trackerKey, policy)` | `false \| { window, limit, resetAt }` | Increment every configured window for `trackerKey` (an IP, session, user id, email) and report whether any is over its limit |
| `clockMilliseconds()` | `number` | The clock the windows are computed against (the `now` option), which the policy engine reads Retry-After against |

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
`<kind>:h:<sha256 hex>` once it passes 1024 bytes as written into the key
(where each `|` and `\` is escaped to two), so distinct callers stay on
distinct counters and short keys stay readable in the table. Calling the
limiter directly, a key whose `RL#<trackerKey>` passes 2048 bytes is refused
here with an error naming the byte count, before any window is counted: left
to DynamoDB it would come back as a `ValidationException`, which a caller
failing open on storage errors turns into no limit at all.

## Table setup

Same shape as every other Lambder DynamoDB store; see
[DynamoDB tables](./dynamodb-tables.md) for the Terraform, TTL setting and IAM
policy. Required IAM actions on the table: `dynamodb:UpdateItem`, and
`dynamodb:GetItem` for the read on a throttled partition (without it, every
key-range throttle is passed on for `failOpen` to decide).

## Exported types

`LambderDdbRateLimiterOptions`, and from the shared vocabulary
`LambderRateLimiter` (the interface this class implements: `isRateLimited`,
and an optional `clockMilliseconds` for a limiter with a clock of its own,
which the engine reads Retry-After against, Date.now() otherwise),
`LambderRateLimitWindow`, `LambderRateLimitPolicy`,
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

# API policies

Rate limits, authorization guards and idempotency are declared once as named
building blocks and referenced from API definitions with full type inference.
Unknown names are compile errors, and everything is re-asserted at registration
time for plain-JS safety. Each piece is independent and optional.

```typescript
import { initLambder, LambderDdbRateLimiter, LambderDdbIdempotency, lambderGuard, lambderRateLimitKey, refuse } from "lambder";

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    rateLimits: { limiter, policies },
    idempotency: { store, defaultTtlSeconds: 24 * 3600, failOpen: true },
    guards: { captcha, deviceAuth, orgPermission },
});
```

## Request flow

```
session (session APIs)
  → idempotency replay lookup
  → rate limits
  → guards
  → zod validation
  → idempotency claim
  → handler
  → idempotency store
```

The replay lookup runs first on purpose: a completed idempotent request answers
its stored response without burning rate-limit quota or re-running guards (the
original already passed them, and no handler executes either way).

Refusals ride the envelope via `LambderApiError` (429 rate limited, 409
duplicate in flight), carrying the standard `LambderRefusalMessage` shape
unless a policy names its own `errorMessage`, so the caller's
`errorMessageHandler` surfaces them with zero client code. A 429 also carries
`Retry-After` (the exceeded fixed window's reset; `LambderCaller` outcomes
expose it as `retryAfterSeconds`, and the CORS layer lists it in
`Access-Control-Expose-Headers` by default).

Preflight input slices (guard `apiInput` and `guardInput` values, rate-limit
`apiInput` keys) answer a rejection through the same path as the API's own
schema: `setApiInputValidationErrorHandler` when set, otherwise the standard
422 body. One failure, one shape, whichever schema rejected it.

## Rate limits

Declare a limiter instance and named policies. Each policy declares its
windows, what one counter tracks (`per`), and what one budget spans (`budget`).

```typescript
rateLimits: {
    limiter: new LambderDdbRateLimiter({ tableName: "app-rate-limiter", region: "us-east-1", failOpen: true }),
    policies: {
        authPerIp:    { perMin: 5, perHour: 30, per: "ip" },
        writePerUser: { perMin: 30, per: "session" },   // only referable from addSessionApi (enforced at compile time)
        codePerEmail: {
            perMin: 3,
            // ONE combined budget across every API referencing this policy:
            // send + register + reset share the 3/min.
            budget: "perPolicy",
            // apiInput key: derives from the API's OWN payload. Validated
            // before it runs, typed in the handler, and the policy is only
            // referable from APIs whose input schema carries `email`.
            per: lambderRateLimitKey({
                apiInput: z.object({ email: z.string() }),
                handler: (_ctx, { email }) => email.trim().toLowerCase(),
            }),
            errorMessage: { type: "warning", content: "Too many attempts for this address." },
        },
    },
},
```

| Policy field | Values | Meaning |
| --- | --- | --- |
| Window caps | `perMin`, `per10Min`, `perHour`, `perDay`, `perWeek`, `perMonth` | Fixed-window limits; an absent or zero window is not enforced |
| `per` | `"ip"`, `"session"`, or `lambderRateLimitKey({...})` | What one counter tracks. `"session"` is only referable from `addSessionApi` |
| `budget` | `"perApi"` (default), `"perPolicy"` | Whether each referencing API gets its own counter or they share one |
| `errorMessage` | `LambderRefusalMessage` | The refusal body; inherits code `lambder/rate-limited` unless it sets a code |

### Budgets

`"perApi"` gives every referencing API its own counter, so the numbers are a
per-API ceiling and three APIs on a 60/min policy allow one IP 180/min in
total. `"perPolicy"` makes every referencing API share ONE counter. The policy
IS the group: separate shared budgets for, say, user APIs and report APIs are
two policies.

### Referencing and tuning from an API

```typescript
// One name, or a list, checked in order; the first exceeded window refuses.
rateLimit: ["authPerIp", "codePerEmail"],

// Map form: tune a perApi policy for this API. Overrides merge over the
// policy's windows (perMin here, the policy's other windows still apply) and
// errorMessage is overridable too. Window overrides on a perPolicy policy are
// a startup error: one shared counter has one set of limits.
rateLimit: { writePerUser: { perMin: 10 } },
```

### Rate limits count attempts, not successes

Each window is one atomic conditional increment, and a refused request keeps
every increment made before the refusal: the smaller windows of the refusing
policy, every policy listed before it, and all of them when a later guard or
the input validation refuses. There is no compensating decrement (it would give
up the conditional-ADD atomicity and add a write per refusal).

So order stacked policies by which counter you want charged on refusals:
`["authPerIp", "codePerEmail"]` still charges the IP when the per-email cap
refuses, which is the abuse-resistant direction.

The store itself is documented in [Rate limiter](./ddb-rate-limiter.md).

## Guards

A guard is a named authorization check that runs before input validation.
Guards can take a per-API parameter, require a session, consume input, and
RETURN a typed value the handler reads from `ctx.guardData[name]`.

```typescript
guards: {
    captcha: lambderGuard({
        guardInput: z.object({ captchaToken: z.string() }),
        handler: async (ctx, { captchaToken }) => {
            if (!await verifyCaptcha(captchaToken, ctx.ip)) refuse("Verification failed, please retry.");
        },
    }),
    deviceAuth: lambderGuard({
        apiInput: z.object({ deviceToken: z.string() }),
        // Returns a value: the API handler reads ctx.guardData.deviceAuth.
        handler: async (_ctx, { deviceToken }) => await resolveDeviceOrRefuse(deviceToken),
    }),
    orgPermission: lambderGuard({
        session: true,
        // Parameterized: APIs declare guards: { orgPermission: "SOME.PERMISSION" }.
        handler: (ctx, _payload, _res, permission: PermissionString) =>
            requirePermissionOrRefuse(ctx.session, permission),   // return value -> ctx.guardData.orgPermission
    }),
},
```

### Input modes

| Mode | Where the value comes from | Effect on the contract |
| --- | --- | --- |
| `apiInput` | A slice of the API's OWN payload | The API's schema keeps the field; the guard is declarable only where the payload type passes both |
| `guardInput` | The guard's own value, sent separately by the caller via `options.guardInputs` | Made mandatory by the contract, so forgetting it is a compile error at the call site |
| neither | Nothing | Declarable anywhere |

Both are validated before the guard runs and typed inside its handler.

### Referencing guards from an API

```typescript
guards: "captcha",                            // one name
guards: ["captcha", "deviceAuth"],            // a non-empty list, run in order
guards: { orgPermission: "ORDERS.CREATE" },   // a non-empty { name: param } map, run in insertion order
```

Guard results are typed end to end: the handler's `ctx.guardData` carries
exactly the declared guards that return a value, a session guard on a public
API is a compile error (and a startup assert), an apiInput guard is declarable
only where the API's schema carries its fields, and a parameterized guard's
param is typechecked in the declaration.

An empty declaration (`guards: {}` or `guards: []`) is a compile error and a
registration error: it normalizes to zero guards while looking like a
declaration, which is exactly the ambiguity the option exists to remove.

## Requiring an authorization declaration

By default a session API may declare no guards, which reads as "any signed-in
user". Once an app has an authorization vocabulary, that silence is where
defects hide: the guard exists, a new endpoint forgets it, and nothing notices.

### `requireSessionApiGuards`

With `requireSessionApiGuards: true` at creation, `guards` becomes a required
field of every `addSessionApi`: omitting it is a compile error at the
registration site ("Property 'guards' is missing"), and a plain-JS registration
throws. Public APIs are unaffected.

An API that legitimately needs no authorization beyond the session (the
signed-in user's own account, a log-out) declares a named no-op session guard,
so the opt-out is explicit, greppable, and cannot be used on a public API:

```typescript
const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    guards: {
        orgPermission: lambderGuard({ session: true, handler: (ctx, _p, _r, permission: PermissionString) => requireOrRefuse(ctx.session, permission) }),
        // The one opt-out: the session itself is the whole authorization.
        sessionOnly: lambderGuard({ session: true, handler: () => {} }),
    },
    requireSessionApiGuards: true,
});

lambder.addSessionApi("secure.order.create", { input, output, guards: { orgPermission: "ORDERS.CREATE" } }, handler);
lambder.addSessionApi("secure.me.logOut", { input, output, guards: "sessionOnly" }, handler);
lambder.addSessionApi("secure.report.list", { input, output }, handler);              // compile error: which guard?
lambder.addSessionApi("secure.report.list", { input, output, guards: {} }, handler);  // compile error: {} declares no guard
```

### `requirePublicApiGuards`

Public APIs are open by default, and that remains the default. An app whose
public surface has grown past a handful of endpoints can turn
`requirePublicApiGuards: true` on to make each one's openness a written
decision instead of an omission.

Not every public endpoint has a control that can be hoisted into a guard (an
endpoint that checks a password IS the check), so the vocabulary an app
declares here is usually a real guard for what is a genuine precondition, plus
named no-op guards for the rest. The two flags are independent; either or both
may be on.

```typescript
const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    guards: {
        deviceToken: lambderGuard({ apiInput: z.object({ deviceToken: z.string().min(20) }), handler: (_c, { deviceToken }) => requireDevice(deviceToken) }),
        // Anyone may call, and the param records why: `grep "open:"` lists every public door.
        open: lambderGuard({ handler: (_c, _p, _r, _reason: string) => {} }),
        // This endpoint establishes identity; the proof is the handler's own work.
        credentialFlow: lambderGuard({ handler: () => {} }),
    },
    requirePublicApiGuards: true,
});

lambder.addApi("public.device.report", { input, output, guards: "deviceToken" }, handler);
lambder.addApi("public.translations", { input, output, guards: { open: "Static strings already in the bundle." } }, handler);
lambder.addApi("public.login", { input, output, guards: "credentialFlow" }, handler);
lambder.addApi("public.search", { input, output }, handler);   // compile error: open to anyone, or authorized how?
```

## Idempotency

A store instance plus replay defaults. The store may share the rate limiter's
table, since records use an `IDEM#` key prefix.

```typescript
idempotency: {
    store: new LambderDdbIdempotency({ tableName: "app-rate-limiter", region: "us-east-1" }),
    defaultTtlSeconds: 24 * 3600,
    failOpen: true,   // DynamoDB down means execute without dedupe instead of failing
},
```

An API opts in with `idempotency: true` or `{ ttlSeconds }`. Declaring it is a
type error unless the instance was created with an idempotency store.

### Semantics

The client sends an `idempotencyKey` per call (see
[Frontend client](./client.md#idempotency-keys)); generate it once per logical
operation with `LambderCaller.createIdempotencyKey()` and reuse it on retries.

- **Keys must be 16-200 characters and UNGUESSABLE random**; shorter keys
  refuse with 400. On session APIs the scope is session + API name + key; on
  public APIs it is the key itself + API name, deliberately NOT the client IP,
  because the retry idempotency exists for (a timeout followed by a network
  switch) frequently arrives from a new IP.
- **Concurrent duplicates** of an in-flight request refuse with 409.
- **Repeats of a completed request** replay the stored response verbatim until
  the TTL, response headers included, so headers set via `res.setHeader` and
  `res.addHeader` replay too.
- **A crashed original** releases its claim, so a retry actually retries.
- **The replay rule for failures**: RESPONSES are stored and replayed, refusals
  returned as envelopes (`res.api(null, { errorMessage })`) and thrown
  responses (`res.die.*`) included; EXCEPTIONS are not, so a thrown
  `LambderApiError` or `refuse()` releases the claim and a retry re-executes
  and decides afresh.
- **Stored bodies** of 1KB or more are Brotli-compressed by default (the same
  scheme and `compression` option as `LambderDdbCache`: `true`, `false`, or
  `{ minBytes, quality }`, default `{ minBytes: 1024, quality: 5 }`; records of
  either shape read back, so it can be switched on a live table). JSON
  envelopes typically shrink 5-10x, which cuts DynamoDB write cost, and the
  ~350KB item budget applies to the COMPRESSED bytes, so even large responses
  usually stay replayable.
- **Never stored**: responses with status >= 500, bodies over the budget even
  compressed, and responses that set cookies (replaying one request's
  Set-Cookie, session tokens for instance, into another would be wrong; such
  APIs still get in-flight 409 dedupe, just not replays).
- **Claims are owner-checked**, so an original that stalls past the pending
  window can no longer overwrite or delete the claim a retry has since taken.
- Requests without a key execute normally.

The store itself is documented in [Idempotency store](./ddb-idempotency.md).

## A complete example

```typescript
lambder.addApi("public.resetPassword", {
    // captchaToken is NOT declared here: it travels in the separate
    // guardInputs channel, so the guard validates and consumes it and the
    // handler never sees it. `email` IS declared: the codePerEmail key runs
    // in apiInput mode against the API's own payload.
    input: z.object({ email: z.string().email() }),
    output: z.object({ ok: z.boolean() }),
    rateLimit: ["authPerIp", "codePerEmail"],
    guards: "captcha",
}, handler);

lambder.addSessionApi("secure.order.create", {
    input: OrderSchema,
    output: OrderResultSchema,
    rateLimit: { writePerUser: { perMin: 10 } },
    guards: { orgPermission: "ORDERS.CREATE" },
    idempotency: true,   // or { ttlSeconds: 3600 }
}, async (ctx, res) => {
    const { organizationId } = ctx.guardData.orgPermission;   // typed guard output
    // ...
});
```

# API policies

Rate limits, authorization guards and idempotency are declared once as named
building blocks and referenced from API definitions with full type inference.
Unknown names are compile errors, and everything is re-asserted at registration
time for plain-JS safety. Each piece is independent and optional.

```typescript
import { initLambder, LambderDdbRateLimiter, LambderDdbIdempotencyStore, lambderGuard, lambderRateLimitKey, refuse } from "lambder";

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    rateLimits: { limiter, policies, failOpen: true },
    idempotency: { store, defaultTtlSeconds: 24 * 3600, failOpen: true },
    guards: { captcha, deviceAuth, orgPermission },
});
```

## Request flow

```
version floor → signature gate → payload restore
  → rate limits keyed on the request alone (per: "ip")
  → session (session APIs)
  → idempotency replay lookup
  → the remaining rate limits (per: "session", custom keys)
  → guards
  → zod validation
  → idempotency claim
  → handler
  → idempotency store
```

This is `LambderApiPipeline`, the one implementation the Lambda server and
the [mock runtime](./mock.md) both run; see [The API core](./api-core.md).

The replay lookup runs before the policies below it on purpose: a completed
idempotent request answers its stored response without burning that quota or
re-running guards (the original already passed them, and no handler executes
either way).

An `ip`-keyed policy is the exception, and deliberately so: it is checked
before the session read and before the replay lookup, because those reads are
what it exists to bound. A request carrying a bogus session cookie costs a
store scan plus a read per candidate, and a replay costs a store read of its
own, so **a retry does count against an `ip` budget**. Size those policies for
the store traffic a caller may cause, not for the handler runs they allow.

Refusals ride the envelope via `LambderApiRefusal` (429 rate limited, 409
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
    limiter: new LambderDdbRateLimiter({ tableName: "app-rate-limiter", region: "us-east-1" }),
    // or new LambderMemoryRateLimiter() in a test, or your own LambderRateLimiter
    // The limiter being down means allow the request through rather than
    // refuse it, with a console.error naming the policy. Default: true. It
    // lives here rather than on an implementation, so a limiter of your own
    // gets the same behaviour.
    failOpen: true,
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
| `errorMessage` | `LambderAppRefusalMessage` | The refusal body; inherits code `lambder/rate-limited` unless it sets a code |

A custom key is bounded before any limiter sees it: past 1024 UTF-8 bytes the
value your handler returned is replaced by its sha256 (`custom:h:<hex>`, the
api and policy names still readable around it), and `per: "session"` keys are
bounded the same way. Distinct callers stay on distinct counters, and no store
is handed a key longer than its own limit. It is bounded in the engine rather
than in a limiter because a store refuses an over-long key by throwing, and a
throw is what `failOpen` swallows: a 3,000-character payload field would
otherwise turn the whole policy off in silence.

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

List order governs charging only among policies of the same phase, though.
`per: "ip"` policies are checked in their own pass before the session read
(see [Request flow](#request-flow)), so they are always charged first,
whatever position they hold in the list: `["codePerEmail", "authPerIp"]`
charges the IP counter before the per-email cap can refuse, exactly as the
other order does. Declared order is kept inside each phase, which is where the
choice is yours.

The DynamoDB limiter is documented in [Rate limiter](./ddb-rate-limiter.md);
`LambderMemoryRateLimiter` keeps the same windows and semantics in a `Map`, for
tests and the mock runtime. Both implement `LambderRateLimiter`, the one
method the engine calls, as may a limiter of your own.

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
        handler: (ctx, _payload, permission: PermissionString) =>
            requirePermissionOrRefuse(ctx.session, permission),   // return value -> ctx.guardData.orgPermission
    }),
},
```

A guard's handler is `(ctx, input, param)`: the render context (session-typed
when `session: true`), its validated input slice or `undefined`, and the
per-API parameter. A guard says no by throwing, with `refuse()` or a
`LambderApiRefusal`, which the pipeline renders as the structured refusal
envelope; guards build no responses, which is what lets the same engine run
them on the server and in the mock runtime.

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
        orgPermission: lambderGuard({ session: true, handler: (ctx, _p, permission: PermissionString) => requireOrRefuse(ctx.session, permission) }),
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
        open: lambderGuard({ handler: (_c, _p, _reason: string) => {} }),
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
    store: new LambderDdbIdempotencyStore({ tableName: "app-rate-limiter", region: "us-east-1" }),
    // or new LambderMemoryIdempotencyStore() in a test, or your own LambderIdempotencyStore
    defaultTtlSeconds: 24 * 3600,
    defaultPendingTtlSeconds: 300,   // must outlive your longest handler; see below
    failOpen: true,   // the store being down means execute without dedupe instead of failing
},
```

An API opts in with `idempotency: true` or `{ ttlSeconds, pendingTtlSeconds }`.
Declaring it is a type error unless the instance was created with an
idempotency store.

**`pendingTtlSeconds` has to outlive the handler it protects.** A claim exists
so a crashed original does not block retries forever, so it expires on its own,
and the default is five minutes. A Lambda may run for fifteen. If a claim
expires while its own handler is still working, the next retry finds a free
scope and executes the operation a second time, which is the one thing
idempotency exists to prevent. Raise it past your own function timeout, at
creation or per API:

```typescript
lambder.addApi("orders.place", { input, output, idempotency: { pendingTtlSeconds: 900 } }, handler);
```

### Semantics

The client sends an `idempotencyKey` per call (see
[Frontend client](./client.md#idempotency-keys)); generate it once per logical
operation with `LambderCaller.createIdempotencyKey()` and reuse it on retries.

- **Keys must be 16-200 characters and UNGUESSABLE random**; shorter keys
  refuse with 400. On session APIs the scope is session + API name + key; on
  public APIs it is the key itself + API name (plus `callerIdentity` when the
  app supplies one, see below), deliberately NOT the client IP, because the
  retry idempotency exists for (a timeout followed by a network switch)
  frequently arrives from a new IP. Every field is escaped before it is
  joined, so a key containing the separator cannot land in another scope.
- **The key is the whole identity: the payload is not part of it.** Reusing one
  key across two different requests to the same API replays the first answer
  for the second, and never runs the second handler. That is what makes a
  retry safe, and it is also why a key belongs to one logical operation and
  must not be recycled.
- **A replay answers before guards run**, which is what keeps a retry from
  burning rate-limit quota or re-running authorization. On a public API, where
  the scope carries no identity by default, that means **a key is a bearer
  token for its own stored answer**: anyone presenting it gets the response
  back, and the guards that would normally authorize the call are not
  consulted, because there is no handler run to authorize. The unguessability
  requirement above is doing real work, and the 16-character minimum is a
  floor, not a substitute for random.

  If a public API's authorization IS a guard, say who the caller is with
  `callerIdentity`, and the scope carries it:

  ```typescript
  idempotency: {
      store: idempotencyStore,
      // Consulted only on public APIs, which read no session, so there is
      // no ctx.session here to read and the parameter type does not carry
      // one. It sees what the request carries: request.guardInputs,
      // request.payload, request.headers, request.ip. Client data, so
      // guardInputs is Record<string, unknown> and the shape is yours to
      // assert.
      callerIdentity: (ctx, request) => {
          const device = request.guardInputs?.device as { token?: string } | undefined;
          return device?.token ?? null;
      },
  }
  ```

  Read the credential a guard would check, not a value that changes between
  attempts. A single-use token such as a captcha would give the legitimate
  retry a different scope and defeat the replay it needs, which is why this is
  a decision for the app rather than something the engine does on its own.
  It runs once per call, however many times the scope is needed.
  Session APIs need none of this: they already scope per session.
- **Concurrent duplicates** of an in-flight request refuse with 409. A
  duplicate that arrives while the original is still running takes the full
  path (its rate limits are charged and its guards run) before the 409, since
  there is no stored answer to find yet.
- **Repeats of a completed request** replay the stored response verbatim until
  the TTL, response headers included, so headers set via `res.setHeader` and
  `res.addHeader` replay too.
- **A crashed original** releases its claim, so a retry actually retries.
- **The replay rule for failures**: RESPONSES are stored and replayed, refusals
  returned as envelopes (`res.api(null, { errorMessage })`) and thrown
  responses (`res.die.*`) included; EXCEPTIONS are not, so a thrown
  `LambderApiRefusal` or `refuse()` releases the claim and a retry re-executes
  and decides afresh.
- **Stored bodies** of 1KB or more are Brotli-compressed by default (the same
  scheme and `compression` option as `LambderDdbCache`: `true`, `false`, or
  `{ minBytes, quality }`, default `{ minBytes: 1024, quality: 5 }`; records of
  either shape read back, so it can be switched on a live table). JSON
  envelopes typically shrink 5-10x, which cuts DynamoDB write cost, and the
  ~350KB item budget applies to the COMPRESSED bytes, so even large responses
  usually stay replayable.
- **Never stored**: responses with status >= 500, bodies over the budget even
  compressed, binary bodies (a base64 answer from `res.file()` or `res.raw()`,
  which no store carries), and responses that set cookies (replaying one
  request's Set-Cookie, session tokens for instance, into another would be
  wrong; such APIs still get in-flight 409 dedupe, just not replays).
- **The record is the engine's copy**: the headers handed to the store cannot
  be changed by anything the call does afterwards, so a cookie written later
  in the call never lands in a stored answer, whatever a custom store does
  with the object it is given.
- **A store failure is logged**, and `failOpen` (default true) decides what
  happens next: true executes the request as if it carried no key, false
  refuses. The log names the API, never the scope key, which carries the
  caller's identity and their posted key.
- **Claims are owner-checked**, so an original that stalls past the pending
  window can no longer overwrite or delete the claim a retry has since taken.
- Requests without a key execute normally.

The DynamoDB store is documented in [Idempotency store](./ddb-idempotency.md);
`LambderMemoryIdempotencyStore` keeps the same claims, owner tokens and expiry in
a `Map`. Both implement `LambderIdempotencyStore`.

## What is checked, and when

A declaration that cannot mean anything is rejected at creation or at
registration, not left to produce a call that quietly enforces nothing. All of
these throw before a request is ever served:

| Declaration | Why it throws |
| --- | --- |
| `guards: {}`, `guards: []` | Declaring the option is declaring a guard. The empty forms satisfied a `require*ApiGuards` check while running nothing. |
| `guards: {}` or `rateLimits: { policies: {} }` at creation | An option declared with nothing in it configures nothing, and every API that names a guard or a policy would then be told the option was never given. |
| `rateLimit: {}`, `rateLimit: []`, `rateLimit: { policy: undefined }` | Same rule for limits: the API announced one and enforced none. All three are compile errors too, built from the same non-empty construction the guards option uses. |
| A policy with no window | A limiter needs something to count against. |
| A window capped at a negative, fractional, `NaN` or `Infinity` value | A limiter is handed only limits it can act on. This is where the two implementations used to disagree. |
| An override that zeroes the policy's last enforced window | A policy must declare a window; an override may not take it away. Zero is legal on one window of several, since it leaves that one unenforced. |
| `defaultTtlSeconds` or `ttlSeconds` that is not a positive whole number | `NaN` survives every expiry comparison, so an in-memory record with a `NaN` expiry never expires, while DynamoDB rejects the same number outright. |
| A guard whose handler returns a `LambderResponse`, on any branch | A guard authorizes, it does not answer. The returned value would land on `ctx.guardData` and the call would carry on. The builder rejects it at build time, a conditional `LambderResponse | undefined` included, and the engine throws if a cast smuggles one through. |
| A guard built for the other adapter | The handler's context is part of a guard's type, so a server guard in the mock's map (or the reverse) is a compile error rather than a handler reading `ctx.ip` as undefined. |
| An API referencing an unknown guard or policy | Names are resolved at registration, not per request. |
| A `session`-keyed policy or a `session: true` guard on `addApi` | Neither has a session to read. |

A registration that throws does not consume the API name, so catching one and
fixing the declaration reports the real problem rather than a duplicate name.

## A complete example

```typescript
lambder.addApi("public.resetPassword", {
    // captchaToken is NOT declared here: it travels in the separate
    // guardInputs channel, so the guard validates and consumes it and the
    // handler never sees it. `email` IS declared: the codePerEmail key runs
    // in apiInput mode against the API's own payload.
    input: z.object({ email: z.email() }),
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

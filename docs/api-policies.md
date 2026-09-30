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
  → session (endpoints whose guards need one)
  → idempotency replay lookup
  → rate limits keyed per session (per: "session"), and custom keys
    charged before the guards (chargeAt: "beforeGuards")
  → guards
  → zod validation
  → guards placed after validation (runAt: "afterInputValidation")
  → rate limits keyed by a custom key (a payload field), by default
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

A custom-keyed policy runs after the guards by default. Its key is a value
the caller chose (an email address in the payload), so charged before a
captcha guard it would let somebody who never solves the captcha spend a
victim's per-email budget and keep them locked out of reset, register and
send-code; after the guards, only a caller they let through is counted.

The other way round is the right one for a limit on guessing a secret that a
guard or the input schema checks: a one-time code checked by a guard, keyed per
email. Charged after the guard, every wrong guess is refused before it is ever
counted, and the code can be guessed without limit. Such a policy says
`chargeAt: "beforeGuards"`, which charges it with the session-keyed limits,
before the guards and the input schema, so every attempt counts. Anyone may
spend that budget, so pair it with an IP limit. Do not count the attempts a
guard refuses by charging the policy from inside the guard: the right guess
would never be checked against the budget, so guessing continues past the
limit.

An `ip`-keyed policy is the exception the other way, and deliberately so: it
is checked before the session read and before the replay lookup, because
those reads are what it exists to bound. A request carrying a bogus session cookie costs a
store scan plus a read per candidate, and a replay costs a store read of its
own, so **a retry does count against an `ip` budget**. Size those policies for
the store traffic a caller may cause, not for the handler runs they allow.

Refusals ride the envelope via `LambderApiRefusal` (429 rate limited, 409
duplicate in flight), carrying the standard message shape under a framework
code (`lambder/rate-limited`, `lambder/duplicate-in-flight`), in a policy's
own words when it names a `refusal`, so the caller's
`refusalHandler` surfaces them with zero client code. A 429 also carries
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
    // refuse it, with a console.error naming the policy (once per error: a
    // limiter that throws the same one for a run of requests is logged
    // once). Default: true. It lives here rather than on an implementation,
    // so a limiter of your own gets the same behaviour.
    failOpen: true,
    // How much of an IPv6 address one per: "ip" counter covers. Default 64:
    // a subscriber holds at least a /64 and may use any address inside it.
    ipv6PrefixLength: 64,
    policies: {
        authPerIp:    { perMin: 5, perHour: 30, per: "ip" },
        writePerUser: { perMin: 30, per: "session" },   // only referable from an endpoint whose guards need a session (enforced at compile time)
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
            refusal: { type: "warning", content: "Too many attempts for this address." },
        },
    },
},
```

| Policy field | Values | Meaning |
| --- | --- | --- |
| Window caps | `perMin`, `per10Min`, `perHour`, `perDay`, `perWeek`, `perMonth` | Fixed-window limits; an absent or zero window is not enforced |
| `per` | `"ip"`, `"session"`, `lambderRateLimitKey({...})`, or left out | What one counter tracks. `"session"` is only referable from an endpoint one of whose guards needs a session. Left out, the handler that charges the policy supplies the key (see [Charging a policy from code](#charging-a-policy-from-code)), and no API can declare it |
| `budget` | `"perApi"` (default), `"perPolicy"` | Whether each referencing API gets its own counter or they share one |
| `chargeAt` | `"afterGuards"` (default), `"beforeGuards"` | For a custom-keyed policy only: charged after the guards and the input schema passed, or before them, so an attempt they refuse is counted too (a limit on guessing a code a guard checks) |
| `refusal` | `LambderRateLimitMessage` | The refusal's words: its type, title and content. Its code is always `lambder/rate-limited` and it carries no data, so no endpoint has to declare a rate limit as one of its refusals; a code or data here is a compile error and a creation error |

A `per: "ip"` counter keys an IPv6 caller by its /64 (`ipv6PrefixLength`),
since a subscriber, a VPS included, holds at least that much and may rotate
the address inside it on every request; an IPv4-mapped address
(`::ffff:192.0.2.1`) counts as its IPv4 address. `ctx.ip` stays the exact
address.

A custom key is bounded before any limiter sees it: past 1024 UTF-8 bytes, as
written into the key (where each `|` and `\` is escaped to two), the value
your handler returned is replaced by its sha256 (`custom:h:<hex>`, the api and
policy names still readable around it), and `per: "session"` keys are bounded
the same way. Distinct callers stay on distinct counters, and no store
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
// refusal is overridable too. Window overrides on a perPolicy policy are
// a startup error: one shared counter has one set of limits.
rateLimit: { writePerUser: { perMin: 10 } },
```

### Charging a policy from code

A declared limit knows its key from the request. Some keys only a handler
knows: one recipient of an invitation, found after the refusals that mean
nothing is sent; one resource the caller keeps touching, looked up in the
handler. For those, the handler charges a named policy itself:

```typescript
policies: {
    // No `per`: the code charging it passes the key.
    invitesPerRecipient: { perMonth: 3, budget: "perPolicy", refusal: { type: "warning", content: "That address was invited too often." } },
    pairPerIp: { perMin: 5, per: "ip" },
},

const invite = lambder.defineApi({ input, output, guards: "orgAdmin" }, async (ctx) => {
    // ...the refusals that mean nothing goes out come first; then:
    await ctx.rateLimit("invitesPerRecipient", `${orgId}:${email.toLowerCase()}`);
    await sendInvitation(orgId, email);
    return { sent: true };
});

// A handler whose output has its own way of saying "too many" asks instead:
const pair = lambder.defineApi({ input, output, guards: "anyone" }, async (ctx) => {
    const limited = await ctx.isRateLimited("pairPerIp");
    if (limited) return { error: "too-many-attempts", retryAfterSeconds: limited.retryAfterSeconds };
    // ...
});
```

`ctx.rateLimit(policy, key?)` counts one attempt and, when the policy is over,
refuses the request exactly as a declared limit does: a 429 envelope with
`Retry-After` and the policy's `refusal` on an API call, and a plain 429
with the same header and text on a route. `ctx.isRateLimited(policy, key?)`
counts the same way and answers `false`, or the window that refused with its
`retryAfterSeconds`, without refusing anything.

Both go through the instance's own limiter, so `failOpen`, the key bounding
below and `lambder/testing`'s memory limiter all apply to them; calling a
limiter's `isRateLimited` directly skips all three. The policy name is checked
where it is charged: an unknown name is a compile error, a policy without
`per` requires the key, and a `per: "ip"` or `per: "session"` one refuses one,
since the request supplies it. Where the types cannot tell (a hook's or a
guard's context, which does not know the app's policies, or a policy typed as
the general `LambderApiRateLimitPolicyConfig`), the key is optional and the
same rule is checked when the charge runs. A policy keyed by
`lambderRateLimitKey()` is charged only by the APIs that declare it, because
its key is a slice of their payload. The budget is the policy's own:
`"perApi"` counts a charge under the API making it (so it shares the counter a
declared use of the same policy on that API charges), `"perPolicy"` counts
every charge on one counter, and a charge from a route, which has no API,
counts on the policy's counter too. So does a charge from a hook or the API
fallback on a call whose posted name matches no registered API: that name is
the caller's choice, and a fresh one per request would otherwise be a fresh
counter.

### Rate limits count attempts, not successes

Each window is one atomic conditional increment, and a refused request keeps
every increment made before the refusal: the smaller windows of the refusing
policy, every policy listed before it, and the ip and session keyed ones when a
guard or the input validation refuses. A custom key is charged last, once the
guards and the input have passed, unless its policy says `chargeAt:
"beforeGuards"`. There is no compensating decrement (it would give
up the conditional-ADD atomicity and add a write per refusal).

So order stacked policies by which counter you want charged on refusals:
`["authPerIp", "codePerEmail"]` still charges the IP when the per-email cap
refuses, which is the abuse-resistant direction.

List order governs charging only among policies of the same phase, though.
Each kind of key has its own pass (see [Request flow](#request-flow)):
`per: "ip"` before the session read, `per: "session"` after it (with a
custom key charged `"beforeGuards"`), and any other custom key after the
guards. So `["codePerEmail", "authPerIp"]` charges the IP
counter before the per-email cap can refuse, exactly as the other order does,
and a guard that refuses leaves the per-email counter untouched. Declared
order is kept inside each phase, which is where the choice is yours.

The DynamoDB limiter is documented in [Rate limiter](./ddb-rate-limiter.md);
`LambderMemoryRateLimiter` keeps the same windows and semantics in a `Map`, for
tests and the mock runtime. Both implement `LambderRateLimiter`, the one
method the engine calls, as may a limiter of your own.

## Guards

A guard is a named authorization check that runs before input validation, or
after it when it says so (below). Guards can take a per-API parameter, require
a session, consume input, and RETURN a typed value the handler reads from
`ctx.guardData[name]`.

```typescript
guards: {
    captcha: lambderGuard({
        // A token is spent once verified: check the input first (see below).
        runAt: "afterInputValidation",
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

An app made of parts can give `guards` as a list of maps, one per part, and
`rateLimits.policies` the same way: the instance declares every name in the
list, and a name two maps declare is a compile error and a throw at creation.
See [Configuration](./configuration.md#an-app-made-of-parts).

A guard's handler is `(ctx, input, param)`: the render context (session-typed
when `session: true`), its validated input slice or `undefined`, and the
per-API parameter.

A guard declared `session: true` needs a session, and that is also what
makes an endpoint a session endpoint: an endpoint declaring one is read with
its session first, answered `sessionExpired` without one, and its handler's
`ctx.session` is typed present. An endpoint none of whose guards needs a
session is public. The guard is the one place an endpoint says who may call
it, so nothing else states its mode. The context carries `ctx.sessionController` like a handler's, so a
guard that has to rotate or expire a session reaches it without holding the
instance.

### Guards that spend something

Where a guard runs is its `runAt`: `"beforeInputValidation"` (the default) or
`"afterInputValidation"`. Before validation, a caller it refuses learns
nothing about the input and no async refinement in the schema runs for it. A
guard that spends something on the request, a single-use captcha token above
all, is better placed after validation: verified first, the token is gone,
and a request then refused for a mistyped field sends the user back to solve
a new one. `runAt: "afterInputValidation"` runs it after the input schema
passes, and the limits keyed by a custom key after it, so a refused request
neither spends the token nor charges the per-email budget.

The trade-off is the default's reason turned around: the input schema now runs
for callers this guard would refuse. Keep lookups (an "email is free"
refinement) out of that API's schema and in its handler, or the schema becomes
an oracle nobody has to solve a captcha to ask.

Guards run in declared order within each placement. A guard's own input slice
(`apiInput`) is read from the payload as it was sent, before the schema's
transforms, wherever it is placed.

### Typed to the app's session

`lambderGuard()` stands alone, so it cannot know the app's session type, and a
session guard built with it reads `ctx.session.data` as `any`. The same builder
on `initLambder` is bound to the session type the app fixed there:

```typescript
const lambderInit = initLambder<SessionData>();

const orgPermission = lambderInit.guard({
    session: true,
    // ctx.session.data is SessionData, ctx.sessionController a LambderSessionController<SessionData>
    handler: (ctx, _payload, permission: PermissionString) => requirePermissionOrRefuse(ctx.session.data, permission),
});

export const lambderApp = lambderInit.create({ apiPath: "/api", session, guards: { orgPermission } });
```

`lambderInit.rateLimitKey()` is the same for a rate-limit key. The `guards`
option is typed to the app's session too, so a guard built for another session
type is refused where it is put into the map. Guard modules import
`lambderInit` rather than the created instance, which keeps them free of the
import cycle a module that both declares guards and needs the instance would
otherwise have. A guard says no by throwing, with `refuse()` or a
`LambderApiRefusal`, which the pipeline renders as the structured refusal
envelope; guards build no responses, which is what lets the same engine run
them on the server and in the mock runtime.

### Guards that refuse with a code

A guard names the codes it refuses with, from the app's refusal vocabulary,
in its own `refusals` option; they join the codes of every API that declares
the guard, so each such API's contract lists them and its callers narrow on
them (see [Declared refusals](./apis.md#declared-refusals)):

```typescript
const orgPermission = lambderInit.guard({
    session: true,
    refusals: ["missing-permission"],
    handler: (ctx, _payload, permission: PermissionString) => {
        if (!hasPermission(ctx.session.data, permission)) {
            refuse("You are missing a permission.", { code: "missing-permission", notAuthorized: true });
        }
    },
});
```

The guard is built before the instance that holds the vocabulary, so a code it
names is checked where it is put into the guards option at `create()`: a
compile error and a creation error when the vocabulary does not hold it. A
guard raising a code it does not name is a crash when the refusal is
rendered, as an API raising one is. Adding a code to a guard changes the
signature of every API declaring it.

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
API is a compile error (and a startup assert), and a parameterized guard's
param is typechecked in the declaration.

An apiInput guard, or a rate limit keyed by an apiInput slice, on an API whose
input does not carry its fields is a compile error on the `guards` or
`rateLimit` value that names it, and the message names the guards or policies
at fault. The options accept every name the instance declares (so completion
offers them all), and the input is asked about once it is known. Filtering the
names by each API's input while that input is still being inferred would be
rebuilt for every API over every declared guard and policy, and an app's type
check would grow with its APIs times its keyed declarations; asked afterwards,
of the names an API used, it costs each API the same however many keyed
guards and policies the app holds.

An empty declaration (`guards: {}` or `guards: []`) is a compile error and a
registration error: it normalizes to zero guards while looking like a
declaration, which is exactly the ambiguity the option exists to remove.

## Requiring an authorization declaration

By default an endpoint may declare no guards, which reads as "anyone may
call". Once an app has an authorization vocabulary, that silence is where
defects hide: the guard exists, a new endpoint forgets it, and nothing notices.

### `requireApiGuards`

With `requireApiGuards: true` at creation, `guards` becomes a required field
of every `defineApi`: omitting it is a compile error at the declaration
("Property 'guards' is missing"), and a plain-JS registration throws.

An endpoint that legitimately needs no authorization then says so with a
named no-op guard, so every opt-out is explicit and greppable: one whose
session is the whole authorization (the signed-in user's own account, a
log-out) declares a no-op session guard, which also makes it a session
endpoint; one anybody may call declares a no-op guard carrying the reason.
Not every endpoint has a control that can be hoisted into a guard (an
endpoint that checks a password IS the check), so the vocabulary is usually
real guards for genuine preconditions plus named no-op guards for the rest.

```typescript
const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    session,
    guards: {
        orgPermission: lambderGuard({ session: true, handler: (ctx, _p, permission: PermissionString) => requireOrRefuse(ctx.session, permission) }),
        // The session itself is the whole authorization.
        sessionOnly: lambderGuard({ session: true, handler: () => {} }),
        deviceToken: lambderGuard({ apiInput: z.object({ deviceToken: z.string().min(20) }), handler: (_c, { deviceToken }) => requireDevice(deviceToken) }),
        // Anyone may call, and the param records why: `grep "open:"` lists every public door.
        open: lambderGuard({ handler: (_c, _p, _reason: string) => {} }),
        // This endpoint establishes identity; the proof is the handler's own work.
        credentialFlow: lambderGuard({ handler: () => {} }),
    },
    requireApiGuards: true,
});

const orders = lambder.defineApiGroup("orders", {
    create: lambder.defineApi({ input, output, guards: { orgPermission: "ORDERS.CREATE" } }, handler),   // a session endpoint
    report: lambder.defineApi({ input, output }, handler),              // compile error: which guard?
    list: lambder.defineApi({ input, output, guards: {} }, handler),    // compile error: {} declares no guard
});
const account = lambder.defineApiGroup("account", {
    logOut: lambder.defineApi({ input, output, guards: "sessionOnly" }, handler),                        // a session endpoint
    login: lambder.defineApi({ input, output, guards: "credentialFlow" }, handler),                      // public
});
const device = lambder.defineApiGroup("device", {
    report: lambder.defineApi({ input, output, guards: "deviceToken" }, handler),
    translations: lambder.defineApi({ input, output, guards: { open: "Static strings already in the bundle." } }, handler),
});
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

**A first call to an idempotent API costs three store operations**: the replay
lookup (a read that misses), the claim, and the settle that stores the answer.
The lookup runs before the guards and the input validation so that a replay
costs neither, which is why it is not folded into the claim: claiming there
would hold a scope for a request the guards or the schema are about to refuse.
A replay costs one read, and a duplicate of an in-flight original two.

**`pendingTtlSeconds` has to outlive the handler it protects.** A claim exists
so a crashed original does not block retries forever, so it expires on its own,
and the default is five minutes. A Lambda may run for fifteen. If a claim
expires while its own handler is still working, the next retry finds a free
scope and executes the operation a second time, which is the one thing
idempotency exists to prevent. Raise it past your own function timeout, at
creation or per API:

```typescript
const place = lambder.defineApi({ input, output, guards: "signedIn", idempotency: { pendingTtlSeconds: 900 } }, handler);
```

### Semantics

The client sends an `idempotencyKey` per call (see
[Frontend client](./client.md#idempotency-keys)); generate it once per logical
operation with `createIdempotencyKey()` and reuse it on retries.

- **Keys must be 16-200 characters and UNGUESSABLE random**; shorter keys
  refuse with 400. On session endpoints the scope is the user (the session's
  `sessionKey`, which every session of one user shares) + API name + key; on
  public endpoints it is the key itself + API name (plus `callerIdentity` when the
  app supplies one, see below), deliberately NOT the client IP, because the
  retry idempotency exists for (a timeout followed by a network switch)
  frequently arrives from a new IP. Every field is escaped before it is
  joined, so a key containing the separator cannot land in another scope.
- **A key belongs to the request it was first sent with.** The claim keeps a
  fingerprint of that request (its payload as posted, whatever order its
  keys arrive in), and a retry of the same request replays its answer. Guard
  inputs stay out of it: a captcha or proof token is single use, so a genuine
  retry carries a new one. Such a token belongs in `guardInputs`: one carried
  inside the payload (checked by an `apiInput` guard) is part of the
  fingerprint, and a retry with a fresh one reads as another request. The
  same key with another payload is refused with
  `lambder/idempotency-key-reused` (409) rather than handed the first answer:
  a corrected order after a refusal would otherwise get the stored refusal
  for the whole replay window, and an edited retry after a timeout would be
  told the first order went through while only the first was placed. A key
  scope passed as the call's key (see [Frontend
  client](./client.md#idempotency-keys)) moves on by itself once an answer
  settles the operation, so a corrected request is sent under a new key, and
  keeps its key whenever the operation may already have run.
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
  Session APIs need none of this: they already scope per user.

  The identity (and a session API's sessionKey) is bounded the way a custom
  rate-limit key is: past 1024 UTF-8 bytes as written into the scope, it is
  replaced by its sha256 (`i:h:<hex>`), so a long credential can neither push
  the scope past a store's key limit (a throw, which `failOpen` would turn
  into no idempotency for that caller) nor sit in the table as it is.
- **Concurrent duplicates** of an in-flight request refuse with 409. A
  duplicate that arrives while the original is still running takes the full
  path (its rate limits are charged and its guards run) before the 409, since
  there is no stored answer to find yet.
- **Repeats of a completed request** replay the stored response verbatim until
  the TTL, response headers included, so headers the handler wrote with
  `ctx.setResponseHeader` and `ctx.addResponseHeader` replay too.
- **A crashed original** releases its claim, so a retry actually retries.
  The exception is an answer its output schema rejects or throws on
  (`LambderApiOutputValidationError`, an async output schema and a transform
  that throws included): the handler ran to its answer, so the framework's
  crash answer is stored as the key's answer and replayed to retries, rather
  than the operation running again on each one.
- **The replay rule for refusals**: ANSWERS, the outputs a handler returned,
  are stored and replayed; refusals are not. A handler refuses by throwing
  (`refuse()` or a `LambderApiRefusal`), and a throw releases the claim, so a
  retry under the same key runs the handler again, which decides afresh: a
  refusal because an item was out of stock does not outlive the restock.
- **Stored bodies** of 1KB or more are Brotli-compressed by default (the same
  scheme and `compression` option as `LambderDdbCache`: `true`, `false`, or
  `{ minBytes, quality }`, default `{ minBytes: 1024, quality: 5 }`; records of
  either shape read back, so it can be switched on a live table). JSON
  envelopes typically shrink 5-10x, which cuts DynamoDB write cost, and the
  ~350KB item budget applies to the COMPRESSED bytes, so even large responses
  usually stay replayable.
- **Never stored**: responses with status >= 500 (bar the output-schema crash
  above), bodies over the budget even compressed, binary bodies (which no
  store carries, and which an API handler's envelope never is; only an
  adapter's own `exec` over the pipeline can answer one), and responses that
  set cookies, with `ctx.setCookie` or by creating or rotating a session
  (replaying one request's Set-Cookie, session tokens for instance, into
  another would be wrong; such APIs still get in-flight 409 dedupe, just not
  replays).
- **The record is the engine's copy**, both ways: the headers handed to the
  store cannot be changed by anything the call does afterwards, and a replay
  is built from a copy of what the store hands back, so a cookie written
  later in the call, or by the call replaying it, never lands in a stored
  answer, whatever a custom store does with the objects it holds.
- **A store failure is logged**, and `failOpen` (default true) decides what
  happens next: true executes the request as if it carried no key, false
  refuses. The log names the API, never the scope key, which carries the
  caller's identity and their posted key.
- **Claims are owner-checked**, so an original that stalls past the pending
  window can no longer overwrite or delete the claim a retry has since taken.
- **A stored answer is never released.** Storing the answer can fail after it
  landed (a timeout on the write's last attempt), so the engine releases the
  claim after any failed store, and a release lets go of a claim that is
  still pending and nothing else. A store that never landed frees the key for
  the retry; one that landed keeps its answer, and the retry replays it
  rather than running the operation again.
- Requests without a key execute normally.

The DynamoDB store is documented in [Idempotency store](./ddb-idempotency.md);
`LambderMemoryIdempotencyStore` keeps the same claims, owner tokens and expiry in
a `Map`. Both implement `LambderIdempotencyStore`, as may a store of your own.
Such a store keeps the `fingerprint` it is given on the claim and on the
record and reports it back with `"pending"` and `"done"` (a record it cannot
tie to a request reports `""`, which no request matches), and its `abandon()`
releases only a claim that is still pending.

## What is checked, and when

A declaration that cannot mean anything is rejected at creation or at
registration, not left to produce a call that quietly enforces nothing. All of
these throw before a request is ever served:

| Declaration | Why it throws |
| --- | --- |
| `guards: {}`, `guards: []` | Declaring the option is declaring a guard. The empty forms would satisfy `requireApiGuards` while running nothing. |
| `guards: {}` or `rateLimits: { policies: {} }` at creation | An option declared with nothing in it configures nothing, and every API that names a guard or a policy would then be told the option was never given. |
| `rateLimit: {}`, `rateLimit: []`, `rateLimit: { policy: undefined }` | Same rule for limits: the API announced one and enforced none. All three are compile errors too, built from the same non-empty construction the guards option uses. |
| A policy with no window | A limiter needs something to count against. |
| A window capped at a negative, fractional, `NaN` or `Infinity` value | A limiter is handed only limits it can act on, so the memory and DynamoDB limiters cannot disagree about one. |
| An override that zeroes the policy's last enforced window | A policy must declare a window; an override may not take it away. Zero is legal on one window of several, since it leaves that one unenforced. |
| `defaultTtlSeconds` or `ttlSeconds` that is not a positive whole number | `NaN` survives every expiry comparison, so an in-memory record with a `NaN` expiry never expires, while DynamoDB rejects the same number outright. |
| A guard whose handler returns a `LambderResponse`, on any branch | A guard authorizes, it does not answer. The returned value would land on `ctx.guardData` and the call would carry on. The builder rejects it at build time, a conditional `LambderResponse | undefined` included, and the engine throws if a cast smuggles one through. |
| A guard built for the other adapter | The handler's context is part of a guard's type, so a server guard in the mock's map (or the reverse) is a compile error rather than a handler reading `ctx.ip` as undefined. |
| An API referencing an unknown guard or policy | Names are resolved at registration, not per request. |
| A `session`-keyed policy on an endpoint none of whose guards needs a session | A public call has no session to count against. |
| A guard that needs a session on an instance created without the `session` option | There is no session to read. |

Each of these throws where the endpoint is registered (`registerApiGroups`,
or the first call to a lazy group, which a boot check forces with
`loadApiGroups()`). A registration that throws does not consume the API
name, so catching one and fixing the declaration reports the real problem
rather than a duplicate name.

## A complete example

```typescript
export const accountApis = lambder.defineApiGroup("account", {
    resetPassword: lambder.defineApi({
        // captchaToken is NOT declared here: it travels in the separate
        // guardInputs channel, so the guard validates and consumes it and the
        // handler never sees it. `email` IS declared: the codePerEmail key runs
        // in apiInput mode against the API's own payload.
        input: z.object({ email: z.email() }),
        output: z.object({ ok: z.boolean() }),
        rateLimit: ["authPerIp", "codePerEmail"],
        guards: "captcha",
    }, handler),
});

export const orderApis = lambder.defineApiGroup("orders", {
    // orgPermission needs a session, so this is a session endpoint, and the
    // per-session writePerUser limit may apply to it.
    create: lambder.defineApi({
        input: OrderSchema,
        output: OrderResultSchema,
        rateLimit: { writePerUser: { perMin: 10 } },
        guards: { orgPermission: "ORDERS.CREATE" },
        idempotency: true,   // or { ttlSeconds: 3600 }
    }, async (ctx) => {
        const { organizationId } = ctx.guardData.orgPermission;   // typed guard output
        // ...
    }),
});
```

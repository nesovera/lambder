# Testing

Two kinds of test, two entries. `lambder/testing` puts your real server under
test in this process: the instance your app already exports, its real
handlers, guards and policies, over memory stores, with no HTTP and no AWS.
`lambder/mock` serves your contract from mock handlers, for frontend tests and
development with no backend at all (see [The mock runtime](./mock.md)). This
page is mostly about the first, and ends with where everything else about
testing a Lambder app lives.

## A real app under test

```typescript
import { beforeEach, expect, it } from "vitest";
import { lambderTestApp, assertApiFailure } from "lambder/testing";
import { lambder } from "../src/index.js";          // the instance your handler is built from

const app = lambderTestApp(lambder);
beforeEach(() => app.reset());

it("lets only an admin rename the organization", async () => {
    const admin = await app.signIn("user:ada", { userId: "ada", role: "admin" });
    const member = await app.signIn("user:bob", { userId: "bob", role: "member" });
    const guest = app.visitor();

    expect(await admin.api("org.rename", { name: "Acme" })).toEqual({ ok: true });
    assertApiFailure(await member.apiOutcome("org.rename", { name: "Nope" }), "notAuthorized");
    assertApiFailure(await guest.apiOutcome("org.rename", { name: "Nope" }), "sessionExpired");
});
```

That is the whole setup. Nothing about the app changes to make it testable:
no factory to restructure it into, no options to thread through.

`lambderTestApp(lambder)` puts memory stores under the instance **in place**:
a `LambderMemorySessionStore`, a `LambderMemoryRateLimiter` and a
`LambderMemoryIdempotencyStore`, each only where the app configured that
subsystem. In place matters. An app is one module-level instance, and its
handlers and guards close over it (`lambder.getSessionController(ctx)` in a
login handler), so a copy of the instance over other stores would still reach
the original through every one of those closures. Replacing the stores under
the instance everyone already holds is the only version of this that is
correct.

Everything else runs as you wrote it: your guards, your named rate-limit
policies and their `failOpen`, your idempotency settings, your session salt,
cookie options and `dataRefresh`, your hooks and your error handlers. A call
goes through the whole pipeline (version floor, signature gate, rate limits,
session, replay, guards, input validation, your handler) exactly as a
browser's does.

Two consequences worth knowing:

- **The production stores are out of reach.** From the moment the test app
  exists, the instance cannot touch the DynamoDB tables it was created with,
  even by mistake. Importing the app in a test does not touch AWS either: the
  SDK loads on the first table access, and there is none.
- **What the app reaches on its own stays the app's.** Its database, its
  mailer, its own S3 bucket are not Lambder's to replace. Lambder makes
  everything it owns swappable in one call and stays out of the rest.

### Options

Everything is optional. The stores sit where `create()` takes them, naming
only the part a test replaces.

| Option | Default | |
| --- | --- | --- |
| `host` | `"localhost"` | The host visitors browse (`ctx.host`), unless one names its own. An app that scopes its session cookie to a domain needs a host under it; see [Hosts and cookie domains](#hosts-and-cookie-domains) |
| `eventFormat` | `"v2"` | The gateway shape the handler is called with: `"v2"` for an HTTP API or a Function URL, `"v1"` for a REST API. A handler answers both alike through its context, so this matters to code that reads the raw `ctx.event`, and to a suite that wants to run on exactly what production delivers |
| `session.store` | a fresh `LambderMemorySessionStore` | Your own store, to run the suite over something else (DynamoDB Local, say) |
| `rateLimits.limiter` | a fresh `LambderMemoryRateLimiter` | |
| `idempotency.store` | a fresh `LambderMemoryIdempotencyStore` | |
| `files` | the app's own source | A `LambderLocalFileSource` over fixtures, for an app whose production source is S3 or HTTP. An app that serves a local folder needs nothing |

### The test app

| Member | |
| --- | --- |
| `visitor(options?)` | A new simulated browser, a stranger until it signs in |
| `signIn(sessionKey, data, options?)` | A new visitor, already signed in. The session is minted by the app's own session model, so no login endpoint has to exist or be called. `options` are the visitor's, plus `ttlSeconds` |
| `signOut(sessionKey)` | Ends every session of the subject ("log out everywhere"). A visitor signed in as them keeps its cookies, as a browser would, so its next call is answered `sessionExpired` |
| `expireSessionData(sessionKey)` | Marks the subject's session data stale, so the next read renews it through your `dataRefresh` |
| `event(event, context?)` | Hands the handler an event that is not an HTTP request (a schedule, SNS, SQS), which is how an `addAction` handler runs. Resolves to what the action returned; `context` overrides fields of the Lambda context |
| `reset()` | Rewinds sessions, rate-limit counters and replay records in the stores the test app made, the recorded crashes, and every visitor's cookies. For a `beforeEach`. A store you passed in is yours and is left alone |
| `crashes` | Every error the app threw while answering a request since the last reset; see [When the app crashes](#when-the-app-crashes) |
| `sessionStore`, `rateLimiter`, `idempotencyStore` | The stores now under the instance, for assertions; `null` for a subsystem the app never configured |
| `sessionManager` | The app's session manager, to inspect or manipulate sessions directly |
| `handler`, `host` | The instance's handler, and the default host |

The verbs are `LambderMockApp`'s (`signIn`, `signOut`, `expireSessionData`,
`reset`), over the real handlers instead of mock ones. Use one test app per
instance: a second one puts its own stores under the same instance, and the
first stops seeing what happens there.

## Visitors

A visitor is one simulated browser: a cookie jar, an address and a host of
its own. Most tests worth writing involve more than one person, so visitors
are cheap and independent.

```typescript
const visitor = app.visitor({ headers: { "cf-ipcountry": "US" } });

// API calls: a typed LambderCaller's api / apiOutcome, over the real handler
const created = await visitor.api("order.create", { sku: "kettle" }, { idempotencyKey });
const outcome = await visitor.apiOutcome("order.create", { sku: "" });

// Everything else a browser sends
const page = await visitor.request("GET", "/orders?page=2");
expect(page.statusCode).toBe(200);
expect(page.text()).toContain("kettle");
```

| Member | |
| --- | --- |
| `api(name, payload, options?)` | The payload on success, `undefined` on a failure. `LambderCaller.api`, typed by your contract |
| `apiOutcome(name, payload, options?)` | The full outcome, never throwing. Pair it with the [assertions](#asserting-on-outcomes) |
| `request(method, path, init?)` | One HTTP request that is not an API call: a route, a session route, a public file, the index page, a fallback. `init` is `{ query, headers, body }`. The answer comes back decoded (decompressed, header names lowercased) as `{ statusCode, headers, cookies, body, text(), json() }`. Redirects are not followed |
| `signIn(sessionKey, data, options?)` | Signs this visitor in; returns the created session and its raw tokens, as `LambderMockApp.signIn` does |
| `jar` | Its cookies (a `LambderCookieJar`), to inspect or clear. API calls and requests share it, so a session started through one is the session the other presents |
| `caller` | The `LambderCaller` underneath, for code under test that takes one: a frontend store or a shared client module handed this caller talks to the real server in this process |
| `host`, `clientIp` | What the handler sees as `ctx.host` and `ctx.ip` |

| Option | Default | |
| --- | --- | --- |
| `host` | the test app's | |
| `clientIp` | an address no other visitor has | So a `per: "ip"` rate limit counts each visitor apart, as it does for two people in production. Give two visitors the same one to test what a shared address does |
| `headers` | none | Sent with every call and request, under those a single call adds: what a CDN in front of the app writes, or a user agent |
| `apiVersion`, `apiSignatures` | none | A call naming no version is not judged by `minApiVersion`, and one carrying no signature is never gated, so an app with the gate on is testable as is. Pass them to test the gate itself |
| `guardInputsProvider` | none | As on `LambderCaller`: name the guards it covers in the type parameter, `app.visitor<"org">({ guardInputsProvider })`, and calls to APIs whose guard inputs are all covered need no options argument |

An answer's `logList` is not printed by a visitor's caller; it is on the
outcome.

### Hosts and cookie domains

A visitor's jar behaves like a browser's: a cookie whose `Domain` the
visitor's host is not under is dropped. An app that scopes its session cookie
(`session: { cookie: { domain: ".example.com" } }`) therefore needs visitors
on a host that domain covers:

```typescript
const app = lambderTestApp(lambder, { host: "app.example.com" });
```

Left on the default host, `signIn` throws and says so, rather than leaving
every later session call to answer `sessionExpired` with nothing to explain
it. An app serving several hosts gives individual visitors their own:
`app.visitor({ host: "admin.example.com" })`.

## Asserting on outcomes

An outcome is a discriminated union, so a test expecting a refusal has to
narrow before it can read what the refusal carries. `assertApiSuccess` and
`assertApiFailure` do the narrowing through an `asserts` signature, and when
the outcome is not what the test expected they say what it was:

```typescript
import { assertApiSuccess, assertApiFailure, LAMBDER_REFUSAL_CODES } from "lambder/testing";

const outcome = await visitor.apiOutcome("order.create", { sku: "kettle" });
assertApiSuccess(outcome);
expect(outcome.payload?.orderNumber).toBe(1);           // narrowed to the success arm

const invalid = await visitor.apiOutcome("order.create", { sku: "" });
assertApiFailure(invalid, "validation");
expect(invalid.zodError.issues[0]?.path).toEqual(["sku"]);   // narrowed to the arm that carries zodError

assertApiFailure(await visitor.apiOutcome("signup", form), "errorMessage", { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
```

```
Error: Expected the call to fail with reason "notAuthorized", but it was a success carrying {"ok":true}.
```

`assertApiFailure(outcome, reason?, { code?, status? })`: the reason is typed
against the union it was handed, so a misspelled one is a compile error;
`code` is the refusal's `errorMessage.code`; with no reason, any failure
passes. Both throw a plain `Error` and import no test runner, so they serve
vitest, jest and `node:test` alike. They are typed structurally over `ok` and
`reason`, so a `LambderInvokeOutcome` narrows through the same two functions,
and `lambder/mock` exports them too, for frontend tests over the mock app.

## When the app crashes

A handler that throws is answered by your global error handler, or by the
framework's own 500, and either way the answer deliberately says nothing about
what was thrown. That is right for a client and useless to a test, whose
author needs the error and the line it came from. So the test app watches what
the instance throws, without changing what it answers:

- **On the outcome.** A crashed call's outcome is the `server` failure any
  client would get, and through `visitor.apiOutcome` its `error.cause` is the
  error the app threw, stack included. The assertions name it in their
  message, and chain the failure's error as their own `cause`, so a runner
  that prints cause chains (vitest, jest and `node:test` all do) shows the
  handler's stack under the failed assertion:

  ```
  Error: Expected the call to succeed, but it was a failure with reason "server", status 500,
  errorMessage "Internal server error.", error "Request failed: 500 - " (cause: relation "org" does not exist).
  ```

- **On the test app.** `app.crashes` holds every error thrown while answering
  a request since the last reset, whichever way it was answered: a crashed
  route behind `request()`, a call made through `visitor.caller`, a crash your
  error handler turned into a polite envelope. `expect(app.crashes).toEqual([])`
  is how a test says nothing crashed.

Calls running concurrently each get their own crash: a duplicate sent while the
original is in flight is an ordinary idempotency test, and only the call that
crashed carries the cause. A refusal is an answer, not a crash. What an
`event()` rejects with is already in the test's hands, and is not recorded.

## Time

The test app owns no clock. Fake `Date` with your test runner instead:

```typescript
vi.useFakeTimers({ toFake: ["Date"] });                 // vitest
mock.timers.enable({ apis: ["Date"] });                  // node:test

const visitor = await app.signIn("user:ada", data, { ttlSeconds: 60 });
vi.setSystemTime(Date.now() + 61_000);
assertApiFailure(await visitor.apiOutcome("me", {}), "sessionExpired");
```

That moves the framework, the memory stores and your own handlers together,
which a clock belonging to the test app could not: session expiry, a
rate-limit window, a replay TTL and the `Date.now()` in your handler all read
the same time. Fake only `Date`. Faking `setTimeout` as well stalls anything
in your app that waits on a real timer, a database driver included.

## Non-HTTP events

```typescript
const result = await app.event({ source: "aws.events", "detail-type": "Scheduled Event" });
```

The event goes to the handler as Lambda would deliver it, with a Lambda
context filled in, and the first matching `addAction` runs. With no match the
call rejects, as the handler does.

## Testing everything else

| What | How |
| --- | --- |
| A frontend, with no backend | `LambderMockApp` from `lambder/mock`: your contract served from mock handlers over the real pipeline. `mockApp.transport()` on a `LambderCaller`, one caller per browser. See [The mock runtime](./mock.md) |
| Code that invokes another Lambder app | `LambderInvokeCaller.localTransport(handler)` runs the callee's real handler in this process; `lambderMockInvokeTransport(mockApp)` answers from a mock one. See [Calling another lambda](./invoke.md#testing-and-boot-checks) |
| A built deployment package | `LambderInvokeCaller.createEvent({ apiPath, apiName })` is the event a call would send, for a boot check that hands the package an event and asserts it answers. Same section |
| A store of your own | The interfaces are small (`LambderSessionStore`, `LambderRateLimiter`, `LambderIdempotencyStore`), and the memory implementations are the reference for their semantics. Every shipped store takes an injectable `now`. See [The API core](./api-core.md) |
| The wiring, without the test app | `lambderHandlerTransport(handler)` is the in-process transport underneath a visitor, and `lambderCookieJarTransport` the jar over it, for a test that wants the pieces. See [Frontend client](./client.md) |

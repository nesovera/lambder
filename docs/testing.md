# Testing

Two kinds of test, two entries. `lambder/testing` puts your real server under
test in this process: the instance your app already exports, its real
handlers, guards and policies, over memory stores, with no HTTP and no AWS;
and it boots the built deployment package the way Lambda does, before it
ships ([A built deployment package](#a-built-deployment-package)).
`lambder/mock` serves your contract from mock handlers, for frontend tests and
development with no backend at all (see [The mock runtime](./mock.md)). This
page is mostly about the first, and ends with where everything else about
testing a Lambder app lives.

## A real app under test

```typescript
import { afterEach, beforeEach, expect, it } from "vitest";
import { lambderTestApp, assertApiFailure } from "lambder/testing";
import { lambder } from "../src/index.js";          // the instance your handler is built from

const app = lambderTestApp(lambder);
beforeEach(() => app.reset());
app.assertNoCrashesAfterEach(afterEach);            // a test the app crashed in fails, naming the crash

it("lets only the owner rename the store", async () => {
    const owner = await app.signIn("user:ada", { userId: "ada", role: "owner" });
    const clerk = await app.signIn("user:bob", { userId: "bob", role: "clerk" });
    const guest = app.visitor();

    expect(await owner.store.rename({ name: "Acme" })).toEqual({ ok: true });
    assertApiFailure(await clerk.store.rename.outcome({ name: "Nope" }), "notAuthorized");
    assertApiFailure(await guest.store.rename.outcome({ name: "Nope" }), "sessionExpired");
});
```

That is the whole setup. Nothing about the app changes to make it testable:
no factory to restructure it into, no options to thread through.

`lambderTestApp(lambder)` puts memory stores under the instance **in place**:
a `LambderMemorySessionStore`, a `LambderMemoryRateLimiter` and a
`LambderMemoryIdempotencyStore`, each only where the app configured that
subsystem. In place matters. An app is one module-level instance, and its
guards and helpers import it (a guards module that reaches the instance's
stores, a helper that calls `lambder.render`), so a copy of the instance over
other stores would still reach the original through every one of those
imports. Replacing the stores under
the instance everyone already holds is the only version of this that is
correct.

The Lambder classes your app builds itself, beside the instance, go under
test the same way: each `LambderDdbCache`, `LambderDdbOneShotSecretStore` and
`LambderS3UploadBucket` answers from an in-memory twin of its own, and each
`LambderInvokeCaller` from a mock app you name for its function (see [What
the app constructs itself](#what-the-app-constructs-itself)).

Everything else runs as you wrote it: your guards, your named rate-limit
policies and their `failOpen`, your idempotency settings, your session salt,
cookie options and `dataRefresh`, your hooks and your error handlers. A call
goes through the whole pipeline (version floor, signature gate, IP rate
limits, session, replay, session rate limits, guards, input validation,
custom-key rate limits, your handler) exactly as a browser's does.

Two consequences worth knowing:

- **Lambder's tables, buckets and functions are out of reach.** From the
  moment the test app exists, the instance cannot touch the session,
  rate-limit and idempotency tables it was created with, even by mistake, and
  neither can a handler charging a policy through `ctx.rateLimit`, which
  counts on the instance's limiter, nor any cache, one-shot secret store or
  upload bucket the app built, nor an invoke caller it built without a
  transport of its own. Importing the app in a test does not touch AWS
  either: the SDK loads on the first table access, and there is none.
- **What the app reaches without Lambder stays the app's.** Its database, its
  mailer, an AWS client of its own: the suite swaps those as it swaps the
  app's other modules.

### Options

Everything is optional. The stores sit where `create()` takes them, naming
only the part a test replaces. A store, limiter or file source given for a
subsystem the app was created without throws, naming the option: it would be
put under nothing, and the suite meant to run over it would run over no store
at all.

| Option | Default | |
| --- | --- | --- |
| `host` | `"localhost"` | The host visitors browse (`ctx.host`), unless one names its own. An app that scopes its session cookie to a domain needs a host under it; see [Hosts and cookie domains](#hosts-and-cookie-domains) |
| `eventFormat` | `"v2"` | The gateway shape the handler is called with: `"v2"` for an HTTP API or a Function URL, `"v1"` for a REST API. A handler answers both alike through its context, so this matters to code that reads the raw `ctx.event`, and to a suite that wants to run on exactly what production delivers |
| `session.store` | a fresh `LambderMemorySessionStore` | Your own store, to run the suite over something else (DynamoDB Local, say) |
| `rateLimits.limiter` | a fresh `LambderMemoryRateLimiter` | |
| `idempotency.store` | a fresh `LambderMemoryIdempotencyStore` | |
| `files` | the app's own source | A `LambderLocalFileSource` over fixtures, for an app whose production source is S3 or HTTP. An app that serves a local folder needs nothing |
| `invokeMocks` | none | The mock apps that answer the app's invoke callers, by function name: `{ billing: billingMock }`. A caller to a function with none fails every call, naming the function; see [What the app constructs itself](#what-the-app-constructs-itself) |

### The test app

| Member | |
| --- | --- |
| `visitor(options?)` | A new simulated browser, a stranger until it signs in |
| `signIn(sessionKey, data, options?)` | A new visitor, already signed in. The session is minted by the app's own session model, so no login endpoint has to exist or be called. `options` are the visitor's, plus `ttlSeconds` |
| `signOut(sessionKey)` | Ends every session of the subject ("log out everywhere"). A visitor signed in as them keeps its cookies, as a browser would, so its next call is answered `sessionExpired` |
| `expireSessionData(sessionKey)` | Marks the subject's session data stale, so the next read renews it through your `dataRefresh` |
| `event(event, context?)` | Hands the handler an event that is not an HTTP request (a schedule, SNS, SQS), which is how an `addAction` handler runs. Resolves to what the action returned; `context` overrides fields of the Lambda context |
| `reset()` | Rewinds sessions, rate-limit counters and replay records in the stores the test app made, the memory twins under the app's own stores, the recorded crashes and call summaries, and every visitor's cookies. For a `beforeEach`. A store or mock app you passed in is yours and is left alone |
| `crashes` | Every error the app threw while answering a request since the last reset; see [When the app crashes](#when-the-app-crashes) |
| `assertNoCrashesAfterEach(afterEach)` | Installs, through your runner's `afterEach`, a check that fails each test the app crashed in, listing every crash with its stack |
| `memoryTwinOf(store)` | The memory twin under one of the app's own stores (a `LambderMemoryCache`, `LambderMemoryOneShotSecretStore` or `LambderMemoryUploadBucket`), to seed, inspect or drive; see [What the app constructs itself](#what-the-app-constructs-itself) |
| `callSummaries` | The summary of every API call, and every request a route answered, since the last reset, in order: what the app's [`callSummary`](./configuration.md#callsummary) would have written, collected here instead of on stdout |
| `sessionStore`, `rateLimiter`, `idempotencyStore` | The stores now under the instance, for assertions; `null` for a subsystem the app never configured |
| `sessionManager` | The app's session manager, to inspect or manipulate sessions directly |
| `handler`, `host` | The instance's handler, and the default host |

The verbs are `LambderMockApp`'s (`signIn`, `signOut`, `expireSessionData`,
`reset`), over the real handlers instead of mock ones. Use one test app per
instance: a second one puts its own stores under the same instance, and the
first stops seeing what happens there. The classes the app builds itself
belong to the process rather than to an instance, so the test app created
last puts its own twins and invoke mocks under every one of them.

## Visitors

A visitor is one simulated browser: a cookie jar, an address and a host of
its own. Most tests worth writing involve more than one person, so visitors
are cheap and independent.

```typescript
const visitor = app.visitor({ headers: { "cf-ipcountry": "US" } });

// API calls: by group, as on a typed LambderCaller, over the real handler.
// The plain call is the output, and throws on any failure; .outcome is for a
// call the test expects to fail.
const created = await visitor.order.create({ sku: "kettle" }, { idempotencyKey });
const outcome = await visitor.order.create.outcome({ sku: "" });

// Everything else a browser sends
const page = await visitor.request("GET", "/orders?page=2");
expect(page.statusCode).toBe(200);
expect(page.text()).toContain("kettle");
```

| Member | |
| --- | --- |
| `<group>.<action>(payload, options?)`, `<group>.<action>.outcome(payload, options?)` | Every endpoint of your contract by its group: `visitor.order.create(input)` is `api`, and its `.outcome` is `apiOutcome` |
| `api(name, payload, options?)` | The endpoint's output, typed as the output alone, for a test that holds the name as a value. Throws on every failure, so a setup step that is refused stops the test there rather than as an `undefined` read later; see below |
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
| `guardInputsProvider` | none | As on `LambderCaller`: name the guards it covers in the type parameter, `app.visitor<"store">({ guardInputsProvider })`, and calls to APIs whose guard inputs are all covered need no options argument |

An answer's `logList` is not printed by a visitor's caller; it is on the
outcome.

What a failed plain call throws names the endpoint and says what came back,
the way [`assertApiSuccess`](#asserting-on-outcomes) does: the reason, the
status, the refusal with its code and message, and for a crash the error the
app threw, which is also the end of the thrown error's `cause` chain.

```
Error: store.rename: Expected the call to succeed, but it was a failure with reason "notAuthorized", status 200,
refusal {"type":"error","code":"store/not-owner","content":"Only the owner can rename the store."}.
```

The `caller` underneath is a `LambderCaller` as a frontend has one, whose
`api` hands back `undefined` on a failure, so code under test that takes a
caller sees what it sees in the browser.

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
narrow before it can read what the refusal carries. `assertApiSuccess`,
`assertApiFailure` and `assertApiRefusal` do the narrowing through an
`asserts` signature, and when the outcome is not what the test expected they
say what it was:

```typescript
import { assertApiSuccess, assertApiFailure, assertApiRefusal, LAMBDER_REFUSAL_CODES } from "lambder/testing";

const outcome = await visitor.order.create.outcome({ sku: "kettle" });
assertApiSuccess(outcome);
expect(outcome.payload.orderNumber).toBe(1);            // narrowed to the success arm: the output, exactly

const invalid = await visitor.order.create.outcome({ sku: "" });
assertApiFailure(invalid, "validation");
expect(invalid.zodError.issues[0]?.path).toEqual(["sku"]);   // narrowed to the arm that carries zodError

const short = await visitor.order.pay.outcome({ orderId, amount: 250 });
assertApiRefusal(short, "wallet-short");                // one of the endpoint's declared codes
expect(short.refusal.data.available).toBe(100);    // that code's data, typed

assertApiFailure(await visitor.account.signUp.outcome(form), "refusal", { code: LAMBDER_REFUSAL_CODES.rateLimited, status: 429 });
```

```
Error: Expected the call to fail with reason "notAuthorized", but it was a success carrying {"ok":true}.
```

`assertApiFailure(outcome, reason?, { code?, status? })`: the reason is typed
against the union it was handed, so a misspelled one is a compile error;
`code` is the refusal's `refusal.code`, one of the endpoint's declared
codes or the framework's; with no reason, any failure passes.
`assertApiRefusal(outcome, code)` matches the code whichever reason the
refusal arrived under (a refusal flagged `notAuthorized` keeps its code), and
narrows `refusal` to that code's own arm, so a test asserts on the code
and its data rather than on the wording, and a code the endpoint does not
declare is a compile error. All three throw a plain `Error` and import no
test runner, so they serve vitest, jest and `node:test` alike. They are typed
structurally over `ok` and `reason`, so a `LambderInvokeOutcome` narrows
through the same functions, and `lambder/mock` exports them too, for
frontend tests over the mock app.

A refusal whose code the endpoint does not declare, or whose data its code's
schema rejects, is a crash rather than an answer (see
[Declared refusals](./apis.md#declared-refusals)), so a test over the real
server finds one on the first call that raises it, in `app.crashes`.

## When the app crashes

A handler that throws is answered by your global error handler, or by the
framework's own 500, and either way the answer deliberately says nothing about
what was thrown. That is right for a client and useless to a test, whose
author needs the error and the line it came from. So the test app watches what
the instance throws, without changing what it answers:

- **On the outcome.** A crashed call's outcome is the `server` failure any
  client would get, and through a visitor's `.outcome()` (or its `apiOutcome`)
  its `error.cause` is the error the app threw, stack included. The
  assertions name it in their message, and chain the failure's error as their
  own `cause`, so a runner that prints cause chains (vitest, jest and
  `node:test` all do) shows the handler's stack under the failed assertion. A
  visitor's plain call throws the same description, with the endpoint's name
  in front:

  ```
  Error: store.rename: Expected the call to succeed, but it was a failure with reason "server", status 500,
  refusal {"type":"error","content":"Internal server error."}, error "Request failed: 500 - " (cause: relation "store" does not exist).
  ```

- **On the test app.** `app.crashes` holds every error thrown while answering
  a request since the last reset, whichever way it was answered: a crashed
  route behind `request()`, a call made through `visitor.caller`, a crash your
  error handler turned into a polite envelope.
  `app.assertNoCrashesAfterEach(afterEach)` takes your runner's `afterEach`
  and fails every test that leaves a crash there, listing each with its
  stack. It forgets the crashes it reported, so the next test starts clean
  whether or not it resets; a test that crashes the app on purpose asserts on
  `app.crashes` and ends with `app.reset()`.

  ```
  Error: The app crashed answering a request in this test:

  1) Error: relation "store" does not exist
     at StoreTable.rename (src/store/StoreTable.ts:41:13)
     at src/store/storeApis.ts:18:9
  ```

Calls running concurrently each get their own crash: a duplicate sent while the
original is in flight is an ordinary idempotency test, and only the call that
crashed carries the cause. A refusal is an answer, not a crash. What an
`event()` rejects with is already in the test's hands, and is not recorded.

A crash still reaches the app's own `crashes.report`, which runs as written
like everything else the app declared; a reporter that writes to a database
is one more thing the suite gives a test double.

## What the app constructs itself

A Lambder class an app builds itself, as a module-level constant beside the
instance rather than handed to `create()`, is under no instance, so the swap
above cannot reach it. These classes register themselves as they are
constructed instead, and the test app puts an in-process stand-in under each
one in place: whatever holds the class (a module-level constant, the
`LambderOneShotSecrets` built over it, a helper) reaches the stand-in on its
next call, and nothing in the app changes. One built before the test app is
reached, and so is one a handler builds later. Registering costs a deployment
one weak reference per construction and nothing per call, and keeps nothing
alive.

| The app holds | Answers under the test app from |
| --- | --- |
| `LambderDdbCache` | A `LambderMemoryCache` of its own, built with the cache's own `defaultTtlSeconds`, `maxValueBytes` and `now`: the same `LambderCache` rules ([DynamoDB cache](./ddb-cache.md#the-lambdercache-interface-and-the-memory-twin)) |
| `LambderDdbOneShotSecretStore`, under its `LambderOneShotSecrets` | A `LambderMemoryOneShotSecretStore` of its own, the same rules in a map ([One-shot secrets](./secrets.md#one-shot-secrets)) |
| `LambderS3UploadBucket` | A `LambderMemoryUploadBucket` of its own, signing with the bucket's own lifetimes and `uploadMethod`. It checks a post or a PUT the way S3 checks a presigned one, at a `baseUrl` of its own on a host that resolves nowhere ([Tests and the mock runtime](./uploads.md#tests-and-the-mock-runtime)) |
| `LambderInvokeCaller` built without a `transport` | The mock app `invokeMocks` names for its function, through `lambderMockInvokeTransport` under the caller's `apiPath`. For a function with none, every call fails as `network`, with an error naming the function, rather than reaching AWS |
| `LambderDdbRateLimiter`, called directly | Itself; but once the calls are `ctx.rateLimit(policy, key)` they count on the instance's limiter, which the test app already replaced ([Charging a policy from code](./api-policies.md#charging-a-policy-from-code)) |

```typescript
import { beforeEach, expect, it } from "vitest";
import { initLambderMock } from "lambder/mock";
import { lambderTestApp } from "lambder/testing";
import { lambder, receipts, storeHours } from "../src/index.js";
import type { BillingApiContract } from "./billingApiContract.js";

const billingMock = initLambderMock<BillingApiContract>().create({});
billingMock.registerPartial(billingMock.apiSlice(
    billingMock.api("invoice.charge", async ({ payload }) => ({ charged: payload.amount })),
));

const app = lambderTestApp(lambder, { invokeMocks: { billing: billingMock } });
beforeEach(() => app.reset());

it("shows a store's hours from the cache", async () => {
    await app.memoryTwinOf(storeHours).set("hours:nyc-01", "09:00");    // seeded where the app reads
    expect(await app.visitor().store.hours({ storeId: "nyc-01" })).toEqual({ opens: "09:00" });
});

it("takes a receipt the browser uploads", async () => {
    const visitor = app.visitor();
    const ticket = await visitor.receipt.requestUpload(facts);            // a bucket signing PUT tickets
    // The file goes where a browser sends it: the twin answers for the ticket's URL.
    await app.memoryTwinOf(receipts).handleStorageRequest(new Request(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body }));
    expect(await visitor.receipt.confirm(facts)).toEqual({ verified: true });
});
```

`memoryTwinOf(store)` hands back the twin under one of those stores, typed as
the twin it is, to seed, inspect or drive, and `reset()` empties every twin.
A frontend running its upload flow against the app reaches the bucket's twin
through MSW (`lambderMockUploadMswHandler`) or a fetch stub.

A caller given its own `transport` keeps it: it reaches what its transport
reaches, which its author chose, so `LambderInvokeCaller.localTransport(callee.getHandler())`
still runs a callee's real handler in this process ([Calling another
lambda](./invoke.md#testing-and-boot-checks)). The stores answer from their
twins through their own members, so a method taken off one before the test
app existed (`const readHours = storeHours.get.bind(storeHours)`) keeps the
class's own and reaches the table.

## Time

The test app owns no clock. Fake `Date` with your test runner instead:

```typescript
vi.useFakeTimers({ toFake: ["Date"] });                 // vitest
mock.timers.enable({ apis: ["Date"] });                  // node:test

const visitor = await app.signIn("user:ada", data, { ttlSeconds: 60 });
vi.setSystemTime(Date.now() + 61_000);
assertApiFailure(await visitor.account.me.outcome({}), "sessionExpired");
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

## A store of your own

A store an app writes over its own database (sessions in Postgres, one-shot
codes in columns it already has) has to keep the rules the engines rely on,
and the compiler checks a method's signature, not what it does. The rules are
exported as suites, one per interface, which register their cases with your
runner's own `it` and `expect`:

| Suite | Interface |
| --- | --- |
| `lambderSessionStoreConformance` | `LambderSessionStore` |
| `lambderIdempotencyStoreConformance` | `LambderIdempotencyStore` |
| `lambderRateLimiterConformance` | `LambderRateLimiter` |
| `lambderOneShotSecretStoreConformance` | `LambderOneShotSecretStore` |
| `lambderCacheConformance` | `LambderCache` |
| `lambderCacheStorageConformance` | `LambderCacheStorage`, the storage under `LambderStorageBackedCache` |

```typescript
import { describe, it, expect } from "vitest";
import { lambderOneShotSecretStoreConformance } from "lambder/testing";

describe("TicketCodeStore", () => {
    lambderOneShotSecretStoreConformance({
        it, expect,
        // A store holding nothing under either scope, once per case.
        create: async () => { await emptyTicketCodes(); return new TicketCodeStore(pool); },
        scopes: [ticketA.id, ticketB.id],
        kinds: { code: "ticketCode" },
        meta: [{}, {}],
    });
});
```

Lambder's own memory and DynamoDB stores run through the same suites, so a
store that passes them behaves as the ones the rest of the framework was
tested against. Each case builds its store with `create`, which is handed the
case's clock as `now` (epoch milliseconds): a store that judges time itself
must read it from there, because the clock starts at a fixed moment and moves
only when a case moves it. That moment is far in the future (2100-01-01), so
a store over a database that deletes expired rows itself (a DynamoDB TTL
attribute, Redis's `EXPIREAT`) runs every suite with that deletion on: nothing
a case writes has expired by the world's clock, and a record counts as
expired only when the store says so. Nothing in the suites depends on a
runner beyond a jest-style `expect` (vitest, jest and bun's all fit). The
races are real `Promise.all` calls, so run a store over a database that can
hold two connections at once, or its races are only ever run one after the
other.

The one-shot suite takes what a store over existing rows needs in place of
the defaults: two `scopes` it can hold (rows that exist), the kind its columns
keep for each shape it holds (`kinds: { code?, token? }`), the `meta` they
keep, and the `lifetimeSeconds` it derives an expiry from. The cases run once
per shape named: for codes, the ones about counting tries; for tokens, the
ones about finding a record by its digest and about two scopes never sharing
one.

A cache over your own table is usually a `LambderCacheStorage` handed to
`LambderStorageBackedCache` ([DynamoDB cache](./ddb-cache.md#a-cache-over-your-own-storage)),
and it takes both cache suites: the storage suite over the storage itself,
and the cache suite over the cache built on it.

```typescript
import { describe, it, expect } from "vitest";
import { LambderStorageBackedCache } from "lambder";
import { lambderCacheConformance, lambderCacheStorageConformance } from "lambder/testing";

const emptied = async () => { await pool.query("delete from cache_entry"); return cacheEntryTable; };

describe("cacheEntryTable", () => {
    lambderCacheStorageConformance({ it, expect, create: emptied });
});

describe("storeCache", () => {
    lambderCacheConformance({ it, expect, create: async ({ now }) => new LambderStorageBackedCache({ storage: await emptied(), now }) });
});
```

The storage suite hands its storage no clock, since a storage judges no time
itself: every case asks about the second the clock starts at and writes
expiries around it. The cache suite's cases hold a cache to what code typed
against `LambderCache` can see in one process; `LambderDdbCache`'s lease
across containers is its own to test.

## A built deployment package

Everything above runs your source in the test's own process. What Lambda runs
is something else: the assembled deployment package, a bundle and whatever
the bundler left external, loaded by bare node. The faults that live in that
difference pass every test above. A CommonJS dependency that reads
`__dirname` at module scope, inlined into an ESM bundle, imports cleanly
under a test runner that shims it and dies under node. A dependency left
external and never copied into the package resolves in a test from the
project's install. A chunk the bundle loads lazily fails on the first request
that reaches it.

`bootLambdaPackage` boots the package the way Lambda boots it, for a test or a
compile step between packaging and deploying:

```typescript
import { expect, it } from "vitest";
import { assertApiFailure, assertApiSuccess, bootLambdaPackage, LAMBDER_REFUSAL_CODES } from "lambder/testing";

it("boots the built package and answers an API call", async () => {
    const boot = await bootLambdaPackage({
        packageDir: "build/server",                   // the directory that becomes the zip
        calls: [{ api: "status.ping" }, { api: "orders.noSuchAction" }],
        env: { TABLE_PREFIX: "test" },                // what the function's configuration sets
    });

    expect(boot.ok, boot.error).toBe(true);
    assertApiSuccess(boot.calls[0]!.outcome!);
    // A lazy group loads on a call to an action it does not have, which then touches nothing.
    assertApiFailure(boot.calls[1]!.outcome!, "refusal", { code: LAMBDER_REFUSAL_CODES.apiNotFound });
    expect(boot.measurements!.importMs).toBeLessThan(500);
}, 60_000);
```

It starts a fresh node process with the package directory as its working
directory, and nothing of the test's module graph, loaders or environment in
it: the process sees `PATH` and the `env` you pass, as a function sees the
variables its configuration sets and not `NODE_ENV=test`. It imports the
handler module and measures what that cost, then hands the handler each call
in turn, in that one process, as a warm function receives them, so whatever
a call loads on first use stays loaded for the ones after it. A call is either
an API call, `{ api: "group.action", payload? }`, which becomes the event a
gateway delivers for it (or another function's invoke, with `invoke: true`),
or `{ event }`, handed over as it is: a schedule, a queue message, a page
request written out by hand. The answers come back through JSON, as Lambda
returns them.

### Imports are held to the package

Every import the package makes by a bare name or a relative path has to
resolve inside the package directory. On Lambda the package sits in a
directory with no `node_modules` above it, but on your machine it usually
sits inside the project, and node would find a dependency the package does
not carry in the project's install by walking up, so the boot would pass and
the deployment fail. Here that import fails the boot instead, naming the
module and where it resolved. `require` is held to the same rule as `import`.
An absolute import (a layer under `/opt`) names a place on the function's
own filesystem and is left alone.

The exception is what the Lambda runtime supplies itself. The Node.js runtimes
ship the AWS SDK v3, and the [README](../README.md) advises leaving it out of
the deployment package, so a package built that way cannot import on its own
anywhere but on Lambda. Rather than pad it with the SDK just to check it,
those imports resolve from an install outside the package: `runtimeModules`
(default `["@aws-sdk"]`) from `runtimeModulesFrom` (default the working
directory, normally the project's root, whose install has the SDK as a dev
dependency). Nothing else is redirected, so a dependency that is really
missing still fails. A package that carries its own copy of a runtime module
uses it, as it does on Lambda. Anything else a function gets from its
environment rather than its package, a layer's packages for instance, is
named in `runtimeModules` the same way, with `runtimeModulesFrom` pointing at
an install that has it.

### Boot options

Only `packageDir` is required.

| Option | Default | |
| --- | --- | --- |
| `packageDir` | | The assembled package: the directory that becomes the zip, with its production dependencies installed, if it has any |
| `handler` | `"index.handler"` | The handler as the function's configuration names it: the module's path without its extension, a dot, the export. The module is the first of `.js`, `.mjs` and `.cjs` that exists, as on Lambda |
| `calls` | none | What the handler receives, in order. With none, the package is only imported |
| `apiPath` | `"/api"` | Where the server takes API calls, for the calls given as `api` |
| `host` | `"localhost"` | The Host an API call's event names |
| `apiVersion` | none | The version an API call's envelope carries, for a server with a version floor |
| `invoke` | `false` | Send API calls as another function's invoke rather than as a browser's request through a gateway |
| `runtimeModules` | `["@aws-sdk"]` | Package names and scopes the runtime supplies |
| `runtimeModulesFrom` | the working directory | The directory they resolve from |
| `env` | none | The process's environment beside `PATH` |
| `nodeFlags` | none | Node's options, such as the heap sizes Lambda starts the function with for its memory, so the time and memory measured are the function's |
| `importTimeoutMs` | `30000` | How long starting the process and importing the handler module may take |
| `callTimeoutMs` | `30000` | How long each call may take; `getRemainingTimeInMillis` counts down from it |

### What a boot reports

It asserts nothing; the result says what happened. `ok` is true when the
package imported and every call was answered. Otherwise `phase` says where it
stopped: `"import"` (the module threw while loading, an import was not in the
package, the process died or ran out of time before the import finished) or
`"handler"` (a call threw, ran out of time, or the process died during it,
with `failedCall` naming the call). `error` is ready to print: the phase or
the call, the error's stack with its causes, and the end of the process's
output when the process died.

| Field | |
| --- | --- |
| `calls` | One per call the handler answered, in order: `name` (the endpoint, or the event's `name`, default `"event N"`), `returned` (what the handler returned), `status` (when it answered with an HTTP response) and, for an API call, `outcome`: what a caller reads off the answer, for `assertApiSuccess`, `assertApiFailure` and `assertApiRefusal` |
| `measurements` | `importMs`, importing the handler module and everything it imports statically, which is what a cold start pays before its first request; and `rssBytes`, the process's memory once that finished. Both measured in the process that loaded the package and nothing before it |
| `output` | What the process wrote to stdout and stderr |

What is not the package's doing throws rather than booting: a `packageDir`
that is not a directory, a `handler` naming no module there or no function
that module exports, an API call that names no endpoint, an option out of
range. It needs Node 22.15 or later, for the synchronous module hooks that
hold the imports.

## Testing everything else

| What | How |
| --- | --- |
| A frontend, with no backend | `LambderMockApp` from `lambder/mock`: your contract served from mock handlers over the real pipeline. `mockApp.transport()` on a `LambderCaller`, one caller per browser. See [The mock runtime](./mock.md) |
| Code that invokes another Lambder app | `LambderInvokeCaller.localTransport(handler)` runs the callee's real handler in this process; `lambderMockInvokeTransport(mockApp)` answers from a mock one. See [Calling another lambda](./invoke.md#testing-and-boot-checks) |
| A built deployment package | `bootLambdaPackage`, above. To hand a package an event some other way, `LambderInvokeCaller.createEvent({ apiPath, apiName })` is the event an invoke would send. See [Calling another lambda](./invoke.md#testing-and-boot-checks) |
| A store of your own | The conformance suites above, for the session, idempotency, rate-limit and one-shot secret stores, a cache, and the storage under `LambderStorageBackedCache`. Rather than implementing `LambderCache`, write a `LambderCacheStorage` over your own table and hand it to `LambderStorageBackedCache`, which brings the cache's rules itself ([DynamoDB cache](./ddb-cache.md#a-cache-over-your-own-storage)). See [The API core](./api-core.md) |
| The wiring, without the test app | `lambderHandlerTransport(handler)` is the in-process transport underneath a visitor, and `lambderCookieJarTransport` the jar over it, for a test that wants the pieces. See [Frontend client](./client.md) |

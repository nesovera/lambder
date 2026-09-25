# The mock runtime (LambderMockApp)

`lambder/mock` serves a typed API contract from mock handlers, in a browser
during development and in Node during tests, with no backend. It is not an
imitation of the server: `LambderMockApp` runs the same `LambderApiPipeline`
the Lambda server runs (see [The API core](./api-core.md)), over in-memory
stores, with mock handlers where the server has app handlers and mock guards
where it has app guards. The envelope, the refusals, sessions and their
cookies, guards, rate limits, idempotency and the signature gate are therefore
the real thing, and "the mock behaves like the server" is a consequence of the
code's shape rather than a claim a test suite defends.

The entry is browser-safe like `lambder/client`, and never part of a
production bundle by construction: nothing else imports it.

## Setup

```typescript
import { initLambderMock, refuse } from "lambder/mock";
import type { ApiContractType, SessionData } from "./backend/handler";   // type-only import
import { z } from "zod";

const mock = initLambderMock<ApiContractType, SessionData>();

export const mockApp = mock.create({
    apiVersion: "1.4.0",                        // stamped on every answer, as on the server
    apiSignatures,                              // optional: the generated map, so a stale signature is refused as on the server
    latency: { min: 20, max: 90 },              // optional
    sessions: true,                             // the real session model over a memory store
    rateLimits: { policies: { authPerIp: { perMin: 5, per: "ip" } } },   // memory limiter
    idempotency: true,                          // memory store
    guards: {
        orgPermission: mock.guard({
            guardInput: z.object({ organizationId: z.uuid() }),
            session: true,
            handler: (ctx, { organizationId }, permission: Permission) => {
                const member = ctx.session.data.memberships.find((m) => m.organizationId === organizationId);
                if (!member) refuse("You do not belong to this organization.", { code: "app/not-a-member", notAuthorized: true });
                if (!member.permissions.includes(permission)) refuse("Not allowed.", { notAuthorized: true });
                return member;   // lands typed on ctx.guardData.orgPermission
            },
        }),
        captcha: mock.guard({ guardInput: z.object({ token: z.string() }), handler: () => {} }),
        sessionOnly: mock.guard({ session: true, handler: () => {} }),
    },
});
```

`initLambderMock` is curried for the same reason `initLambder` is: the
contract and session types are fixed first, and the guard map and the
rate-limit policies are inferred from the options. `mock.guard` is
`lambderGuard` bound to the mock's contexts: a mock guard has the server
guard's shape (`apiInput` or `guardInput` or neither, `session`, a typed param,
a typed return that lands on `guardData`) and runs through the same engine.

Every option is off unless present, so `mock.create({})` answers calls from its
registry and nothing else. Four options stop being optional once the contract
needs them: `guards` when it declares guard names, `sessions` when it has a
session endpoint, `idempotency` when an endpoint declares idempotency, and
`rateLimits` when an endpoint references a policy. A guard the map leaves out
cannot run, so the mock would answer 200 where the server answers
`notAuthorized`; an entry that needs one of the other three cannot be
registered, so leaving the option out is a compile error rather than a throw
when the registry loads.

| Option | Default | Description |
| --- | --- | --- |
| `apiVersion` | none | Stamped on every answer's envelope, as the server's option is |
| `minApiVersion` | none | The version floor, as on the server: a call naming a lower `version` answers `versionExpired` whatever its signature says |
| `apiSignatures` | none | The generated signature map, as the server's option is: a call whose signature is not the map's entry for its endpoint answers `versionExpired`; without it every signature passes |
| `latency` | `0` | Milliseconds, a `{ min, max }` range, or `(apiName) => number` |
| `sessions` | off | Required when the contract has a session endpoint. `true`, or `{ store?, sessionSalt?, ttlSeconds?, crypto?, dataRefresh?, enableSlidingExpiration?, slidingWriteIntervalSeconds?, tokenCookieKey?, csrfCookieKey?, cookieOptions? }` |
| `rateLimits` | off | Required when an endpoint references a policy. `{ policies, limiter?, failOpen? }`: the same policies the server declares, over `LambderMemoryRateLimiter` unless a limiter is given, checked against the contract (below). `failOpen: false` refuses a call whose limiter threw instead of letting it through |
| `idempotency` | off | Required when an endpoint declares idempotency. `true`, or `{ defaultTtlSeconds?, defaultPendingTtlSeconds?, failOpen?, store?, callerIdentity? }`: the server's own options, `callerIdentity` bound to the mock call context without its session, since it runs on public endpoints alone |
| `guards` | none | The mock guard map; required whenever the contract declares a guard name, and checked against the contract (below) |
| `cookieHost` | the page's host, else `localhost` | The host this runtime's cookies belong to: what `signIn` plants them under, what the transport's jar sends them to, and what a call naming no `siteHost` is read as arriving at |
| `maxRequestPayloadBytes` | `20_000_000` | Ceiling on what a compressed request payload may restore to |
| `defaultClientIp` | `127.0.0.1` | The IP a call carrying none is read as; a transport may name its own, and the MSW adapter reads the same default |
| `callLogSize` | `200` | How many completed calls `mockApp.calls` keeps |
| `revealHandlerErrors` | `true` | Answer a thrown handler with the message it threw rather than the server's "Internal server error." |
| `onReset` | none | Called at the end of `reset()`, so the app rewinds its own data |
| `onInvalidInput` | none | `(zodError, ctx) => ({ payload?, config?, statusCode? }) \| null`: the answer to an input that fails its schema, for a server app that sets `setApiInputValidationErrorHandler`. The same answer as data, `res.api(payload, config)` with its status (200 unless named); `null` answers the standard 422 |

A misspelled option is a compile error, nested ones included: `idempotency:
{ failOpn: false }` and `rateLimits: { policies: { p: { budgt: "perApi" } } }`
are refused at the key rather than dropped in silence, which would leave the
control they name switched off.

### The guard map and the policies are checked against the contract

`guards` must name every guard any endpoint of the contract declares, and for
every guard the contract knows in `guardInput` mode its schema must parse to
what the server inferred. A guard a public endpoint names may not require a
session. A missing name, a schema that parses to something else, or a session
guard where a public endpoint names it fails at the option. Guards the
contract does not declare may be added freely.

`rateLimits.policies` is held to what the server's own policies were held to
when it registered the same endpoints: it names every policy any endpoint of
the contract references, a policy a public endpoint names is not keyed
`per: "session"`, and a policy whose windows an endpoint overrides keeps the
`perApi` budget. So a policy added on the server and not to the mock, or a
mock copy that differs from the server's where it matters, fails at the
option rather than when the registry loads. Policies the contract does not
reference may be added freely.

## The registry

Entries carry their name, so a wrong mode, a stray name or a missing guard
declaration is reported at the entry that wrote it:

```typescript
export const userMocks = mockApp.apiSlice(
    mockApp.publicApi("user.get", async ({ payload }) => ({ id: payload.userId, name: "Ada" })),

    mockApp.sessionApi("order.create", {
        guards: { orgPermission: "ORDERS.CREATE" },   // restated, pinned to the server's declaration
        idempotency: true,
        handler: async ({ payload, session, guardData }) => {
            return { orderId: "o_1", organizationId: guardData.orgPermission.organizationId, ...payload };
        },
    }),

    mockApp.notMocked("admin.runSignedQuery", "operator endpoint, no client calls it"),
);

mockApp.register(userMocks, billingMocks, adminMocks);   // exhaustive over the contract, no overlaps
```

`publicApi` mocks an `addApi` endpoint and `sessionApi` an `addSessionApi`
one; the pipeline fetches the session before a session handler runs and
answers `sessionExpired` without one. An entry is a bare handler only where
the contract declares nothing for the endpoint, and the options form wherever
it declares guards, a rate limit or idempotency: the bare handler is the form
that carries no restatement at all, so it is unavailable exactly where one is
owed. `notMocked` and `sessionNotMocked` register an endpoint
deliberately left without a mock: the call runs the protocol steps that precede
dispatch (the signature gate, the compressed-payload restore, and for
`sessionNotMocked` the session read) and then answers a refusal coded
`lambder/not-mocked` carrying the reason, so the client can say "not mocked
yet" rather than "unknown error", and a stale client still hears
`versionExpired` exactly as it would from the server.

The two are separate because the mode decides which of those steps run, and
nothing at runtime can recover it: the contract is a type. Declaring a session
endpoint with `notMocked` would switch its session read off, so a call with no
session would answer "not mocked" where the server answers `sessionExpired`.
Both go through the same registration checks the mocked builders do, so
`sessionNotMocked` on a mock without the `sessions` option fails where it is
written rather than 500ing at the first call.

### The rest of the contract, for an app adopting the mock

A contract is usually larger than the mocks written for it on the first day,
and `register()` is exhaustive, so adoption would mean one `notMocked` entry
per endpoint nobody has got to yet. One rest entry says it once, as an
argument to the same call:

```typescript
mockApp.register(userMocks, billingMocks, mockApp.restNotMocked("not mocked yet"));
```

It is an argument rather than a mode of the app, and it satisfies the
completeness clause alone: the explicit slices are checked exactly as they
are without it, so a name the contract does not declare and an endpoint
mocked in two slices are still compile errors. A call to an endpoint no slice
covers then answers the same `lambder/not-mocked` refusal `notMocked`
answers, carrying this reason, and is recorded with the outcome `notMocked`
rather than `unknownApi`. Registering the endpoint later, through
`registerPartial` in a test, takes it back from the rest. `reset()` keeps the
rest entry, as it keeps every registration, and a second one, in the same
call or in a later one, throws the way a duplicate name does.

The one thing it cannot do is the session read. Its answer is processed as a
public endpoint: the steps before dispatch still run, so a stale client still
hears `versionExpired` (given the signature map) and a compressed payload
still reaches the events, but
nothing reads the session, because the mode of a name nothing registered is
not knowable at runtime. That is the same reason `notMocked` and
`sessionNotMocked` are two builders, arriving where there is no builder to
say it in. So a signed-out call to an unmocked session endpoint answers "not
mocked" where the server answers `sessionExpired`; where that difference
matters for an endpoint, declare that one with `sessionNotMocked` and leave
the rest to the rest entry. The `mode` on the event and the call-log row is
`null` for the same reason: the answer is public, the endpoint is unknown.

A rest entry and the MSW adapter's `onUnmocked: "passthrough"` are
alternatives, and the rest entry wins: it leaves the runtime with an answer
for every name, so nothing is unmocked there and nothing is handed on to the
network. Take the rest entry when there is no backend to reach, and the
passthrough when the endpoints without mocks are served by a real one.

What the compiler catches, with the contract still a type-only import:

- **completeness**: `register()` fails when any endpoint of the contract has
  no entry, naming the missing ones, unless a `restNotMocked` entry stands
  for them;
- **no strays**: a name the contract does not have fails at the builder, and
  a slice keyed under one fails at `register()`;
- **a countable list**: `register()` takes its slices as arguments or as a
  list declared `as const`. An array of slices (`const slices = [a, b]`
  without it) is refused, because its length is not in its type and none of
  these checks can be made over it;
- **mode**: `publicApi` on a session endpoint fails at the name, and the
  reverse;
- **guards**: required wherever the contract declares any, and type-equal to
  the server's own declaration, so a guard added, removed or re-parameterised
  on the server breaks the mock's compile. Not only where the contract
  carries `guardInputs`: the restatement is the only thing that tells the
  runtime which guards to run, and the guards that take no client input are
  exactly the "may this role call it" ones, so a droppable field there means
  a mock answering 200 where the server answers `notAuthorized`;
- **rateLimit and idempotency**: required wherever the contract declares
  them, and pinned to the server's declaration, which is also what closes the
  bare-handler form for those endpoints. Optional, they were the droppable
  half of the check they exist for: an entry that leaves one out applies no
  limit and takes no claim, so the mock answers 200 where the server answers
  429 or a replay;
- **payloads and outputs**: `payload` is typed and never optional; the return
  type is the contract's output;
- **overlap**: an endpoint in two slices fails at `register()`, naming it.

At runtime `register()` and `registerPartial()` also check that every slice
key is its own entry's name, which is what the completeness check above reads:
a slice written by hand rather than through `apiSlice` is where the two can
part, and a key that names another endpoint registers a mock nothing will
call while leaving one unanswered.

Why the mode and the guards are restated at all: the contract is a type, and
types are erased. The runtime needs the mode to know whether to fetch a
session and the guards to know which to run with which parameter, so they are
written once more in the builder, in the form the compiler can pin to the
contract.

### Partial registration, for tests

```typescript
mockApp.registerPartial(userMocks);                   // any subset, overlap still an error
const stub = mockApp.override("user.get", async () => ({ id: "x", name: "Stub" }));
stub.restore();                                       // a try/finally scopes it
mockApp.restoreOverrides();                           // however deeply they were stacked
mockApp.reset();                                      // sessions, cookies, counters, replays, overrides, failures, latency, the log, then onReset()
```

`restore()` is how an override is put back, and the handle carries nothing
else. It used to carry a `[Symbol.dispose]` member as well, for `using`, and
that member is declared only under `lib: ESNext`: a consumer on `lib: ES2022`,
which is what this package's only consumer is set to, got TS2550 "Property
'dispose' does not exist on type 'SymbolConstructor'" out of the published
`.d.ts` from importing the entry at all, whenever `skipLibCheck` was off. A
try/finally scopes an override in every project, and needs no lib.

`override()` replaces one endpoint's handler until restored and keeps the
entry's declarations (mode, guards, rate limit, idempotency) as registered.
It needs the endpoint to be registered first and throws otherwise: with no
entry there are no declarations to keep, and standing in a public one would
answer a session endpoint with no session and no guards, which reads as a
pass for a call the server refuses.

Overrides nest. A second override of the same endpoint stands on the first,
and restoring it uncovers the first rather than the registry, so an override
one `it` scoped cannot take down the one a `describe` put in place around it. Restoring is by handle rather than by depth, and restoring twice
does nothing.

An entry may also carry an `input` schema, which makes the mock answer 422
exactly as the server would. It is optional and it is the mock's own: the
contract is a type, so the server's schemas do not exist on this side, and
importing them would put the whole endpoint surface into the browser bundle.
Restate the shape for the endpoints whose rejection path a test needs. What it
takes is pinned to the contract's input (the form a client posts) in both
directions, so a schema that is stricter than the endpoint (an extra required
field, a literal where the contract says string) is refused too: such a schema
makes the mock 422 payloads the server accepts, which is the exact failure the
schema exists to reproduce. What it parses to must still read as that input,
which is how the handler's payload is typed: the server's own schema restated
with a `.default()` passes, and one whose transform changes a field's type
does not.

```typescript
mockApp.publicApi("user.get", {
    input: z.object({ userId: z.string() }),
    handler: async ({ payload }) => ({ id: payload.userId, name: "Ada" }),
});
```

A handler returns its payload, so the rest of the envelope goes on the
context: `ctx.envelope.message` is what a server handler passes to
`res.api(payload, { message })`, and `ctx.logList` is the usual log channel.
`ctx.sessionController`, `ctx.rateLimit(policy, key?)` and `ctx.isRateLimited(policy,
key?)` are the server's, bound the same way: a policy charged from code
counts on the mock's limiter and refuses with the same 429. The policy name is
any string here, since the mock's context does not carry its policy map's
types; the charge checks the name and the key when it runs.

A handler that throws answers with the message it threw. That is deliberate,
and the one place the mock does not copy the server, which would send
"Internal server error.": a mock runtime is a development tool and the thrown
message is the thing worth seeing. Pass `revealHandlerErrors: false` at
creation for the production shape.

`reset()` puts back everything the runtime owns: sessions, rate-limit
counters, replay records, overrides, injected failures, the offline switch,
the configured latency, the call log and its numbering, and the cookies its
own transports hold. The cookies matter as much as the sessions: emptying the
store while a jar still holds a token leaves the next call carrying a session
that no longer exists, which reads as signed in until the answer says
otherwise. So every jar `transport()` built for itself is emptied, and the
cookies a `"document"` transport mirrored are expired again.

The registry survives, being what the runtime was configured with rather than
what it accumulated. Subscriptions survive too, since they are how a test
watches the runtime rather than state under test, and a listener muted for
throwing is unmuted. A session store or a cookie jar the app supplied itself
survives: the runtime did not create it and does not know what else holds it.

## Handler context

```typescript
mockApp.sessionApi("order.create", {
    guards: { orgPermission: "ORDERS.CREATE" },
    handler: async ({ apiName, payload, session, sessionController, guardData, guardInputs, idempotencyKey, request, responseHeaders, logList, signal }) => {
        // payload: the contract's input, never optional
        // session: LambderSessionRecord<SessionData> on a session endpoint, null on a public one
        // sessionController: the session controller for this call (create, regenerate, end, endAll, update, refresh)
        // guardData: what the declared guards returned, typed from the mock guard map
        // guardInputs: what the caller sent, typed by the contract
        // request: headers, cookies, ip, host, siteHost, version
        // responseHeaders: set()/add() land on the answer; logList feeds the envelope's logList
        return { orderId: "o_1" };
    },
});
```

Handlers say no with `refuse()` or a thrown `LambderApiRefusal`, exactly as
server handlers do; the pipeline renders the refusal, status and headers
included. A handler that throws anything else crashes the call: the caller
receives a 500 envelope carrying the thrown message (the server sends
"Internal server error." instead, and `revealHandlerErrors: false` asks for
that shape), and the error rides on the call's event. The headers written
before the throw are on the answer either way, so a handler that signed a user
in and then threw still leaves the session cookie with the caller.

A login mock is an ordinary handler:

```typescript
mockApp.publicApi("login", async ({ payload, sessionController }) => {
    const user = users.find((u) => u.email === payload.email) ?? refuse("Wrong email or password.");
    await sessionController.createSession(user.id, { userId: user.id, memberships: user.memberships });
    return { ok: true };
});
mockApp.sessionApi("logout", async ({ sessionController }) => { await sessionController.endSession(); return { ok: true }; });
```

## Sessions and cookies

The mock carries sessions exactly as the server does: in cookies. The direct
transport plays the browser's cookie storage with a `LambderCookieJar`: the
jar stores what an answer's `Set-Cookie` headers set, honours their expiry,
attaches them to the next request, and fills in the request's CSRF token from
the non-HttpOnly cookie the way a page's script would read it. So a session a
login handler creates is on the next call, and a logout clears it.

The payload reaches the handler through the same JSON a server-bound request
travels as, so a handler holds its own copy (never the page's form object), a
`Date` arrives as its ISO string and a key set to `undefined` does not arrive.

Where a page's readable cookies live is one answer per mode. In the default
memory mode (and with a jar you pass) the jar is the page's whole cookie
store: the CSRF token posted is the jar's, and the one the page's caller read
from `document.cookie` is dropped, since nothing in this mode keeps
`document.cookie` current after `signIn` mirrored into it. The
jar's token is also what the caller judges a `sessionExpired` by, so a call
sent before a login that answers after it leaves the new session alone, as it
does in a browser. In `"document"` mode and behind the MSW adapter,
`document.cookie` holds them.

- `mockApp.transport()` creates a fresh jar. Two transports are two browsers,
  each with its own session. The jar is on the transport as `cookieJar`, so a
  test can read or clear the one it did not create, and `reset()` empties it.
- `mockApp.transport({ cookies: jar })` shares a jar you hold, which stays
  yours: `reset()` leaves it alone.
- `mockApp.transport({ cookies: "document" })` also mirrors the non-HttpOnly
  cookies into `document.cookie`, so the caller's own cookie read and clear
  paths run for real. `Secure` is dropped on a page that is not a secure
  context, where the browser would refuse the write and development over
  plain http on a LAN address has to keep working. Off by default: it adds a
  class of dev-only failure (a stale cookie, blocked storage in a private
  window) for little product signal.
- `mockApp.transport({ cookies: false })` carries none.
- `mockApp.transport({ clientIp: "10.0.0.2" })` says which client its calls
  arrive from, so two transports can exercise a `per: "ip"` rate limit as two
  clients. Default: the app's `defaultClientIp`.

Every cookie this runtime holds belongs to one host, the app's `cookieHost`:
`signIn` plants them there and the jar sends them there, the way a browser
scopes what it stores. It defaults to the page's own host, so a dev server on
`shop.localhost:5173` needs nothing; set it explicitly where the runtime has
no page to read (a Node test against a host-scoped cookie domain).

```typescript
const jar = new LambderCookieJar();
const created = await mockApp.signIn("user-1", { userId: "user-1", memberships }, { jar });   // no login endpoint needed
mockApp.attach(caller, { cookies: jar });       // caller.setTransport(mockApp.transport({ cookies: jar }))
await mockApp.signOut("user-1", { jar });       // log the subject out everywhere, and clear what signIn planted
await mockApp.expireSessionData("user-1");      // renew their data through dataRefresh on the next read
mockApp.sessionStore?.size;                     // the memory store, for assertions
```

`signIn` plants into the jar it is given and mirrors the readable cookies
into `document.cookie`, exactly as an answer's cookies are mirrored, because
behind the MSW adapter the jar is not where a page reads its CSRF token: the
browser caller reads `document.cookie` and posts what it finds there.
`signOut` is its mirror image, clearing both, so a signed-out page is not left
carrying a token for a session that no longer exists.

Where the page has no `crypto.subtle` (plain http on a LAN during device
testing), the mock picks the plain crypto stand-in on its own, over any store
that declares itself memory-only: such a store is nothing anybody can leak, so
hashing there protects nothing. A store that outlives the process keeps real
hashing, whoever created it.

## Wiring it up

In a browser, at boot, behind whatever dev guard the app has:

```typescript
if (import.meta.env.MODE === "development") {
    const { mockApp } = await import("./mocks");
    mockApp.attach(caller);
    mockApp.subscribe("console", lambderMockConsoleLogger());
}
```

In a test, one caller per browser you want to simulate:

```typescript
const caller = new LambderCaller<ApiContractType>({ apiPath: "/api", transport: mockApp.transport() });
```

The mock app can also stand in for a callee Lambda in a server test, through
`lambderMockInvokeTransport(mockApp)` on a `LambderInvokeCaller`, with the same
registry.

`assertApiSuccess` and `assertApiFailure` are exported here too: they narrow an
`apiOutcome` and say what it was when it is not what the test expected. To
test the real server rather than the mock handlers, see [Testing](./testing.md).

### The network panel (MSW)

The direct transport shows nothing in the browser's network panel, because no
request leaves the page. Where seeing the calls as real requests is worth
running a service worker, one MSW handler serves the whole API path over the
same runtime:

```typescript
import * as msw from "msw";
import { setupWorker } from "msw/browser";

const worker = setupWorker(lambderMockMswHandler(mockApp, { msw, apiPath: "/api" }));
await worker.start({
    // MSW's bare "error" strategy applies to every request its common-asset
    // filter does not exempt, which knows nothing about an app's module
    // requests or external hosts. Scope it to the api path.
    onUnhandledRequest(request, print) {
        if (new URL(request.url).pathname === "/api") print.error();
    },
});
```

Calls appear with their real method, status, timing and bodies. Session
cookies are held by the handler rather than by the browser, because the
browser will not hold them: a response a service worker synthesizes never
reaches the cookie store, and MSW's own jar comma-joins the `Set-Cookie`
headers before parsing them, which drops every cookie after the first. So the
handler keeps a `LambderCookieJar`, sends the ones whose scope covers the
call the way a browser decides what to send, and mirrors the ones a page's
scripts may see into `document.cookie` through the runtime's own mirror,
which is where the browser caller reads the CSRF token. That jar is scoped by
the app's `cookieHost`, the same host `signIn` plants at and the direct
transport sends to, with the path taken from the call's own URL. The jar it
builds for itself is the runtime's, so `reset()` empties it; pass your own as
`cookieJar` to inspect or clear it from a test, and it stays yours.

A call's cookies are that jar's and the page's own `document.cookie`, never
the request's Cookie header. MSW fills that header from its own cookie store,
which captures the HttpOnly session cookie off the mocked `Set-Cookie`
headers and keeps it in localStorage across reloads; read, it would send a
second session after a user switch, keep a cleared jar signed in, and put the
raw token into request events.

A mock that uses this adapter **and** `signIn` should pass the same jar to
both (`lambderMockMswHandler(mockApp, { msw, apiPath, cookieJar: jar })` and
`mockApp.signIn(key, data, { jar })`), or the session is planted in one jar
and looked for in another.

A call the runtime has no entry for is answered `apiNotFound`, which is what an
exhaustive `register` is for. Pass `onUnmocked: "passthrough"` to leave those
to MSW's other handlers and, failing those, to the network: the shape a
partially mocked app runs in while its remaining endpoints still come from a
real backend. A passthrough is recorded like any other call, with the outcome
`passthrough` and no status, so a mistyped endpoint name reaching the real
backend appears in the call log and on the subscription instead of leaving
nothing behind.

This and `mockApp.restNotMocked(reason)` answer the same question and are
alternatives: a registered rest entry gives the runtime an entry for every
name, so `onUnmocked` never applies and a call that would have gone to the
network is answered `notMocked` instead.

`clientIp` is the app's `defaultClientIp` unless this adapter names another,
so a call reads as arriving from the same address through the worker as
through the direct transport.

Lambder never depends on `msw`;
the app installs it and passes the module in. The handler it returns keeps
msw's own handler type, so `setupWorker(...)` and `setupServer(...)` take it as
they take any other. The costs are MSW's: the generated
`mockServiceWorker.js` must match the installed version, the worker registers
before the first call, and it intercepts the whole origin.

## Failure injection and latency

These paths are normally unreachable outside production, which is why the
handling built around them tends never to be exercised.

```typescript
mockApp.failNext("user.get", "network");                     // the next call rejects at the transport
mockApp.failNext("user.get", { reason: "rateLimited", retryAfterSeconds: 30 });
mockApp.setFailure("order.create", "sessionExpired");        // every call, until cleared
mockApp.setFailure("order.create", null);
mockApp.setOffline(true);                                    // every call rejects
mockApp.setLatency((apiName) => apiName.startsWith("report.") ? 800 : 40);
```

A queued `failNext` is spent by the call it fails and by nothing else: a call
that never reaches the handler (offline, or an abort during the latency wait)
leaves the queue where it was, so the next real call still meets the failure
that was arranged for it.

A `LambderMockFailure` is one of `network`, `timeout`, `server`, `refusal`
(with an optional message and status), `notAuthorized`, `sessionExpired`,
`versionExpired` and `rateLimited` (with an optional `Retry-After`). Each is
rendered by the same function the pipeline uses for the real thing, so an
injected 429 carries the `Retry-After` a real one does. `network` rejects the
transport, which the caller reports as `network`; `timeout` waits for the
caller's own abort, so a caller with `timeoutMs` reports `timeout` (a call
with no timeout configured waits for its external signal, or for ever, which
is what a timeout is). Latency is cancelled by the caller's abort.

## Observation

```typescript
const unsubscribe = mockApp.subscribe("panel", (event) => {
    if (event.phase === "request") showInFlight(event.id, event.apiName, event.payload);
    else settle(event.id, event.outcome, event.statusCode, event.envelope, event.durationMs, event.guardsRun);
});
mockApp.subscribe("console", lambderMockConsoleLogger({ payloads: true }));
mockApp.calls.at(-1)?.outcome;   // 'ok' | 'refusal' | 'notAuthorized' | 'sessionExpired' | 'versionExpired'
                                 // | 'rateLimited' | 'replayed' | 'validation' | 'notMocked' | 'unknownApi' | 'crash'
                                 // | 'injected' | 'passthrough'
```

One listener sees both phases, so a panel can show calls in flight and settle
them. Listeners are held under a key, so a hot-reloaded module replaces its
own listener instead of stacking a duplicate. A listener that throws never
breaks a call: it is reported once and muted, since a listener that throws on
one event throws on the next, and subscribing again under the same key (a hot
reload) or `reset()` brings it back. The events carry the pipeline's own
decisions (which guards ran, whether an answer was replayed, the parsed
envelope), which is richer than a network panel can be.

`mockApp.calls` hands out copies, down to the values: the log keeps growing
and `reset()` empties it, so an assertion that sorts a record's `guardsRun` or
a panel that deletes a header is editing its own copy rather than the log. The
`Set-Cookie` values in a record's `headers` are replaced by `[redacted]`; the
cookie name and attributes are what a call log is read for (did this call
start a session, did it clear one) and the value is the session token itself,
which has no business in a log a panel renders and a test snapshots.

## What the mock cannot do

The contract is a type, so the server's schemas do not exist on this side:
nothing validates an endpoint's input or output unless the mock restates it.
An entry that carries an `input` schema validates the payload and answers 422
exactly as the server does (or what `onInvalidInput` states, for a server app
with its own validation handler); one without takes whatever arrives, and a
handler
returning the wrong shape is a compile error rather than a runtime one.
Output is never validated: the contract is type-only, so the mock has no
output schema to strip a handler's extra fields with, where the server does.
Guard inputs and rate-limit key slices, whose schemas the mock guard map
declares, are validated as on the server. The MSW adapter and the invoke
transport take a POST as an API call only with `Content-Type:
application/json`, as the server does, so a hand-built call that leaves it out
fails in development too.

Response finalization is the server's alone: response compression, the
`maxResponseBytes` ceiling, ETag and conditional answers, and CORS headers all
happen in the Lambda adapter, after the pipeline, and none of them happens
here. What a mock answers is the envelope, its status and the headers the call
wrote, uncompressed and unconditioned. A test about any of those four belongs
on the server side.

## Reference

| Member | Description |
| --- | --- |
| `publicApi(name, handler \| options)`, `sessionApi(name, handler \| options)`, `notMocked(name, reason)`, `sessionNotMocked(name, reason)` | Registry entries |
| `restNotMocked(reason)` | One entry for everything the slices leave out, passed to the same `register()` call; answered as a public endpoint |
| `apiSlice(...entries)`, `register(...slices)`, `registerPartial(...slices)` | Slices and registration |
| `override(name, handler)`, `restoreOverrides()`, `reset()` | Per-test control |
| `transport(options?)`, `attach(caller, options?)`, `handle(transportRequest)`, `handleRequest(request)`, `requestFromTransport(transportRequest)` | The direct transport (its jar on it as `cookieJar`), the entry points behind it, and the one reading of a transport request every adapter shares |
| `signIn(sessionKey, data, { jar?, ttlSeconds?, host? })`, `signOut(sessionKey, { jar?, host? })`, `expireSessionData(sessionKey)`, `sessionManager`, `sessionStore` | Sessions |
| `failNext`, `setFailure`, `setOffline`, `setLatency` | Failure injection and latency |
| `subscribe(key, listener)`, `calls`, `registeredNames`, `hasRegisteredEntry(name)` | Observation |
| `notePassthrough(request)`, `mirrorCookiesIntoDocument(setCookies)`, `adoptCookieJar(jar)` | What an adapter (the MSW one) tells the runtime, so its calls are logged and its jar is reset |
| `rateLimiter`, `idempotencyStore` | The memory stores, for assertions |

Exported beside the app: `lambderMockConsoleLogger`, `lambderMockMswHandler`,
`lambderMockInvokeTransport`, `LambderCookieJar`, `lambderCookieJarTransport`,
the memory stores, `LambderMockTransportError`, the types under `LambderMock*`
(`LambderMockOverride`, what `override()` hands back, included), and the return
types of the two session members: `LambderCreatedSession` from `signIn()` and
`LambderSessionManager` from the `sessionManager` getter.

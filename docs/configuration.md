# Configuration

Everything an instance is configured with is given in ONE declaration at
creation. There are no enable/define chain methods, so nothing can be
half-configured or wired in the wrong order, and only registration (routes,
apis, hooks, `use()`) chains afterwards.

```typescript
import { initLambder } from "lambder";

const lambder = initLambder<SessionData>().create({ /* options */ });
```

`initLambder` is curried so the session data type is fixed first and everything
else (policy names, guard metadata, whether idempotency exists) is INFERRED
from the options. TypeScript type arguments are all-or-nothing per call, so a
plain `new Lambder<SessionData>({...})` would silently widen the inferred
policy types; the curried creator is the canonical entry.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiPath` | `"/api"` | Path API calls are posted to; must start with `/` |
| `apiVersion` | none | Stamped on every API answer's envelope as `apiVersion`, so a client can tell which build answered. Dotted numbers (`"1.2.10"`), since `minApiVersion` compares against it. Staleness itself is judged per endpoint by signatures, see [APIs](./apis.md#signatures-when-a-client-must-update) |
| `minApiVersion` | none | The oldest client build still served: a call naming a lower `version` answers `versionExpired` whatever its signature says. Dotted numbers compared segment by segment; a floor above `apiVersion` is taken as `apiVersion` |
| `apiSignatures` | none | The generated signature map (`lambder.apiSignatures()`), the same file the frontend ships with; enables the signature gate. See [APIs](./apis.md#signatures-when-a-client-must-update) |
| `files` | none | Where the app's files come from, for `servePublicFiles`, `serveIndexHtml`, `res.file` and `res.templateFile`. See [Frontend hosting](./frontend-hosting.md) |
| `compression` | `true` (off on a REST API unless given) | Automatic response compression. `true` is `{ minBytes: 860, encodings: ["br", "gzip"], quality: 5 }`; `false` disables it. See [Responses](./responses.md#compression) |
| `etag` | `true` | Automatic ETag and `If-None-Match` 304 handling on GET/HEAD 200 responses |
| `maxResponseBytes` | `5_500_000` | Guard threshold for Lambda's ~6MB response cap; a positive integer |
| `maxRequestPayloadBytes` | `20_000_000` | Ceiling on what a compressed request payload may restore to. See [Frontend client](./client.md#compressed-request-payloads) |
| `cors` | off | `true` allows any origin, or a `LambderCorsConfig` (below) |
| `trustedClientIpHeaders` | none | Headers that may name the caller's own address, in order of preference. Empty means `ctx.ip` is the address the gateway observed (below) |
| `trustedHostHeaders` | none | Headers that may name the host the viewer asked for, in order of preference. Empty means `ctx.host` is the Host the gateway received (below) |
| `originProof` | none | `{ header, secrets }`: the trusted headers above are read only from a request carrying the secret the proxy in front of the app sets (below) |
| `callSummary` | one JSON line per API call on stdout | What each API call's summary goes to: a function, or `false` for none (below) |
| `session` | none | Sessions over a store of your choosing; a guard that needs a session (`session: true`) and `addSessionRoute` are compile errors without it. See [Sessions](./sessions.md) |
| `rateLimits` | none | A limiter (`LambderRateLimiter`: DynamoDB, memory, or your own) plus named policies APIs reference by name, in one map or a list of maps (below). See [API policies](./api-policies.md#rate-limits) |
| `guards` | none | Named guards APIs reference by name; build each with `initLambder<SessionData>().guard()` (typed to the app's session) or `lambderGuard()`. One map or a list of maps (below). See [API policies](./api-policies.md#guards) |
| `idempotency` | none | An idempotency store (`LambderIdempotencyStore`: DynamoDB, memory, or your own) plus replay defaults. See [API policies](./api-policies.md#idempotency) |
| `requireApiGuards` | `false` | Make `guards` a required field of every endpoint (`defineApi`) |
| `crashes` | none | `{ report, reportTimeoutMs, reveal }`: a reporter told every crash on every path (API, route, event, startup) and waited for up to `reportTimeoutMs` (default 3000, a positive integer), and who may read a crash in the framework's 500. Without a reporter, a crash nothing answered is logged to the console. See [Routing](./routing.md#crashes) |

The app's refusal vocabulary is not a `create()` option. It is declared on the
init, `initLambder<SessionData>().declareRefusals(vocabulary, { requireCodes? })`
(one map of codes, or a list of maps), before any guard is built, so the
init's `guard()` and `refuse` are typed to it and its `create()` hands it to
the instance; `declareRefusals()` checks each code of the vocabulary the way
the table below is checked. See [Declared refusals](./apis.md#declared-refusals).

A key the options type does not have is a compile error, one level down as
well: `session` (and `session.cookie`), `idempotency`, `crashes`, `rateLimits` and each
of its `policies` (and a policy's `refusal`), each guard in `guards` (in every map of a list), the object form of `files`, and
`cors` and `compression` when either is written as an object. Inferring the
options as a `const` generic is what makes an app's declaration typed, and it
also switches TypeScript's own excess-property check off for the whole
literal, so `idempotency: { failOpn: false }` would otherwise have compiled
and left the engine failing open, and `cors: { credentials: true, origns:
[...] }` would have left the allowlist empty, which means every origin, with
credentials on.

## A full example

```typescript
import { initLambder, LambderLocalFileSource, LambderDdbSessionStore, LambderDdbRateLimiter, LambderDdbIdempotencyStore } from "lambder";
import * as path from "path";

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    apiVersion: process.env.WEB_VERSION,

    files: new LambderLocalFileSource({ root: path.resolve("./public") }),
    compression: { minBytes: 860, encodings: ["br", "gzip"], quality: 5 },
    etag: true,

    cors: { origins: ["https://app.example.com"], credentials: true },

    session: {
        store: new LambderDdbSessionStore({ tableName: "app-session", region: "us-east-1" }),
        sessionSalt: process.env.SESSION_SALT!,
        enableSlidingExpiration: true,
        cookie: { domain: ".example.com" },
    },

    rateLimits: {
        limiter: new LambderDdbRateLimiter({ tableName: "app-policies", region: "us-east-1" }),
        policies: { authPerIp: { perMin: 5, perHour: 30, per: "ip" } },
    },
    guards: { orgPermission, sessionOnly },
    idempotency: {
        store: new LambderDdbIdempotencyStore({ tableName: "app-policies", region: "us-east-1" }),
        defaultTtlSeconds: 24 * 3600,
        failOpen: true,
    },
    requireApiGuards: true,
});
```

## `files`

Either a `LambderFileSource` directly, or `{ source, memoryCache }` to tune or
disable the in-memory file cache beside it:

```typescript
files: new LambderLocalFileSource({ root: path.resolve("./public") }),
files: new LambderS3FileSource({ bucket: "myapp-web", clientConfig: { region: "eu-central-1" } }),
files: new LambderHttpFileSource({ baseUrl: "https://assets.example.com/v42/" }),
files: { read: async (relativePath) => myStore.get(relativePath) },
files: { source: new LambderLocalFileSource({ root }), memoryCache: { maxBytes: 64_000_000, maxFileBytes: 4_000_000 } },
files: { source: new LambderLocalFileSource({ root }), memoryCache: false },
```

The instance owns one reader over the source (`lambder.files`), shared by every
serving path. [Frontend hosting](./frontend-hosting.md) covers the sources and
the serving slots in full.

## `cors`

`cors: true` allows any origin. The object form:

| Field | Default | Description |
| --- | --- | --- |
| `origins` | `"*"` | `"*"`, an allowlist array, or `(origin, ctx) => boolean`. An allowed origin is echoed; under an allowlist or a predicate every answer carries `Vary: Origin`, so a cache never serves one origin's answer to another. A predicate is asked once per request, before any hook or handler runs, and its answer holds for every answer the request ends in, a crash's included. One that throws (`new URL(origin)` on the `Origin: null` a sandboxed frame sends) counts as refused and is logged; the request is answered as usual |
| `credentials` | `false` | Allow credentialed requests (cookies). Needs an allowlist or a predicate in `origins`: create() refuses it with every origin allowed, since any website could then read a signed-in user's answers |
| `methods` | framework default | Methods advertised on preflight |
| `allowHeaders` | framework default | Request headers advertised on preflight |
| `exposeHeaders` | `["Retry-After"]` | Response headers a cross-origin browser caller may read. `Retry-After` is not on the CORS safelist, and a hidden header reads as `null` rather than as an error, so rate-limit refusals stay readable by default |
| `maxAge` | none | Preflight cache duration in seconds |

## `trustedClientIpHeaders`

`ctx.ip` is the address the gateway observed, and nothing else, unless this
option names a header to prefer:

```typescript
trustedClientIpHeaders: ["cf-connecting-ip"],   // behind Cloudflare
```

The first listed header carrying a value wins, and its leftmost entry is
taken. Only list a header that something in front of this app always
overwrites. A header a client can set is a value a client can choose, and
`per: "ip"` rate limits key off `ctx.ip`: a caller that picks its own key gets
a fresh budget on every request, which is not a limit.

Behind API Gateway alone, leave this unset. API Gateway APPENDS to
`x-forwarded-for` rather than replacing it, so the leftmost entry is whatever
the client sent.

A [lambda-to-lambda invoke](./invoke.md) reads none of these headers. No
proxy in front of the function wrote its headers: they are whatever the
invoking code passed on, a browser's own included when a gateway lambda
forwards them. So on an invoke `ctx.ip` is the invoker's `clientIp`, which
its event carries in `requestContext.http.sourceIp`, and nothing else. The
server tells an invoke by the event's `requestContext.apiId`, which a gateway
writes itself, and never by the `x-lambder-invoke` marker, an ordinary header
any HTTP caller can send.

## `trustedHostHeaders`

`ctx.host` is the Host header the gateway received unless this option names a
header to prefer. A Function URL behind CloudFront needs it: CloudFront sends
an origin the origin's own Host, so the function sees its lambda-url domain,
and cookie domains and host-matched routes would work on that. Have the
distribution write the viewer's host into a header itself, and name it: a
viewer-request CloudFront Function that sets `x-forwarded-host` from the
viewer's Host, overwriting whatever the viewer sent. An origin request policy
cannot do this: it only forwards headers the viewer sent, so a policy that
forwards `x-forwarded-host` (the managed AllViewerExceptHostHeader does) hands
the function a host the client chose.

```typescript
trustedHostHeaders: ["x-forwarded-host"],   // a Function URL behind CloudFront
```

The first listed header carrying a well-formed host wins (a name or an
address, and an optional port), leftmost entry. The rule is the one above for
addresses: only list a header something in front of this app always
overwrites, because a host a client can pick decides which cookie domain and
which tenant's routes it gets.

That holds only while the distribution is the one way in. A Function URL with
auth type `NONE` answers anyone who has its lambda-url address, so a client can
call it directly, bypassing CloudFront, with any `x-forwarded-host` it likes.
Trust the header only when the function is reachable solely through the
distribution: the Function URL on `AWS_IAM` auth with a CloudFront origin
access control signing the distribution's requests, or an equivalent that
refuses every request the distribution did not send.

As with addresses, an [invoke](./invoke.md) reads none of these headers:
`ctx.host` there is the invoker's `host`.

## `originProof`

The two options above trust a header because a proxy in front of the app
writes it. That holds only for requests that came through the proxy: an API
Gateway answers on its own `execute-api` address and a Function URL on its
`lambda-url` one, and a request sent there directly carries whatever
`cf-connecting-ip` its sender wrote, a fresh `per: "ip"` budget per request.
`originProof` names a header the proxy sets to a secret on every request it
forwards, and the trusted headers are read only from a request that carries
it:

```typescript
trustedClientIpHeaders: ["cf-connecting-ip"],
originProof: { header: "x-origin-proof", secrets: [process.env.ORIGIN_PROOF!] },
```

- Set the header at the proxy, overwriting whatever the viewer sent: a
  Cloudflare request header transform rule, a CloudFront origin custom
  header.
- A request without it, or with another value, is answered as usual, with
  `ctx.ip` and `ctx.host` the ones the gateway observed: counted by the
  address it really came from.
- The header is taken off `ctx.headers` and `ctx.header()`, so no handler,
  hook or header log meets the secret; the raw `ctx.event` keeps it.
- `secrets` takes the previous secret beside the current one while the
  proxy's rule changes over, so a rotation drops no request. Each is at
  least 32 characters: a proof a sender could guess proves nothing.
- It needs trusted headers to guard, and its header may not be one of them;
  both are refused at creation.

## `callSummary`

Every API call is summarized in one line when it is answered, written to
stdout as JSON by default. A Lambda function's log group keeps it, and
CloudWatch Logs Insights reads its fields without a parse step:

```json
{"kind":"lambder.call","api":"order.place","outcome":"refusal","code":"order-closed","status":409,"durationMs":41.2,"handlerMs":12.8,"replayed":false,"coldStart":false,"requestId":"8c1f...","parentRequestId":null}
```

| Field | What it holds |
| --- | --- |
| `api` | The endpoint the call's path named, registered or not |
| `outcome` | `success`, `refusal`, `notAuthorized`, `sessionExpired`, `versionExpired`, `validation` (a 422), `crash`, or `other` for an answer a hook wrote that is not an API answer |
| `code` | The refusal's code, a framework code (`lambder/rate-limited`) or the app's; null when there is none |
| `status` | The HTTP status the call was answered with |
| `durationMs`, `handlerMs` | From the invocation's start to the answer, and the handler's own time (null when it did not run: refused before it, or replayed) |
| `replayed` | A stored idempotent answer was replayed |
| `coldStart` | The process's first invocation, whose duration includes loading the app |
| `requestId`, `parentRequestId` | The invocation's request id, the one Lambda's own lines for it carry, and that of the invocation that called it over a [direct invoke](./invoke.md), which the invoke carries |

Nothing from the call's input, its session, its cookies or its caller's
address is in it, so the lines can be kept as long as the app keeps logs.
Pages, files and non-HTTP events write none. A call the app could not start
for (a `created` hook that failed) is summarized as a crash like any other,
so a count of crashes by endpoint shows the outage rather than calls
stopping.

```typescript
callSummary: (summary) => metrics.record(summary),   // somewhere else
callSummary: false,                                  // none
```

A writer that throws costs that call its line and nothing else; the failure
is logged. A [test app](./testing.md) collects the summaries in
`app.callSummaries` instead of writing them.

A query over the lines gives per-endpoint views without a metric per
endpoint, whose count, and cost, grows with the API:

```text
fields api, outcome, code, durationMs
| filter kind = "lambder.call"
| stats count(*) as calls, pct(durationMs, 99) as p99 by api, outcome
| sort calls desc
```

## `session`

| Field | Default | Description |
| --- | --- | --- |
| `store` | required | `LambderDdbSessionStore`, `LambderMemorySessionStore`, or your own `LambderSessionStore` |
| `sessionSalt` | required | The HMAC key that turns a sessionKey into the store's partition key. Treat as a secret |
| `enableSlidingExpiration` | `true` | Extend the session on each access |
| `slidingWriteIntervalSeconds` | `max(60, 5% of TTL)` | Minimum seconds between sliding-expiration writes |
| `cookie` | see [Sessions](./sessions.md#cookie-scope) | Cookie scope: `domain`, `path`, `sameSite`, `secure` |
| `tokenCookieKey` | `"LMDRSESSIONTKID"` | Session token cookie name. Prefix it `__Host-` unless you need cross-subdomain sessions |
| `csrfCookieKey` | `"LMDRSESSIONCSTK"` | CSRF token cookie name. Prefix it `__Host-` too |
| `crypto` | WebCrypto | Hashing and randomness for the session tokens |
| `dataSchema` | none; required beside `dataRefresh` | The zod schema of session data, checked on every read. See [Sessions](./sessions.md#the-shape-of-session-data) |
| `dataRefresh` | none | Give session data a shelf life. See [Sessions](./sessions.md#keeping-session-data-fresh) |

A `__Host-` prefix is the browser's own rule that only this exact host, over
HTTPS, may write the cookie, which is what stops a sibling subdomain from
planting a session pair on your visitors. [Sessions](./sessions.md) has the
attack and what it costs (cross-subdomain sessions).

## `rateLimits`, `guards`, `idempotency`

These three shape the instance's types: policy and guard NAMES become the only
values an API's `rateLimit` and `guards` options accept, and `idempotency: true`
on an API is a type error unless the instance was created with an idempotency
store. [API policies](./api-policies.md) is the full guide.

```typescript
rateLimits: {
    limiter: new LambderDdbRateLimiter({ tableName, region }),
    policies: { /* name: { perMin, perHour, per, budget, refusal } */ },
},
guards: { /* name: initLambder<SessionData>().guard({ ... }) */ },
idempotency: {
    store: new LambderDdbIdempotencyStore({ tableName, region }),
    defaultTtlSeconds: 24 * 3600,
    failOpen: true,
},
```

### An app made of parts

An app whose parts each declare their own guards or rate-limit policies,
beside the APIs that use them, hands `create()` a list of maps instead of one
(and its refusal codes, a list of maps to `declareRefusals()`).
The instance declares every name in the list, so an API names a guard from
any part as it would a guard from the only map. A name two maps declare is a
compile error on the list and a throw at creation, rather than one quietly
replacing the other as a spread would:

```typescript
rateLimits: { limiter, policies: [corePolicies, ordersPolicies, catalogPolicies] },
guards: [coreGuards, ordersGuards],
```

The maps have to exist before the instance does, because the instance's type
is built from them, so a part keeps them in a file of their own that imports
none of its API files; the part's API files import the instance's declaration
builders, and the entry registers the groups they build after creation. The
mock runtime's `create()` takes one map of each; its `declareRefusals()` takes
the list the server's does.

## Declaring endpoints across files

The instance's declaration builders are typed to it, so a module declares its
endpoints with the instance's own `defineApi` rather than an annotation
written by hand. Nothing can drift from what actually runs, and modules
import the builders without a cycle, because the app file imports no modules:

```typescript
// app.ts: declarations plus the fully configured instance
export const lambderApp = initLambder<SessionData>().create({
    apiPath: "/api",
    session: { store: new LambderDdbSessionStore({ tableName: "app-session", region: "us-east-1" }), sessionSalt: "..." },
    rateLimits: { limiter, policies: apiRateLimitPolicies },
    idempotency: { store: idempotencyStore },
    guards: apiGuards,
});
export const { defineApi, defineApiGroup, lazyApiGroup } = lambderApp;
export type AppLambder = typeof lambderApp;

// orders.ts: an api module
export const orderApis = defineApiGroup("orders", {
    place: defineApi({ /* input, output, guards, ... */ }, async (ctx) => { /* ... */ }),
});

// index.ts: registration only (endpoints, hooks, routes)
const lambder = lambderApp.registerApiGroups(orderApis).addHook(/* ... */);
export const handler = lambder.getHandler();
```

`AppLambder` is for code that takes the configured instance, such as a
function that registers routes on it (`use()`).

## Registration methods

Endpoints are declared as values and registered in one call; everything
after them chains off the created instance and returns `this`.

| Member | Purpose |
| --- | --- |
| `defineApi(options, handler)` | Declare an endpoint: the handler returns its output or throws `refuse()`. Its guards decide its mode. See [APIs](./apis.md) |
| `defineApiGroup(name, apis)` | Gather endpoints into a group: `name.action`, called at `{apiPath}/{name}/{action}` |
| `lazyApiGroup(name, load)` | A group loaded on the first call to one of its endpoints |
| `registerApiGroups(...groups)` | Register groups; returns the instance typed with their contract |
| `loadApiGroups()` | Load every lazy group now (a build step, a boot check) |
| `addRoute(matcher, handler)` | HTTP route. See [Routing](./routing.md) |
| `addSessionRoute(matcher, handler)` | Session-protected route |
| `addAction(filter, handler)` | Non-HTTP invocations, and HTTP interception |
| `addHook(event, handler, priority?)` | `created`, `beforeRender`, `afterRender`, `fallback` |
| `use(plugin)` | Hand the instance to a function that registers routes, hooks or actions on it |
| `servePublicFiles(options?)` | Terminal slot serving real files |
| `serveIndexHtml(handler?, options?)` | App shell slot for unmatched page requests |
| `setRouteFallbackHandler(handler)` | Response for unmatched routes |
| `setApiFallbackHandler(handler)` | Response for a call to a name no endpoint has |
| `setApiInputValidationErrorHandler(handler)` | Response for a rejected Zod input |
| `setSessionExpiredRouteHandler(handler)` | Response for session routes with no session, and for a route or hook that meets `LambderSessionNotFoundError`. Default 401 |
| `setGlobalErrorHandler(handler)` | Last-resort error response |
| `getSessionController(ctx)` | The session controller for a request; a handler, guard or hook has it as `ctx.sessionController` |
| `getResponseBuilder(ctx?)` | A response builder outside a handler (no `res.die.*`) |
| `getHandler()` | The Lambda entry point |

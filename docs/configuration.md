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
| `compression` | `true` | Automatic response compression. `true` is `{ minBytes: 860, encodings: ["br", "gzip"], quality: 5 }`; `false` disables it. See [Responses](./responses.md#compression) |
| `etag` | `true` | Automatic ETag and `If-None-Match` 304 handling on GET/HEAD 200 responses |
| `maxResponseBytes` | `5_500_000` | Guard threshold for Lambda's ~6MB response cap; a positive integer |
| `maxRequestPayloadBytes` | `20_000_000` | Ceiling on what a compressed request payload may restore to. See [Frontend client](./client.md#compressed-request-payloads) |
| `cors` | off | `true` allows any origin, or a `LambderCorsConfig` (below) |
| `trustedClientIpHeaders` | none | Headers that may name the caller's own address, in order of preference. Empty means `ctx.ip` is the address the gateway observed (below) |
| `session` | none | Sessions over a store of your choosing; `addSessionApi` and `addSessionRoute` are compile errors without it. See [Sessions](./sessions.md) |
| `rateLimits` | none | A limiter (`LambderRateLimiter`: DynamoDB, memory, or your own) plus named policies APIs reference by name. See [API policies](./api-policies.md#rate-limits) |
| `guards` | none | Named guards APIs reference by name; build each with `lambderGuard()`. See [API policies](./api-policies.md#guards) |
| `idempotency` | none | An idempotency store (`LambderIdempotencyStore`: DynamoDB, memory, or your own) plus replay defaults. See [API policies](./api-policies.md#idempotency) |
| `requireSessionApiGuards` | `false` | Make `guards` a required field of every `addSessionApi` |
| `requirePublicApiGuards` | `false` | Make `guards` a required field of every `addApi` |

A key the options type does not have is a compile error, one level down as
well: `session` (and `session.cookie`), `idempotency`, `rateLimits` and each
of its `policies`, each guard in `guards`, the object form of `files`, and
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
    requireSessionApiGuards: true,
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
| `origins` | `"*"` | `"*"`, an allowlist array, or `(origin, ctx) => boolean`. With `credentials`, the origin is echoed rather than `"*"` |
| `credentials` | `false` | Allow credentialed requests (cookies) |
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

There is no exception for a [lambda-to-lambda invoke](./invoke.md). The
marker header that would have identified one is an ordinary request header
that any HTTP caller can set, so honouring it would hand every caller the
value again. An invoke needs no exception anyway: the event it synthesizes
carries the caller's `clientIp` in `requestContext.http.sourceIp`, which is
where `ctx.ip` reads the gateway address from in the first place.

## `session`

| Field | Default | Description |
| --- | --- | --- |
| `store` | required | `LambderDdbSessionStore`, `LambderMemorySessionStore`, or your own `LambderSessionStore` |
| `sessionSalt` | required | Peppers the identity-to-partition-key mapping. Treat as a secret |
| `enableSlidingExpiration` | `true` | Extend the session on each access |
| `slidingWriteIntervalSeconds` | `max(60, 5% of TTL)` | Minimum seconds between sliding-expiration writes |
| `cookie` | see [Sessions](./sessions.md#cookie-scope) | Cookie scope: `domain`, `path`, `sameSite`, `secure` |
| `tokenCookieKey` | `"LMDRSESSIONTKID"` | Session token cookie name. Prefix it `__Host-` unless you need cross-subdomain sessions |
| `csrfCookieKey` | `"LMDRSESSIONCSTK"` | CSRF token cookie name. Prefix it `__Host-` too |
| `crypto` | WebCrypto | Hashing and randomness for the session tokens |
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
    policies: { /* name: { perMin, perHour, per, budget, errorMessage } */ },
},
guards: { /* name: lambderGuard({ ... }) */ },
idempotency: {
    store: new LambderDdbIdempotencyStore({ tableName, region }),
    defaultTtlSeconds: 24 * 3600,
    failOpen: true,
},
```

## Sharing the instance type across files

For api modules split across files, DERIVE the annotation type from the real
instance instead of writing it by hand. The type can never drift from what
actually runs, and modules import it without a cycle, because the app file
imports no modules:

```typescript
// app.ts: declarations plus the fully configured instance
export const lambderApp = initLambder<SessionData>().create({
    apiPath: "/api",
    session: { store: new LambderDdbSessionStore({ tableName: "app-session", region: "us-east-1" }), sessionSalt: "..." },
    rateLimits: { limiter, policies: apiRateLimitPolicies },
    idempotency: { store: idempotencyStore },
    guards: apiGuards,
});
export type AppLambder = typeof lambderApp;

// orders.ts: an api module
export const orderApi = (lambder: AppLambder) => lambder.addSessionApi(/* ... */);

// index.ts: registration only (hooks, routes, modules)
const lambder = lambderApp.addHook(/* ... */).use(orderApi);
export const handler = lambder.getHandler();
```

## Registration methods

Everything below chains off the created instance and returns `this`.

| Method | Purpose |
| --- | --- |
| `addApi(name, schemas, handler)` | Public API. See [APIs](./apis.md) |
| `addSessionApi(name, schemas, handler)` | Session-protected API |
| `addRoute(matcher, handler)` | HTTP route. See [Routing](./routing.md) |
| `addSessionRoute(matcher, handler)` | Session-protected route |
| `addAction(filter, handler)` | Non-HTTP invocations, and HTTP interception |
| `addHook(event, handler, priority?)` | `created`, `beforeRender`, `afterRender`, `fallback` |
| `use(module)` | Apply an api/route module, preserving inferred types |
| `servePublicFiles(options?)` | Terminal slot serving real files |
| `serveIndexHtml(handler?, options?)` | App shell slot for unmatched page requests |
| `setRouteFallbackHandler(handler)` | Response for unmatched routes |
| `setApiFallbackHandler(handler)` | Response for unmatched API names |
| `setApiInputValidationErrorHandler(handler)` | Response for a rejected Zod input |
| `setSessionExpiredRouteHandler(handler)` | Response for session routes with no session. Default 401 |
| `setGlobalErrorHandler(handler)` | Last-resort error response |
| `getSessionController(ctx)` | The session controller for a request |
| `getResponseBuilder(ctx?)` | A response builder outside a handler (no `res.die.*`) |
| `getHandler()` | The Lambda entry point |

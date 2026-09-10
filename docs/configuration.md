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
| `apiPath` | `"/api"` | Path API calls are posted to |
| `apiVersion` | none | Version string clients must match; a mismatch answers `versionExpired` |
| `files` | none | Where the app's files come from, for `servePublicFiles`, `serveIndexHtml`, `res.file` and `res.templateFile`. See [Frontend hosting](./frontend-hosting.md) |
| `compression` | `true` | Automatic response compression. `true` is `{ minBytes: 860, encodings: ["br", "gzip"], quality: 5 }`; `false` disables it. See [Responses](./responses.md#compression) |
| `etag` | `true` | Automatic ETag and `If-None-Match` 304 handling on GET/HEAD 200 responses |
| `maxResponseBytes` | `5_500_000` | Guard threshold for Lambda's ~6MB response cap |
| `maxRequestPayloadBytes` | `20_000_000` | Ceiling on what a compressed request payload may restore to. See [Frontend client](./client.md#compressed-request-payloads) |
| `cors` | off | `true` allows any origin, or a `LambderCorsConfig` (below) |
| `session` | none | DynamoDB-backed sessions; required for `addSessionApi` and `addSessionRoute`. See [Sessions](./sessions.md) |
| `rateLimits` | none | A limiter instance plus named policies APIs reference by name. See [API policies](./api-policies.md#rate-limits) |
| `guards` | none | Named guards APIs reference by name; build each with `lambderGuard()`. See [API policies](./api-policies.md#guards) |
| `idempotency` | none | An idempotency store plus replay defaults. See [API policies](./api-policies.md#idempotency) |
| `requireSessionApiGuards` | `false` | Make `guards` a required field of every `addSessionApi` |
| `requirePublicApiGuards` | `false` | Make `guards` a required field of every `addApi` |

## A full example

```typescript
import { initLambder, LambderLocalFileSource, LambderDdbRateLimiter, LambderDdbIdempotency } from "lambder";
import * as path from "path";

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    apiVersion: process.env.WEB_VERSION,

    files: new LambderLocalFileSource({ root: path.resolve("./public") }),
    compression: { minBytes: 860, encodings: ["br", "gzip"], quality: 5 },
    etag: true,

    cors: { origins: ["https://app.example.com"], credentials: true },

    session: {
        tableName: "app-session",
        tableRegion: "us-east-1",
        sessionSalt: process.env.SESSION_SALT!,
        enableSlidingExpiration: true,
        cookie: { domain: ".example.com" },
    },

    rateLimits: {
        limiter: new LambderDdbRateLimiter({ tableName: "app-policies", region: "us-east-1", failOpen: true }),
        policies: { authPerIp: { perMin: 5, perHour: 30, per: "ip" } },
    },
    guards: { orgPermission, sessionOnly },
    idempotency: {
        store: new LambderDdbIdempotency({ tableName: "app-policies", region: "us-east-1" }),
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

## `session`

| Field | Default | Description |
| --- | --- | --- |
| `tableName` | required | DynamoDB session table |
| `tableRegion` | required | Its region |
| `sessionSalt` | required | Peppers the identity-to-partition-key mapping. Treat as a secret |
| `enableSlidingExpiration` | `false` | Extend the session on each access |
| `slidingWriteIntervalSeconds` | `max(60, 5% of TTL)` | Minimum seconds between sliding-expiration writes |
| `cookie` | see [Sessions](./sessions.md#cookie-scope) | Cookie scope: `domain`, `path`, `sameSite`, `secure` |
| `tokenCookieKey` | `"LMDRSESSIONTKID"` | Session token cookie name |
| `csrfCookieKey` | `"LMDRSESSIONCSTK"` | CSRF token cookie name |
| `partitionKey` / `sortKey` | `"pk"` / `"sk"` | Key attribute names on the table |
| `dataRefresh` | none | Give session data a shelf life. See [Sessions](./sessions.md#keeping-session-data-fresh) |
| `compression` | `true` | Brotli-compress `session.data` at rest |

## `rateLimits`, `guards`, `idempotency`

These three shape the instance's types: policy and guard NAMES become the only
values an API's `rateLimit` and `guards` options accept, and `idempotency: true`
on an API is a type error unless the instance was created with an idempotency
store. [API policies](./api-policies.md) is the full guide.

```typescript
rateLimits: {
    limiter: new LambderDdbRateLimiter({ tableName, region, failOpen: true }),
    policies: { /* name: { perMin, perHour, per, budget, errorMessage } */ },
},
guards: { /* name: lambderGuard({ ... }) */ },
idempotency: {
    store: new LambderDdbIdempotency({ tableName, region }),
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
    session: { tableName: "app-session", tableRegion: "us-east-1", sessionSalt: "..." },
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
| `getResponseBuilder(ctx?)` | A resolver outside a handler |
| `getHandler()` | The Lambda entry point |

# Lambder - Serverless NodeJS Web Framework (v4)

Lambder is a highly opinionated dynamic serverless framework designed to facilitate the management and implementation of routes and APIs within AWS Lambda functions, specifically tailored for TypeScript projects. It provides a streamlined approach to handling HTTP requests, managing sessions, and defining API routes, making serverless application development more intuitive and structured.

**New in 4.9:**

- **Mandatory authorization on public APIs**: `requirePublicApiGuards: true` at creation makes `guards` a required field of every `addApi`, the same way `requireSessionApiGuards` does for session APIs, at the type level and at registration. Public APIs are open by default and that stays the default; what turning it on buys is that a public endpoint's openness becomes a written decision rather than an omission. The ones anybody may call declare a named no-op guard carrying the reason (`guards: { open: "Static strings already in the bundle." }`), the ones that authorize their caller some other way (a signature, a device secret, a one-shot token) name where that happens, and one grep over the guard names then lists every public door and why it is open. The two flags are independent, so an app can require either or both.
- **An empty guards option is refused**: `guards: {}` and `guards: []` were inhabited by the option type and passed the require\*ApiGuards field check while normalizing to zero entries, so a declaration that authorized nothing satisfied a requirement that exists to make authorization explicit. Both are now compile errors (every form of the option is non-empty by construction) and a registration error for a plain-JS caller, whichever flag is on or off. Requiring the chosen key also rejects `guards: { theGuard: undefined }`, which an optional property accepted and which reached the guard's handler with an undefined param.

**New in 4.8:**

- **Grouped cache keys**: `LambderDdbCache` keys may be a `{ pk, sk }` pair instead of a string, which stores related entries in one partition: `{ pk: "division:ist-34", sk: "1700:1800" }` keeps every cached window of one division together. `deletePartition(pk)` then drops the whole group without knowing which sort keys exist, and `listSortKeys(pk, { prefix, limit })` reads back what is currently cached under it. The group invalidation a cache of derived, per-entity values needs, in place of remembering every key ever written or waiting out the TTL. Reads stay one request, and the memory layer, single-flight and fill lease stay per entry. Only the `pk` part is hashed, so the sort key is queryable; a caller's `#` is escaped rather than refused (`~`→`~0`, `#`→`~1`). Plain string keys keep their exact item layout, so a live table needs no migration and both forms can share a partition.
- **`guards` on the API contract**: each contract entry now carries the `guards` option exactly as declared (`ApiContractType["getUser"]["guards"]` is the literal `{ readonly orgPermission: "USERS.MANAGE" }`), so a client-side map of what an API needs can be pinned to the server's own declaration with `satisfies` instead of a test that reads the server source.

**New in 4.7:**

- **Compressed request payloads**: `requestCompression` on `LambderCaller` gzips the payload of any call whose JSON reaches a threshold (`true` is `{ minBytes: 4096 }`), sending it as `payloadGz` beside its byte length instead of `payload` whenever that is actually smaller; the server restores it before rate-limit key slices, guards and input validation, so no call site, handler or schema changes. Chiefly a way to fit a large payload under Lambda's ~6MB invoke cap, which applies to the compressed bytes. The envelope stays `application/json` with its routing fields in plain text, so gateways, CDNs and mocks are unaffected. `maxRequestPayloadBytes` (default 20MB) bounds what a body may expand to.
- **One compression codec**: `shared/LambderCompressionCodec.ts` is now the only place Lambder compresses or decompresses bytes. Its `restoreBoundedText(bytes, declaredBytes, encoding)` carries the guarantee every compressed value in Lambder depends on, at rest and on the wire: the declared UTF-8 byte length bounds the decompression AND must match the result exactly, so a truncated, tampered or endlessly-expanding input fails instead of decoding to something merely plausible. Compression is split across three modules by what each one needs: the codec (zlib), the option and its resolver (pure, so the browser entry can resolve the caller's option), and the request payload format (the browser's CompressionStream). `stores/LambderDdbCompression.ts` is retired into them.
- **One compression option, now everywhere**: the HTTP response option and the new request option resolve through the same `resolveCompressionOption` the DynamoDB stores and sessions use, and every site's option is the one generic `LambderCompressionOption<Settings>`. Same vocabulary at every site (`true` for that site's defaults, `false` for off, an object to override, `minBytes` as the threshold, `quality` as the Brotli quality, `encodings` as the negotiation order), same `Settings | null` resolved shape, and the same startup validation: `compression: { quality: 99 }` or `{ encodings: [] }` on a response is now a construction error instead of being silently ignored, and a field set to `undefined` keeps its default.
- **Brotli responses**: response compression now negotiates `br` before `gzip`, smaller at comparable speed (15-25% on markup and prose, substantially more on the repetitive record lists API responses tend to be), which is bandwidth saved and headroom gained against the ~6MB response cap. `compression: { encodings: ["gzip"] }` opts out, `quality` (default 5) tunes it.
- **Mandatory authorization on session APIs**: `requireSessionApiGuards: true` at creation makes `guards` a required field of every `addSessionApi`, at the type level (a missing declaration is a compile error at the registration site) and at registration (a plain-JS caller throws). An API the session alone authorizes declares a named no-op session guard, so every opt-out is explicit and one grep lists them all. The class of defect this closes is "the guard existed and the endpoint did not use it", which review discipline does not catch as a surface grows.

**New in 4.6:**

- **Cookies as a first-class concern**: `res.setCookie(name, value, options)` and `res.clearCookie(name, options)` serialize Set-Cookie headers through the `cookie` package (defaults Path=/, SameSite=Lax, Secure; a function-form `domain` resolves against the request hostname, the same option the session takes), replacing hand-built header strings; `serializeCookie`/`serializeClearCookie` are exported for code holding a response. `ctx.cookieList` keeps every value a cookie name arrived with beside the first-wins `ctx.cookie`.
- **Session cookie scope changes heal**: a cookie's identity is (name, domain, path), so changing the session's `cookie.domain` or `path` on a live deployment leaves the old copy in every browser beside the new one, and a whole-header parse silently picks whichever the browser lists first. The controller now tries every copy of the session cookie (record and CSRF pairing checked per copy), logs the ambiguity, and evicts the stale host-only twin from the response, so a migrated browser recovers on its first request instead of answering `sessionExpired` until the old cookie expires.

**New in 4.5:**

- **`files` at creation replaces `publicPath`** (and `servePublicFiles({ source })`): one `LambderFileSource` configured once, `files: new LambderLocalFileSource({ root: path.resolve("./public") })` for the folder bundled with the deployment, `new LambderS3FileSource({...})` for S3 or R2, or your own `{ read(relativePath) }`. The instance owns one reader over it (`lambder.files`): path rule, in-memory file cache and compiled-template cache in one place, shared by `servePublicFiles`, `serveIndexHtml`, `res.file` and `res.templateFile`, so a build hosted from a bucket serves its index.html and templates from the bucket too, cached the same way as its assets. The cache is tuned or disabled beside the source, `files: { source, memoryCache }`, and `memoryCache` leaves `servePublicFiles`; `res.file` loses its SPA-era `fallback` option (the fallback chain replaced it).

**New in 4.4:**

- **`guardInputsProvider`** on `LambderCaller`: supply guardInput-mode guard values for every call from one place (the organization the UI is on, a device token) instead of at each call site; per-call `guardInputs` merge on top. Name the covered guards in the caller's second type parameter, `new LambderCaller<Contract, "orgPermission">({ guardInputsProvider, ... })`: calls to APIs whose guardInput guards are all covered no longer require the options argument, uncovered ones (a Turnstile token) still do, and naming guards makes the provider itself mandatory.
- **Public file sources**: `servePublicFiles({ source })` serves from any `LambderPublicFileSource`: `LambderLocalFileSource` (a folder; the default, over `publicPath`), `LambderS3FileSource` (S3, or Cloudflare R2 and other S3-compatible stores via `clientConfig.endpoint`; `@aws-sdk/client-s3` is an optional peer dependency loaded on first read), or your own `{ read(relativePath) }`. The handler's traversal check, memory cache, mime fallback from the extension, Cache-Control, ETag and compression apply to every source. The `cacheControl` callback receives the relative file path.
- **`expireSessionDataAllByKey(sessionKey)`** on the session manager and controller: marks the data of every session of a subject stale, so each renews via `dataRefresh` on its next read. The way to apply a role or permission change to a user immediately, without logging them out (`deleteSessionAllByKey`) and without waiting for the data TTL.

**New in 4.3:**

- **Compressed sessions**: `session.data` is stored Brotli-compressed by default, as `dataBr` + `dataBytes` on the record, the same scheme LambderDdbCache and LambderDdbIdempotency use (one shared implementation). A session that caches roles, permissions or product lists shrinks 2-3x and stays within one DynamoDB read unit for longer. `session.compression` is `true` by default (the same as `{ minBytes: 0 }`: every record compressed); `false` turns it off and `{ minBytes }` compresses only from that JSON size. Records written under either setting read back, so it can be switched on or off on a live table.

- **One compression option everywhere**: `LambderDdbCache`, `LambderDdbIdempotency` and sessions take the same `compression` option (`true` for that store's defaults, `false` for off, `{ minBytes, quality }` to override), resolved by one shared function, and each store records a value's encoding so the option can be switched on or off on a live table. Defaults keep the previous behavior: the cache compresses everything, the idempotency store from 1KB. `compressionQuality` on the cache and idempotency store is replaced by `compression: { quality }`, and HTTP `compression` accepts `true` as `{ minBytes: 860 }`.

**New in 4.2:**

- **Rate-limit budgets**: a policy's `budget` is `"perApi"` (default: each referencing API gets its own counter, so the numbers are a per-API ceiling and three APIs on a 60/min policy allow one IP 180/min in total) or `"perPolicy"` (one counter shared by every API referencing the policy). The policy is the group, and two separate shared budgets are two policies.
- **Per-API tuning**: the `rateLimit` option gained a map form like guards, `rateLimit: { lookupPerIp: { perMin: 20 } }`, which merges window overrides over a perApi policy's own (a tighter burst keeps the policy's daily cap). Overriding the windows of a perPolicy policy is a startup error; `errorMessage` is overridable on either.
- **Retry-After**: a 429 carries the exceeded window's reset as a `Retry-After` header (CORS exposes it by default via the new `exposeHeaders` option), `LambderCaller` failure outcomes surface it as `retryAfterSeconds`, `LambderDdbRateLimiter.isRateLimited()` answers `false | { window, limit, resetAt }`, and `LambderApiError`/`refuse()` accept `headers`.
- **One refusal shape, with codes**: `LambderRefusalMessage` gained an optional machine-readable `code` (`refuse(content, { code })`), so clients branch and translate on an identifier instead of string-matching prose. Every refusal the framework itself authors (rate limit 429, idempotency 409 and 400, unknown API) is a `LambderRefusalMessage` stamped with a `LAMBDER_REFUSAL_CODES` constant under the reserved `lambder/` prefix; a rate-limit policy's own `errorMessage` (typed as a refusal message) inherits `lambder/rate-limited` unless it sets a code.
- **One validation path**: preflight slices (guard `apiInput`/`guardInput`, rate-limit `apiInput` keys) answer through `setApiInputValidationErrorHandler` exactly like the API's own schema.

**New in v4:**

- **Declarative auth as guards**: guards take per-API params (`guards: { orgPermission: "SOME.PERMISSION" }`), can require a session (`session: true`, compile-checked), and RETURN typed values that land on the handler's `ctx.guardData[name]`. Together with the apiInput/guardInput input modes, permission checks and device auth become registration-time declarations instead of per-handler boilerplate.
- **Hardened policy layer**: rate-limit policies can share one counter across APIs (now `budget: "perPolicy"`); idempotency replays answer before rate limits, survive client IP changes (key-scoped for public APIs, 16-char minimum keys), store full response headers, refuse to store Set-Cookie responses, and Brotli-compress stored bodies of 1KB+ so the ~350KB replay budget applies to compressed bytes.
- **Secrets hashed at rest**: session records store only sha256 hashes of the bearer secrets, so a session-table read yields no usable cookies; `LambderSessionReadError` keeps a DynamoDB blip from reading as a logout.
- **Three package entry points**: `lambder` (server), `lambder/client` (browser-safe by construction: no AWS SDK, no Node built-ins), `lambder/testing` (`LambderMSW`); sources organized into core/policies/session/stores/client/shared.
- **Configuration at creation**: `initLambder<SessionData>().create({...})` takes the WHOLE configuration (serving options, session, cors, rate limits, guards, idempotency) in one declaration; the enable/define chain methods are gone, so nothing can be half-configured or wired in the wrong order, and api modules annotate with `typeof lambderApp` derived from the real instance. Plus `LambderCaller.createIdempotencyKeyScope()` for one self-rotating key per logical operation, and fail-open rate limiting logs its passes.

**Breaking in v4** (from 3.x): configuration moved entirely to creation, removing `enableCors`, `enableDdbSession`, `setSessionCookieKey`, `enableApiRateLimits`, `enableApiIdempotency`, and `defineApiGuards` in favor of the `cors`/`session`/`rateLimits`/`guards`/`idempotency` options of `initLambder().create({...})`; session records are reshaped (hashes at rest; live sessions invalidate once on upgrade, clients just re-login) and the manager-level `createSession`/`regenerateSession` return `LambderCreatedSession` (`{ session, sessionToken, csrfToken }`; the controller API is unchanged); `LambderMSW` moved from the root entry to `lambder/testing`; `LambderCaller.apiRaw()` is removed (use `apiOutcome()`, whose failure outcomes carry the envelope on `response`); the `multiValueHeaders` alias on `res.raw()` is removed (use `headers`); `LambderDdbIdempotency.complete()` answers `"stored" | "too-large" | "lost"`; idempotency keys must be 16-200 chars.

v3 (public file serving, `addAction()`, gzip + ETag, thrown responses, `LambderTemplatingEngine`, `html`/`xml` tags, payload v2 support, `LambderDdbCache`, `createLambderI18n`, `LambderApiError`/`refuse()`, `apiOutcome()`, the declarative policy foundations) is documented in the git history.

## Features

- **Type-Safe APIs with Zod**: Define inputs and outputs with Zod schemas. Get automatic runtime validation and compile-time type inference.
- **Method Chaining**: Build your API contract incrementally with a fluent interface.
- **Simple API & Route Declaration**: Define your APIs and routes using concise and expressive syntax.
- **Session Management**: Built-in session management to secure and personalize user experiences.
- **Flexible Hooks System**: Employ hooks to execute code at different stages of the request lifecycle.
- **Error Handling**: Comprehensive error handling capabilities, including global error handlers and route-specific fallbacks.
- **Seamless Integration**: Works with API Gateway REST APIs (payload v1), HTTP APIs (payload v2) and Lambda Function URLs; the payload format is detected per event.

## Standalone Modules

Self-contained tools that ship with the package and work with or without the framework. Each has its own guide:

| Module | Guide | Description |
|---|---|---|
| `html` / `xml` tags + `LambderTemplatingEngine` | [docs/TEMPLATING.md](./docs/TEMPLATING.md) | Type-safe tagged templates and a comment-only HTML template engine (build-pipeline-safe) |
| `LambderDdbCache` | [docs/DDB_CACHE.md](./docs/DDB_CACHE.md) | DynamoDB-backed compressed JSON cache with lease-based single-fill (server-only) |
| `createLambderI18n` | [docs/I18N.md](./docs/I18N.md) | Typed translations with enforced/optional languages, component-level extension and auto language detection (isomorphic) |
| `LambderMSW` | [docs/LAMBDER_MSW.md](./docs/LAMBDER_MSW.md) | Typed MSW mocking of the API contract for frontend development |

Also see [docs/TYPE_SAFE_QUICK_START.md](./docs/TYPE_SAFE_QUICK_START.md) and [docs/DYNAMODB_SETUP.md](./docs/DYNAMODB_SETUP.md).

## Installation

```bash
npm install lambder zod
# or
yarn add lambder zod
```

`zod` and the AWS SDK clients are optional peer dependencies, so installing
lambder never drags them into your tree. Add whatever the code you actually
import needs:

| What you import | What to install alongside |
|---|---|
| `lambder/client` (browser, shared isomorphic code) | `zod` |
| `lambder` on AWS Lambda (`nodejs18.x` and later) | `zod`. The runtime already provides the AWS SDK v3, so mark the SDK packages as dev dependencies and keep them out of the deployment package |
| `lambder` anywhere else (a long-running server, a container, local tests) | `zod`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` |
| `LambderS3FileSource` | `@aws-sdk/client-s3`, loaded on first read |
| `lambder/testing` | `msw` |

The SDK and its `@smithy` tree are roughly 21MB installed, which is why they are
peers rather than dependencies: a frontend importing only `lambder/client` has
no use for any of it, and a Lambda deployment package should not ship a second
copy of what the runtime already loads. The runtime pins its own SDK version,
so if you need a specific one, install it and bundle it yourself.

## Package Entry Points

The package ships three entry points; pick by where the code runs:

| Entry | Runs in | Carries |
|-------|---------|---------|
| `lambder` | Server (Lambda) | The full framework: pipeline, sessions, DDB stores, policies, plus everything from `lambder/client` |
| `lambder/client` | Browser and isomorphic shared code | `LambderCaller`, `LambderApiError`/`refuse`, the API contract and envelope types, `html`/`xml` tagged templates, `createLambderI18n` |
| `lambder/testing` | Dev and test tooling | `LambderMSW`, the MSW adapter that serves your typed contract from mock handlers |

Frontends and shared isomorphic packages should import from `lambder/client` only; the entry's module graph contains no AWS SDK, Node built-ins, or server pipeline, so the browser boundary is structural rather than left to tree-shaking.

Source layout mirrors this: `src/core/` (request pipeline), `src/policies/` (declarative rate limits, guards, idempotency), `src/session/`, `src/stores/` (DynamoDB primitives), `src/client/`, and `src/shared/` (isomorphic modules both entries re-export).

## Backend Usage

### Basic Setup

The whole configuration is given at creation, in one declaration; only
registration (routes, apis, hooks, `use()`) chains afterwards. `initLambder`
is curried so the session data type is fixed first and everything else
(policy names, guard metadata) is INFERRED from the options; TypeScript type
arguments are all-or-nothing per call, so a plain `new Lambder<SessionData>({...})`
would silently widen the inferred policy types, which is why the curried
creator is the canonical entry.

```typescript
import { initLambder, LambderLocalFileSource } from 'lambder';
import { z } from 'zod';
import * as path from 'path';

interface SessionData { userId: string; }

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    files: new LambderLocalFileSource({ root: path.resolve(`./public`) }),
    session: {
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING",
    },
    // true allows any origin; or configure: { origins: ["https://app.example.com"], credentials: true }
    cors: true,
});

// Define type-safe APIs with Zod schemas
lambder
    .addApi("getCompanyPage", {
        input: z.object({ companyName: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string() })
    }, async ({ apiPayload }, res) => {
        // apiPayload is automatically typed and validated!
        const data = await fetchDataSomehow(apiPayload.companyName);
        return res.api(data); // Return value is type-checked
    })
    .addApi("loginUser", {
        input: z.object({ email: z.string().email(), password: z.string() }),
        output: z.object({ success: z.boolean(), token: z.string().optional() })
    }, async (ctx, res) => {
        const user = await authenticateUser(ctx.apiPayload.email, ctx.apiPayload.password);
        if (!user) {
            return res.api({ success: false });
        }
        
        await lambder.getSessionController(ctx).createSession(user.id);
        return res.api({ success: true, token: "session-token" });
    });

// Export the inferred contract for the frontend
export type ApiContractType = typeof lambder.ApiContract;

// Export the handler
export const handler = lambder.getHandler();
```

Each contract entry carries the API's `input` and `output`, its `guardInputs` when a guardInput-mode guard applies, and its `guards` option exactly as declared (`ApiContractType["getUser"]["guards"]` is the literal `{ readonly orgPermission: "USERS.MANAGE" }`). A client that keeps its own map of what an API needs, to decide whether to render a screen before calling, pins that map to the declarations with `satisfies` instead of a test that reads the server source:

```typescript
type PermissionNeededBy<K extends keyof ApiContractType> =
    ApiContractType[K] extends { guards: { orgPermission: infer N } } ? N : never;

const NEEDS = {
    getUser: "USERS.MANAGE",
} as const satisfies { [K in keyof ApiContractType]?: PermissionNeededBy<K> };
```

Renaming the permission on the server, or moving the API to a different one, then fails the client's map to compile. Make the mapped type non-optional (over the guarded API names) when the map must also stay complete as guarded APIs are added.

### Adding Routes

```typescript
lambder
    // Define a simple route
    .addRoute("/hello-world", (ctx, res) => {
        return res.html("Hello World");
    })
    // Route with parameters
    .addRoute("/user/:userId", async (ctx, res) => {
        const user = await getUser(ctx.pathParams.userId);
        if(!user) return res.status404("Not found");
        return res.html(`Hello ${user.name}`);
    })
    // Define a regex route
    .addRoute(/\/hello-regex/, (ctx, res) => {
        return res.html("Hello Regex");
    })
    // Function routes allows routing on any context variable
    .addRoute((ctx)=>ctx.path === '/hello-fn-route', (ctx, res) => {
        return res.html("Hello from a function route");
    })
    // Match on method/host with a structured matcher
    .addRoute({ path: "/stripe-webhook", method: "POST" }, (ctx, res) => {
        return res.json({ received: true });
    })
    // Serve real files from the files source (see "Public file sources"
    // below). This is a terminal fallback slot, NOT a catch-all route, so it
    // can never shadow routes registered after it.
    .servePublicFiles()
    // Serve the app shell for GET/HEAD page requests nothing else handled
    // (see "Hosting a frontend build" below).
    .serveIndexHtml()
    // Set a fallback handler for whatever remains
    .setRouteFallbackHandler((ctx, res) => {
        return res.status404("Not Found");
    })
    // Set a fallback handler for unmatched APIs
    .setApiFallbackHandler((ctx, res) => {
        return res.api(null, { errorMessage: "API not found" });
    })
    // Handle Zod validation errors for API inputs
    .setApiInputValidationErrorHandler((ctx, res, zodError) => {
        return res.api(null, { errorMessage: zodError.issues });
    })
    // Global error handler
    .setGlobalErrorHandler((err, ctx, res) => {
        console.error("Error:", err);
        return res.raw({ statusCode: 500, body: "Internal Server Error" });
    });
```

### Session-Protected APIs

Use `addSessionApi` for endpoints that require authentication:

```typescript
lambder.addSessionApi("getProfile", {
    input: z.void(),
    output: z.object({ userId: z.string(), username: z.string() })
}, async (ctx, res) => {
    // Session is automatically fetched and validated
    return res.api({
        userId: ctx.session.data.userId,
        username: ctx.session.data.username
    });
});
```

### Modular APIs with .use()

For larger applications, split your APIs into separate modules:

```typescript
// user-api.ts
import { z } from "zod";
import Lambder, { LambderLocalFileSource } from "lambder";

export const userApi = <T>(l: Lambder<T>) => {
    return l
        .addApi("getUser", {
            input: z.object({ id: z.string() }),
            output: z.object({ id: z.string(), name: z.string() })
        }, async (ctx, res) => {
            return res.api({ id: ctx.apiPayload.id, name: "User" });
        })
        .addApi("createUser", {
            input: z.object({ name: z.string(), email: z.string() }),
            output: z.object({ id: z.string() })
        }, async (ctx, res) => {
            return res.api({ id: "123" });
        });
};

// index.ts
import { userApi } from "./user-api";

const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
    .use(userApi);

export type ApiContractType = typeof lambder.ApiContract;
```


### Actions (addAction)

The same Lambda often also receives non-HTTP invocations: EventBridge/CloudWatch schedules, custom events, SQS batches. `addAction(filter, action)` registers a handler whose filter sees the **raw Lambda event** (always) and the **HTTP context** (`ctx`, or `null` for non-HTTP invocations). `getHandler()` dispatches everything.

```typescript
lambder
    // Non-HTTP trigger: filter on the raw event (one plain function, no DSL)
    .addAction(
        (event) => (event as { source?: string })?.source === "app.reconciliation",
        async (event, { lambdaContext }) => {
            await reconcileEverything();
            return { reconciled: true };
        },
    )
    // Type-guard filters give a typed event in the handler
    .addAction(
        (event): event is ScheduledEvent => isScheduledEvent(event),
        async (event) => runMaintenance(),
    )
    // HTTP interception: ctx is present, and the action must return a response via tools.res
    .addAction(
        (event, ctx) => ctx !== null && ctx.host.endsWith("dev.example.com") && ctx.cookie.dev !== "atlas",
        async (event, { res }) => res!.status404("Not found"),
    );

export const handler = lambder.getHandler();
```

Semantics:
- The handler's second argument is `{ ctx, res, lambdaContext }`, discriminated on `ctx`: both `ctx` and `res` are non-null for HTTP invocations and `null` otherwise, so `if (tools.ctx)` narrows both
- **HTTP invocations**: actions join the same first-match chain as routes/APIs (registration order) and must return a response built with `tools.res`
- **Non-HTTP invocations**: actions are the only handlers; return values pass through to Lambda untouched (e.g. `{ batchItemFailures }` for SQS) and errors **rethrow** (never routed to `setGlobalErrorHandler`), preserving Lambda-native retry/DLQ semantics
- A trailing `.addAction(() => true, handler)` acts as the fallback for unmatched non-HTTP events; with no match at all, a descriptive error is thrown

### Hooks

Lambder provides hooks to execute code at different stages of the request lifecycle.

```typescript
lambder
    // Before render hook
    .addHook("beforeRender", async (ctx, res) => {
        // Perform actions before rendering
        console.log("Request received:", ctx.path);
        return ctx; // Return the (modified) ctx to continue, a response to short-circuit, or throw an Error
    })
    // After render hook
    .addHook("afterRender", async (ctx, res, response) => {
        // Modify response before sending
        console.log("Response status:", response.statusCode);
        return response;
    })
    // Fallback hook - runs when no route/API matches
    .addHook("fallback", async (ctx, res) => {
        // Perform cleanup or logging for unmatched requests
        console.log("No handler matched for:", ctx.path);
    });
```

### Session Management

Enable DynamoDB-based sessions with the `session` option at creation:

```typescript
const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    session: {
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING",
        enableSlidingExpiration: true, // Optional: extend session on each access
        compression: true,             // Optional: Brotli-compress session.data at rest (default true; false to disable, or { minBytes })
        // Optionally customize cookie names (defaults: LMDRSESSIONTKID, LMDRSESSIONCSTK)
        tokenCookieKey: "MY_SESSION_TOKEN",
        csrfCookieKey: "MY_CSRF_TOKEN",
    },
});
```

#### DynamoDB Session Table Structure

- Primary Key: "pk"
- Sort Key: "sk"
- TTL Key: "expiresAt" (optional, recommended)

See [docs/DYNAMODB_SETUP.md](docs/DYNAMODB_SETUP.md) for detailed setup instructions.

#### Cookie scope

`session.cookie` sets the scope of the two session cookies: `{ domain: ".example.com" }` shares a login across subdomains, and `domain` may be a `(hostname) => string | undefined` function when one deployment serves several apex domains (return undefined for a host-only cookie); `path`, `sameSite` (default `Lax`) and `secure` (default true) complete it. `LambderCaller` takes the same `sessionCookieDomain` so it can clear the CSRF cookie where the server set it.

Changing `domain` or `path` on a live deployment is a migration, because a browser identifies a cookie by (name, domain, path): the old copy stays beside the new one, both arrive on every request, and the browser's order says nothing about which is current. The controller handles the overlap: when the session cookie name arrives more than once it tries every copy (record lookup and CSRF pairing per copy), takes the live one, logs the ambiguity, and evicts the stale host-only twin from the response when a domain is configured. The reverse move, from a domain cookie back to host-only, cannot be evicted (this host cannot name the parent domain), so that copy is tolerated on every request until its own expiry. Renaming the cookies (`tokenCookieKey`, `csrfCookieKey`) alongside the scope change avoids the overlap entirely.

#### How the secrets are stored

The session cookie is `pkHash:secret`: `pkHash = sha256(sessionKey + sessionSalt)` and `secret` is 256 random bits. At rest the record stores only HASHES of the bearer secrets: the range key is `sha256(secret)` (so the lookup itself proves possession of the raw secret) and the CSRF token is stored as `csrfTokenHash`. The raw values exist only in the client's cookies and, transiently, on the `LambderCreatedSession` result the manager returns at creation; a read of the session table (backup leak, over-broad IAM, insider) therefore yields no usable cookies. Fast sha256 is the correct construction here rather than a password KDF: the secrets are 256-bit random, so there is nothing to brute-force, while `sessionSalt` peppers the identity-to-partition-key mapping so partition keys and cookie prefixes cannot be derived from (or linked to) known user ids.

#### Keeping session data fresh (`dataRefresh`)

Session data often caches values derived from external state: roles, permissions, feature flags. Opt in to `dataRefresh` to give that data a shelf life. Every session read checks it, and once `ttlSeconds` have passed your `refresh` callback rebuilds the data, which is persisted onto the same session record: same tokens, same cookies, the session itself is untouched. Changes to the source of truth then reach every live session within `ttlSeconds`, with no mass session invalidation.

```typescript
const lambder = initLambder<SessionData>().create({
    session: {
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING",
        dataRefresh: {
            ttlSeconds: 600, // data is renewed at most every 10 minutes
            refresh: async (session) => {
                const user = await loadUser(session.data.userId);
                if (!user || user.disabled) return null; // null ends the session
                return buildSessionData(user);
            },
        },
    },
});
```

Semantics:

- The callback must be a pure derivation of external state: concurrent reads may run it in parallel, last write wins.
- Returning `null` deletes the session; the request is answered as session-expired.
- Thrown errors fail the request as a `LambderSessionDataRefreshError` and leave the session untouched (they are never mistaken for a logout). Catch inside and return `session.data` to explicitly serve stale instead.
- Similarly, a DynamoDB failure while READING a session fails the request as a `LambderSessionReadError` instead of reading as "no session": answering session-expired there would make LambderCaller clear the client's cookies, turning an infra blip into a forced logout.
- The renewal write and the sliding-expiration write share a single DynamoDB put when both are due.
- Records created before `dataRefresh` was enabled renew on their first read.
- `updateSessionData()` marks data fresh (it was just written deliberately); `regenerateSession()` carries the old freshness stamp over.
- `expireSessionDataAllByKey(sessionKey)` stamps every session of a subject stale at once: call it after changing that subject's roles or permissions, and the change applies on their next request instead of within `ttlSeconds`, with no logout. It updates only `dataExpiresAt`, conditionally on the record still existing, so it neither resurrects a deleted session nor clobbers a concurrent write.

#### Session data at rest (`compression`)

`session.data` is stored Brotli-compressed by default: the record carries the data's JSON as Brotli bytes in `dataBr` beside its byte length in `dataBytes`, in place of a plain `data` attribute. It is the scheme `LambderDdbCache` and `LambderDdbIdempotency` already use, from the one shared codec that also restores compressed request payloads, and the byte length both bounds the decompression and verifies it, so a truncated record fails to decode rather than decoding to something else. Session data that caches roles, permissions or product lists typically shrinks 2-3x, which keeps a growing session within one DynamoDB read unit (4KB for the consistent reads sessions use) and one write unit (1KB) for longer.

```typescript
session: {
    // ...
    compression: true, // default: every record compressed, the same as { minBytes: 0 }
    // compression: { minBytes: 1024 } compresses only records whose JSON is 1KB+
    // compression: false stores data as a plain attribute
}
```

`quality` (Brotli 0-11, default 5) is also accepted; the option (`LambderCompressionOption`) is the same one `LambderDdbCache` and `LambderDdbIdempotency` take. Reads accept both record shapes, so the setting can be switched on or off on a live table: records written under the other setting keep reading, and each is rewritten in the current shape on its next write (a sliding-expiration or `dataRefresh` write included). A compressed record that fails to decode is treated like any malformed record: no session.

#### Session Controller

Access the session controller with `lambder.getSessionController(ctx)`:

| Method | Description |
|--------|-------------|
| `createSession(sessionKey, data?, ttlInSeconds?)` | Start new session, persist to DDB |
| `fetchSession()` | Fetch & validate existing session (throws if not found) |
| `fetchSessionIfExists()` | Returns session or null |
| `updateSessionData(newData)` | Update session data in DDB |
| `refreshSessionData()` | Run the `dataRefresh` callback now, regardless of TTL |
| `endSession()` | End session, delete from DDB |
| `endSessionAll()` | End all sessions for this sessionKey (all devices) |
| `deleteSessionAllByKey(sessionKey)` | Delete all sessions of any sessionKey (e.g. "log user X out everywhere") |
| `expireSessionDataAllByKey(sessionKey)` | Mark the data of all sessions of a sessionKey stale, so each renews via `dataRefresh` on its next read (no logout) |
| `regenerateSession()` | Regenerate token (use after password change) |

### Type-Safe Templating (html / xml)

Lambder ships zero-dependency tagged template literals instead of a template engine. Interpolated values are HTML-escaped automatically, and everything is plain TypeScript, so templates are fully type-checked and refactorable. **Full guide: [docs/TEMPLATING.md](./docs/TEMPLATING.md).**

```typescript
import { html, xml, raw } from "lambder";

// Values are escaped by default (XSS-safe); arrays flatten; nested fragments
// are not double-escaped; null/undefined/false render as empty string:
const list = html`<ul>${items.map((item) => html`<li>${item.label}</li>`)}</ul>`;

// Works for XML too (xml is an alias of html):
return res.xml(xml`<?xml version="1.0" encoding="UTF-8"?>
<urlset>${urls.map((loc) => xml`<url><loc>${loc}</loc></url>`)}</urlset>`);
```

### Templating with LambderTemplatingEngine

`LambderTemplatingEngine` is a standalone, comment-only HTML template engine. Every construct is an HTML comment, so templates survive HTML build pipelines (e.g. Vite) untouched, and during frontend development the browser simply renders the default content because the markers are invisible. **Full guide: [docs/TEMPLATING.md](./docs/TEMPLATING.md).**

```html
<title><!--slot:title-->Default Title<!--/slot:title--></title>   <!-- replaceable region -->
<!--slot:head/-->                                                  <!-- insert-only point -->
<!--if:isRtl--><body dir="rtl"><!--else--><body><!--/if:isRtl-->   <!-- conditional -->
```

```typescript
import { LambderTemplatingEngine, html } from "lambder";

const template = await LambderTemplatingEngine.fromFile("./templates/page.html");
const output = template.render({
    title: userInput,                                        // escaped (XSS-safe)
    head: html`<link rel="canonical" href="${canonicalUrl}" />`,
    isRtl: lang === "ar",
});
```

### Hosting a frontend build (servePublicFiles + templateFile)

Lambder has no SPA-specific machinery; hosting a frontend build is a recipe built from three generic primitives: `servePublicFiles()` (terminal slot serving real files: memory-cached, immutable Cache-Control for hashed assets, ETag/gzip, falls through when missing), `serveIndexHtml()` (next fallback slot, GET/HEAD + non-file-path gated) and `res.templateFile()` (render an HTML file through the templating engine, compiled once and cached). **Full guide with the multi-tenant recipe: [docs/TEMPLATING.md](./docs/TEMPLATING.md).**

#### Public file sources

The `files` option at creation is a `LambderFileSource`, an object with one method, `read(relativePath)`, returning `{ body, mimeType? }` or `null`. The instance owns one reader over it, `lambder.files`, and `servePublicFiles`, `serveIndexHtml`, `res.file` and `res.templateFile` all go through that reader, which does everything else for every source: traversal check, in-memory file cache for warm invocations (default 32MB, 2MB per file), compiled-template cache, mime fallback from the extension. Cache-Control (immutable for content-hashed names), ETag and compression are applied by the serving slot and the response pipeline. Built in:

```typescript
// A folder, typically the build output bundled with the deployment.
initLambder().create({ files: new LambderLocalFileSource({ root: path.resolve("./public") }) });

// S3. @aws-sdk/client-s3 is an optional peer dependency, loaded on first read.
initLambder().create({
    files: new LambderS3FileSource({ bucket: "myapp-web", prefix: "v42/", clientConfig: { region: "eu-central-1" } }),
});

// Cloudflare R2, or any S3-compatible store: point the client at its endpoint.
initLambder().create({
    files: new LambderS3FileSource({
        bucket: "myapp-web",
        clientConfig: { region: "auto", endpoint: "https://<account>.r2.cloudflarestorage.com", credentials: { accessKeyId, secretAccessKey } },
    }),
});

// Anything else: implement read().
initLambder().create({ files: { read: async (relativePath) => myStore.get(relativePath) } });

// The in-memory file cache, tuned or off, beside any source.
initLambder().create({ files: { source: new LambderS3FileSource({ bucket: "myapp-web" }), memoryCache: { maxBytes: 64_000_000, maxFileBytes: 4_000_000 } } });
initLambder().create({ files: { source: new LambderLocalFileSource({ root }), memoryCache: false } });
```

A missing S3 object reads as null; grant `s3:ListBucket` besides `s3:GetObject`, otherwise S3 answers a missing key with AccessDenied, which propagates as an error instead of falling through. The object's Content-Type is used unless it is a generic octet-stream, in which case the extension decides. Lambda's ~6MB response cap still applies to anything proxied this way: redirect large downloads to the bucket or CDN URL instead of serving them.

```typescript
// Zero-config single-tenant hosting:
lambder.servePublicFiles().serveIndexHtml();

// Templated shell:
lambder.servePublicFiles().serveIndexHtml(async (ctx, res) => {
    return res.templateFile("index.html", {
        title: pageTitle(ctx),
        head: html`<link rel="canonical" href="${canonicalUrl(ctx)}" />`,
    }, { cacheControl: "no-cache" });
});
```

### Render Context (ctx) Variables

The `ctx` object provides access to request data:

| Property | Description | Example |
|----------|-------------|----------|
| `host` | Request host | `"www.example.com"` |
| `path` | Request path | `"/api"` |
| `pathParams` | Path parameters (routes) | `{ userId: "123" }` |
| `method` | HTTP method | `"GET"`, `"POST"` |
| `get` | Query parameters | `{ page: "1" }` |
| `post` | POST body (parsed) | `{ name: "John" }` |
| `rawBody` | Decoded request body as received (webhook signatures) | `'{"a":1}'` |
| `ip` | Client IP (CF-Connecting-IP / X-Forwarded-For / source IP) | `"1.2.3.4"` |
| `header(name)` | Case-insensitive request header lookup | `ctx.header("accept-language")` |
| `cookie` | Cookies (the first value when a name arrived more than once) | `{ rememberMe: "true" }` |
| `cookieList` | Every value per cookie name, in header order (a name held at several scopes arrives several times) | `{ rememberMe: ["true"] }` |
| `headers` | Request headers | `{ "Content-Type": "..." }` |
| `event` | Raw Lambda event (APIGatewayProxyEvent or APIGatewayProxyEventV2) | - |
| `lambdaContext` | AWS Lambda Context | - |
| `apiName` | API name (for API calls) | `"getUser"` |
| `apiPayload` | Validated input | `{ userId: "123" }` |
| `session` | Session data | Available in `addSessionApi` |

### Resolver Methods

**Header Manipulation** (call before returning response):
- `res.addHeader(key, value)` - Adds a header value (can be called multiple times for same key)
- `res.setHeader(key, value)` - Sets a header (replaces existing values)
- `res.setCookie(name, value, options?)` - Adds a Set-Cookie header. Options: `domain` (a string, or a `(hostname) => string | undefined` function resolved against the request host), `path` (default `/`), `sameSite` (default `Lax`), `secure` (default true), `httpOnly`, `maxAge` (seconds), `expires` (Date), `encode` (default encodeURIComponent, which `ctx.cookie` reverses)
- `res.clearCookie(name, options?)` - Adds a Set-Cookie header that deletes the cookie. Pass the `domain` and `path` it was set with: a cookie's identity is (name, domain, path), so a deletion under another scope deletes nothing
- `res.logToApiResponse(data)` - Adds data to logList in API responses (debugging)

**Response Methods** (all accept an options object: `{ statusCode?, headers?, cacheControl?, compress?, etag? }`):

| Method | Description |
|--------|-------------|
| `res.raw(init)` | Custom HTTP response |
| `res.json(data, options?)` | JSON response |
| `res.text(data, options?)` | Plain text response |
| `res.xml(data, options?)` | XML response (accepts xml\`...\` templates) |
| `res.html(data, options?)` | HTML response (accepts html\`...\` templates) |
| `res.status(code, body?, options?)` | Response with any status code |
| `res.redirect(url, statusCode?, options?)` | Redirect (default: 302) |
| `res.status404(data, options?)` | 404 Not Found response |
| `res.fileBase64(base64, mimeType, options?)` | File from base64 content |
| `await res.file(path, options? & { fallback? })` | Serve file from public directory (404 when missing) |
| `await res.templateFile(path, data?, options?)` | Render an HTML file via LambderTemplatingEngine (cached; throws when missing) |
| `res.api(payload, config?, options?)` | Standardized API response |
| `res.apiBinary(payload, config?, options?)` | API response with forced compression |

Responses are finalized once at the end of the request: automatic compression (when the client accepts it, the body is compressible and large enough), automatic ETag + `If-None-Match` 304 handling on GET/HEAD, and a clear error if the body would exceed Lambda's ~6MB cap. Override per response with `compress: true | false` and `etag: false`.

The encoding is negotiated against `Accept-Encoding` in the order `compression.encodings` declares, `["br", "gzip"]` by default. Brotli at quality 5 (`compression.quality`) runs at roughly gzip's speed while producing smaller bodies: 15-25% on markup and prose, and substantially more on the repetitive record lists API responses tend to be. Because the ~6MB cap is checked on the FINAL body, that is headroom as well as bandwidth. A client that offers only gzip gets gzip, and `compression: { encodings: ["gzip"] }` turns Brotli off entirely for a CDN or client that mishandles it. `Vary: Accept-Encoding` rides every compressible response, whether or not this particular client accepted an encoding, so shared caches stay correct.

```typescript
initLambder().create({
    compression: { minBytes: 860, encodings: ["br", "gzip"], quality: 5 },  // the defaults
    // compression: false,  // no automatic compression at all
});
```

**API Config Options**: `{ notAuthorized, message, errorMessage, versionExpired, sessionExpired, logList }`

**Die Methods**: `res.die.*` - Builds the response and throws it, immediately halting the request at any call depth (handlers, hooks, nested helper functions). Plain `throw res.html(...)` works the same way.

### Typed API Refusals (refuse / LambderApiError)

A refusal ("you are not allowed", "quota exceeded") is not a crash. `res.die.*` covers refusals where you hold the resolver, but shared helpers (permission checks, validators) usually don't. The one-liner for the common case is `refuse()`: callable from anywhere in an API call's stack, it throws a typed refusal carrying the standard `LambderRefusalMessage` shape (`{ type, code?, title?, content }`) that the pipeline maps onto the envelope's `errorMessage`, so refusals never pollute crash logging and clients get a parseable response:

```typescript
import { refuse } from "lambder";

if (!row) refuse("Record not found.");                                  // { type: "warning", content }
if (!isAdmin) refuse("Admins only.", { notAuthorized: true });          // + envelope flag
refuse("Too many attempts.", { type: "error", statusCode: 429 });       // custom rendering intent + status
if (exists) refuse("Already reported.", { code: "ALREADY_REPORTED" }); // + machine-readable identity
// TypeScript applies never-return narrowing: after `if (!row) refuse(...)`, row is defined.
```

`code` is the refusal's identity for machines: clients branch and translate on it (a translated client never displays `content`, it looks the code up), and `content` stays the human-readable fallback for codes a client does not know yet. Keep your app's codes as one typed vocabulary in shared code. The framework stamps the refusals it authors itself with `LAMBDER_REFUSAL_CODES` (exported from `lambder` and `lambder/client`) under the reserved `lambder/` prefix, so app codes never collide: `rateLimited`, `duplicateInFlight`, `invalidIdempotencyKey`, `apiNotFound`. A rate-limit policy's own `errorMessage` inherits `lambder/rate-limited` unless it sets a code, so an `errorMessageHandler` can treat every rate limit alike and still special-case the ones you name.

For full control of the errorMessage payload (apps with their own message vocabulary), throw `LambderApiError` directly; `refuse()` is sugar over it:

```typescript
import { LambderApiError } from "lambder";

// In any helper, no resolver needed:
export const requirePermission = (granted: boolean) => {
    if (!granted) throw new LambderApiError("Permission denied.", {
        notAuthorized: true,                                    // envelope flag -> caller's notAuthorizedHandler
        errorMessage: { type: "warning", content: "Not allowed." }, // any shape your errorMessageHandler expects
        // sessionExpired: true,                                // optional envelope flag
        // statusCode: 403,                                     // optional; default 200 (avoid 5xx and 422)
    });
};
```

`errorMessage` defaults to the error's message string, so `throw new LambderApiError("Nope.")` alone is already visible to the client. Thrown outside an API call (e.g. in a route handler) it behaves like a normal error. The class is isomorphic and dependency-free, so shared server/browser packages can import it safely. Detection is brand-based (`isLambderApiError`), so it works even when two copies of lambder end up in one bundle.

Related: when an API call crashes with no `setGlobalErrorHandler` (or the handler itself fails), the last-resort 500 is now a JSON envelope (`{ payload: null, errorMessage: "Internal server error." }`) instead of a plain-text page; routes keep the plain-text 500.

### Declarative API Policies (rate limits, guards, idempotency)

Declare named building blocks once; reference them from API definitions with full type inference (unknown names are compile errors, and everything is re-asserted at registration time for plain-JS safety). Each piece is independent and optional.

```typescript
import { initLambder, LambderDdbRateLimiter, LambderDdbIdempotency, lambderGuard, lambderRateLimitKey, refuse } from "lambder";

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    // 1. Rate limiting: your limiter instance + named policies. Each policy
    //    declares its windows, what one counter tracks ("per"), and what one
    //    budget spans ("budget"): "perApi" (default) gives every referencing
    //    API its own counter, so three APIs on a 60/min policy allow one IP
    //    180/min in total; "perPolicy" makes every referencing API share ONE
    //    counter. The policy IS the group: separate shared budgets for, say,
    //    user APIs and report APIs are two policies.
    rateLimits: {
        limiter: new LambderDdbRateLimiter({ tableName: "app-rate-limiter", region: "us-east-1", failOpen: true }),
        policies: {
            authPerIp:    { perMin: 5, perHour: 30, per: "ip" },
            writePerUser: { perMin: 30, per: "session" },   // only referable from addSessionApi (also enforced at compile time)
            codePerEmail: {
                perMin: 3,
                // ONE combined budget across every API that references this
                // policy: send + register + reset share the 3/min.
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
    // 2. Idempotency: a store instance + replay defaults. May share the rate
    //    limiter's table (records use an IDEM# key prefix).
    idempotency: {
        store: new LambderDdbIdempotency({ tableName: "app-rate-limiter", region: "us-east-1" }),
        defaultTtlSeconds: 24 * 3600,
        failOpen: true,   // DynamoDB down => execute without dedupe instead of failing
    },
    // 3. Named guards. Input modes: apiInput checks a slice of the API's own
    //    payload (the schema keeps the field; the guard is declarable only
    //    where the payload type passes both); guardInput is the guard's OWN
    //    value, sent separately by the caller via options.guardInputs and
    //    made mandatory by the contract, so forgetting it is a compile error
    //    at the call site; or neither. Both are validated pre-run and typed
    //    in the handler. On top of that a guard may require a session
    //    (session: true, declarable only on addSessionApi), take a per-API
    //    PARAM (annotate a 4th handler argument), and RETURN a value that
    //    lands typed on the API handler's ctx.guardData[name].
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
                requirePermissionOrRefuse(ctx.session, permission),   // return value → ctx.guardData.orgPermission
        }),
    },
});

lambder.addApi("public.resetPassword", {
    // captchaToken is NOT declared here: it travels in the separate
    // guardInputs channel, so the guard validates and consumes it and the
    // handler never sees it. `email` IS declared: the codePerEmail key runs
    // in apiInput mode against the API's own payload.
    input: z.object({ email: z.string().email() }),
    output: z.object({ ok: z.boolean() }),
    rateLimit: ["authPerIp", "codePerEmail"],   // stacked: checked in order, first exceeded refuses (429 envelope + Retry-After)
    guards: "captcha",                          // one name, a non-empty list of names, or a non-empty { name: param } map
}, handler);

lambder.addSessionApi("secure.order.create", {
    input: OrderSchema,
    output: OrderResultSchema,
    // Map form: tune a perApi policy for this API. Overrides merge over the
    // policy's windows (perMin here, the policy's other windows still apply)
    // and errorMessage is overridable too. Window overrides on a perPolicy
    // policy are a startup error: one shared counter has one set of limits.
    rateLimit: { writePerUser: { perMin: 10 } },
    guards: { orgPermission: "ORDERS.CREATE" }, // param typed per guard; entries run in insertion order
    idempotency: true,                          // or { ttlSeconds: 3600 }; type error unless created with idempotency
}, async (ctx, res) => {
    const { organizationId } = ctx.guardData.orgPermission;  // typed guard output
    // ...
});
```

Guard results are typed end to end: the handler's `ctx.guardData` carries exactly the declared guards that return a value, a session guard on a public API is a compile error (and a startup assert), an apiInput guard is declarable only where the API's schema carries its fields, and a parameterized guard's param is typechecked in the declaration.

**Requiring an authorization declaration (`requireSessionApiGuards`)**: by default a session API may declare no guards, which reads as "any signed-in user". Once an app has an authorization vocabulary, that silence is where defects hide: the guard exists, a new endpoint forgets it, and nothing notices. With `requireSessionApiGuards: true` at creation, `guards` becomes a required field of every `addSessionApi`: omitting it is a compile error at the registration site ("Property 'guards' is missing"), and a plain-JS registration throws. Public APIs are unaffected. An API that legitimately needs no authorization beyond the session (the signed-in user's own account, a log-out) declares a named no-op session guard, so the opt-out is explicit, greppable, and cannot be used on a public API:

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
lambder.addSessionApi("secure.report.list", { input, output }, handler);   // compile error: which guard?
lambder.addSessionApi("secure.report.list", { input, output, guards: {} }, handler);   // compile error: {} declares no guard
```

**The same for public APIs (`requirePublicApiGuards`)**: public APIs are open by default, and that remains the default. An app whose public surface has grown past a handful of endpoints can turn `requirePublicApiGuards: true` on to make each one's openness a written decision instead of an omission. Not every public endpoint has a control that can be hoisted into a guard (an endpoint that checks a password *is* the check), so the vocabulary an app declares here is usually a real guard for what is a genuine precondition, plus named no-op guards for the rest. The two flags are independent; either or both may be on.

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

For api modules split across files, DERIVE the annotation type from the real instance instead of writing it by hand: create the instance next to the policy declarations and export `typeof` it. The type can never drift from what actually runs, and modules import it without a cycle (the app file imports no modules):

```typescript
// app.ts: declarations + the fully configured instance
export const lambderApp = initLambder<SessionData>().create({
    apiPath: "/api",
    session: { tableName: "app-session", tableRegion: "us-east-1", sessionSalt: "..." },
    rateLimits: { limiter, policies: apiRateLimitPolicies },
    idempotency: { store: idempotencyStore },
    guards: apiGuards,
});
export type AppLambder = typeof lambderApp;

// orders.ts: an api module
export const orderApi = (lambder: AppLambder) => lambder.addSessionApi(...);

// index.ts: registration only (hooks, routes, modules)
const lambder = lambderApp.addHook(...).use(orderApi)...;
export const handler = lambder.getHandler();
```

Request flow per API: session (session APIs) → idempotency replay lookup → rate limits → guards → zod validation → idempotency claim → handler → idempotency store. The replay lookup runs first on purpose: a completed idempotent request answers its stored response without burning rate-limit quota or re-running guards (the original already passed them, and no handler executes either way). Refusals ride the envelope via `LambderApiError` (429 rate limited, 409 duplicate in flight), carrying the standard `LambderRefusalMessage` shape unless a policy names its own `errorMessage`, so the caller's `errorMessageHandler` surfaces them with zero client code. A 429 also carries `Retry-After` (the exceeded fixed window's reset; `LambderCaller` outcomes expose it as `retryAfterSeconds`, and the CORS layer lists it in `Access-Control-Expose-Headers` by default).

**Rate limits count attempts, not successes.** Each window is one atomic conditional increment, and a refused request keeps every increment made before the refusal: the smaller windows of the refusing policy, every policy listed before it, and all of them when a later guard or the input validation refuses. There is no compensating decrement (it would give up the conditional-ADD atomicity and add a write per refusal). So order stacked policies by which counter you want charged on refusals: `["authPerIp", "codePerEmail"]` still charges the IP when the per-email cap refuses, which is the abuse-resistant direction.

Preflight input slices (guard `apiInput`/`guardInput` values, rate-limit `apiInput` keys) answer a rejection through the same path as the API's own schema: `setApiInputValidationErrorHandler` when set, otherwise the standard 422 body. One failure, one shape, whichever schema rejected it.

**Idempotency semantics**: the client sends an `idempotencyKey` per call (see LambderCaller below); generate it once per logical operation with `LambderCaller.createIdempotencyKey()` and reuse it on retries. Keys must be 16-200 characters and UNGUESSABLE random (shorter keys refuse with 400): on session APIs the scope is session + API name + key, and on public APIs it is the key itself + API name, deliberately NOT the client IP, because the retry idempotency exists for (a timeout followed by a network switch) frequently arrives from a new IP. Concurrent duplicates of an in-flight request refuse with 409, repeats of a completed one replay the stored response verbatim until the TTL (response headers included, so headers set via `res.setHeader`/`res.addHeader` replay too), and a crashed original releases its claim so a retry actually retries. The replay rule for failures: RESPONSES are stored and replayed, refusals returned as envelopes (`res.api(null, { errorMessage })`) and thrown responses (`res.die.*`) included; EXCEPTIONS are not, so a thrown `LambderApiError`/`refuse()` releases the claim and a retry re-executes and decides afresh. Stored bodies of 1KB or more are Brotli-compressed by default (the same scheme and `compression` option as LambderDdbCache: `true`, `false`, or `{ minBytes, quality }`, default `{ minBytes: 1024, quality: 5 }`; records of either shape read back, so it can be switched on a live table): JSON envelopes typically shrink 5-10x, which cuts DynamoDB write cost, and the ~350KB item budget applies to the COMPRESSED bytes, so even large responses usually stay replayable. Responses with status ≥ 500, bodies over the budget even compressed, and responses that set cookies are never stored (replaying one request's Set-Cookie, e.g. session tokens, into another would be wrong; such APIs still get in-flight 409 dedupe, just not replays). Claims are owner-checked, so an original that stalls past the pending window can no longer overwrite or delete the claim a retry has since taken. Requests without a key execute normally.

Also enforced at registration: **duplicate API names throw** (dispatch is first-match, so a second registration of the same name would be silently dead code).

### DynamoDB Cache (LambderDdbCache)

Standalone, persistent JSON cache backed by a DynamoDB table (`pk`/`sk` keys + `expiresAt` TTL attribute, same shape as the session table). Items are prefixed `CACHE#<namespace>#`, and the rate limiter (`RL#`) and idempotency store (`IDEM#`) prefix theirs too, so all three non-session systems can share one table without collisions; keep sessions in their own table for IAM scoping. Brotli-compressed values (the shared `compression` option), in-memory LRU layer, single-flight deduplication, a DynamoDB lease so only one Lambda fills a missing key, fail-open semantics, and optional grouped keys for group invalidation. Server-only. **Full guide with table setup: [docs/DDB_CACHE.md](./docs/DDB_CACHE.md).**

```typescript
import { LambderDdbCache } from "lambder";

const cache = new LambderDdbCache({
    tableName: "myapp-cache",
    region: "us-east-1",
    namespace: "geo",            // isolates keys per domain
    defaultTtlSeconds: 24 * 3600,
});

const city = await cache.getOrSet(`city:${slug}`, async () => fetchCityFromDb(slug), {
    ttlSeconds: 7 * 24 * 3600,
});
// Also: cache.get(key), cache.set(key, value, { ttlSeconds }), cache.has(key), cache.delete(key)

// A key can also be a { pk, sk } pair, which groups related entries under one
// partition so the whole group can be invalidated without listing its members:
const window = { pk: `division:${divisionId}`, sk: `${from}:${to}` };
await cache.getOrSet(window, () => loadDivision(divisionId, from, to));
await cache.deletePartition(`division:${divisionId}`);   // every cached window of it
await cache.listSortKeys(`division:${divisionId}`);      // ["1700:1800", "1700:1900"]
```

### Typed Translations (createLambderI18n)

Standalone, framework-free i18n with a compile-time contract: keys and `{token}` params are inferred from the default-language dictionary, components extend the base keys with their own (strictly, or partially with fallback), and the active language resolves automatically (custom detector → browser languages → default). **Full guide: [docs/I18N.md](./docs/I18N.md).**

```typescript
import { createLambderI18n } from "lambder";

export const i18n = createLambderI18n({
    languages: { en: { name: "English" }, tr: { name: "Türkçe" }, de: { name: "Deutsch" } },
    defaultLanguage: "en",
    enforced: ["en"],                       // languages every dictionary must provide
    base: {                                 // strict: all languages, all keys
        en: { greet: "Hello {name}" },
        tr: { greet: "Merhaba {name}" },
        de: { greet: "Hallo {name}" },
    },
});

// componentA.ts — only enforced languages required; de falls back to en:
const cI18n = i18n.extendPartial({ en: { compute: "Compute" }, tr: { compute: "Hesapla" } });
cI18n.t("compute");                 // auto-resolved language
cI18n.t("greet", { name: "Ada" });  // base keys + params, compile-time enforced
cI18n.forLanguage("tr")("compute"); // explicit (per-request backend use)
```

## Frontend Usage with LambderCaller

LambderCaller is a frontend companion library for Lambder (only 2kb compressed) designed to simplify making type-safe API requests to your Lambder backend. Import it from the `lambder/client` entry: everything reachable from there is browser-safe by construction (no AWS SDK, no Node built-ins, no server pipeline), so your bundle can never pick up server code.

### Basic Setup with Type Safety

```typescript
import { LambderCaller } from "lambder/client";
import type { ApiContractType } from "./backend/handler"; // Import the inferred contract type

const lambderCaller = new LambderCaller<ApiContractType>({
    apiPath: "/api",
    isCorsEnabled: false,
    fetchStartedHandler: ({ fetchParams, activeFetchList }) => {
        console.log("API Called:", fetchParams.apiName);
    },
    fetchEndedHandler: ({ fetchParams, fetchResult, activeFetchList }) => {
        console.log("Ongoing calls:", activeFetchList.length);
    },
    errorMessageHandler: (message) => {
        console.error("LambderCaller:", message);
    },
});

// Fully typed API calls!
const user = await lambderCaller.api("getCompanyPage", { companyName: "Acme" });
// TypeScript knows:
// - Available API names (autocomplete)
// - Required input type
// - Expected output type
```

### Compressed Request Payloads

Large payloads run into Lambda's ~6MB invoke payload cap long before the API Gateway limit, and the cap applies to what the gateway hands the function. `requestCompression` gzips the payload of any call whose JSON reaches the threshold, so that budget holds the compressed bytes instead of the raw ones:

```typescript
const lambderCaller = new LambderCaller<ApiContractType>({
    apiPath: "/api",
    isCorsEnabled: false,
    requestCompression: true,            // { minBytes: 4096 }
    // requestCompression: { minBytes: 64_000 },  // only genuinely large calls
});

// Nothing at the call sites changes; this one goes compressed, that one plain.
await lambderCaller.api("importStops", { stops: bigArray });
await lambderCaller.api("getStop", { id: "42" });

// Per call, either way:
await lambderCaller.api("importStops", huge, { compressRequest: false });
```

A compressed call sends `payloadGz` (gzip bytes, base64) beside `payloadBytes` (the JSON's UTF-8 byte length) in place of `payload`. It is only sent when it is smaller than the JSON it replaces: a payload that is mostly a base64 image gzips to nearly its own size, and such a call goes plain rather than slightly larger. Everything else in the envelope stays plain text, so `apiName` routing, request logs and MSW mocks are unaffected, and the request stays `application/json`: no `Content-Encoding` negotiation for a gateway, CDN or proxy to get wrong, and no new CORS preflight surface. Base64 inside the JSON rather than a binary body is not a compromise for the size cap, because API Gateway hands a binary request body to Lambda base64-encoded anyway; base64's 4/3 overhead applies to bytes that already shrank several times over. Record-shaped JSON typically gzips 5-10x, so a ~5MB budget of compressed payload carries roughly 25-40MB of it.

The option is off by default and safe to turn on or off at any time: the server understands both shapes regardless, so a deployed client and server never need to agree. gzip rather than Brotli because the browser's `CompressionStream` offers gzip and deflate only; responses, compressed by Node, do prefer Brotli. A runtime without `CompressionStream` sends payloads plainly.

**Server side**: nothing to enable. The payload is restored before rate-limit key slices, guards and input validation run, so handlers, schemas and policies see an ordinary payload and need no awareness of the wire format. `payloadBytes` both bounds the decompression and verifies it (the restored length must match exactly), so a truncated or hostile body is refused rather than expanded, and `maxRequestPayloadBytes` at creation (default 20,000,000) caps what any body may expand to. Size that ceiling to the function's memory: the restored JSON is parsed in full before any session or policy check, and a parsed document occupies several times its text size on the heap. Every malformed case answers a 400 envelope coded `lambder/invalid-request-payload` instead of a 500.

```typescript
initLambder().create({ apiPath: "/api", maxRequestPayloadBytes: 20_000_000 });
```

Compression moves the ceiling rather than removing it. Past roughly 25-40MB of JSON the answer is a presigned S3 upload plus a job reference, or chunking, not a better codec.

### Failure Semantics (apiOutcome, timeouts, per-call overrides)

`api()` collapses every failure to `null`, which is indistinguishable from a legitimately-null payload. When the call site needs to know why, use `apiOutcome()`; it never throws and resolves to a discriminated union:

```typescript
const outcome = await lambderCaller.apiOutcome("getCompanyPage", { companyName: "Acme" });
if (outcome.ok) {
    render(outcome.payload);
} else if (outcome.reason === "network" || outcome.reason === "timeout") {
    showOfflineScreen();
} else if (outcome.reason === "sessionExpired") {
    redirectToLogin();
} else {
    // 'server' (5xx / non-envelope body), 'validation' (422), 'versionExpired',
    // 'notAuthorized', 'errorMessage' (structured refusal), 'unknown'
    showError(outcome.errorMessage);
}
```

Every configured handler still fires on the matching failure, so global UX (toasts, re-login prompts) lives in the constructor while individual call sites branch on the outcome.

Also available:

- **Timeouts**: pass `timeoutMs` in the constructor for a default (API Gateway caps around 29s, so ~30000 is sensible) and/or per call; timed-out calls abort the fetch and report `reason: 'timeout'`. A per-call `signal` combines with the timeout.
- **Per-call handler overrides**: every constructor handler (`errorHandler`, `sessionExpiredHandler`, `errorMessageHandler`, ...) can be overridden in the options of a single `api`/`apiOutcome` call.
- **Guard inputs**: for APIs whose guards run in guardInput mode, pass their values per call as `guardInputs: { <guardName>: value }`; the typed contract makes the options argument (and the correct value shape) mandatory for those APIs. A `guardInputsProvider` on the caller supplies values for every call from one place, keyed by guard name, with per-call `guardInputs` merged on top; name the guards it covers in the caller's second type parameter, `new LambderCaller<Contract, "orgPermission">({ guardInputsProvider: () => ({ orgPermission: { orgSlug } }), ... })`, and calls to APIs whose guardInput guards are all covered take an optional options argument again.
- **Idempotency keys**: pass `idempotencyKey` per call for APIs declared idempotent on the server (see Declarative API Policies). Generate it once per logical operation with `LambderCaller.createIdempotencyKey()` (safe in insecure contexts where `crypto.randomUUID` is missing) and send the same key on retries; rotate after a confirmed success. `LambderCaller.createIdempotencyKeyScope()` packages that pattern for a component performing one operation repeatedly: read `scope.current` on every attempt, call `scope.rotate()` after a confirmed success. Keys must be unguessable random and 16-200 characters (they scope the replay record for logged-out clients); the server refuses shorter keys with a 400.

### Benefits

✅ **No Manual Type Definitions** - Types are inferred from your Zod schemas  
✅ **Single Source of Truth** - API contract comes from your backend code  
✅ **Runtime Validation** - Zod validates inputs automatically  
✅ **Compile-Time Safety** - TypeScript catches errors before runtime  
✅ **Autocomplete** - IDE suggests available APIs as you type  
✅ **Zero Overhead** - Type-only imports, no runtime code bloat  

📖 **[Read the Quick Start Guide](docs/TYPE_SAFE_QUICK_START.md)** for more details and examples!

## Testing with LambderMSW

LambderMSW provides seamless integration with [MSW (Mock Service Worker)](https://mswjs.io/) for testing your APIs with full type safety.

```typescript
import { LambderMSW } from 'lambder/testing';
import { setupServer } from 'msw/node';
import type { ApiContractType } from './backend/handler';

const lambderMSW = new LambderMSW<ApiContractType>({
    apiPath: '/api',
    msw: await import('msw'),
});

const handlers = [
    // Mock API with full type safety! ✨
    lambderMSW.mockApi('getUser', async (payload) => {
        // payload is typed based on your Zod schema
        return {
            id: payload.userId,
            name: 'John Doe',
            email: 'john@example.com'
        };
    }),
    
    // Simulate delays and custom responses
    lambderMSW.mockApi('createUser', async (payload) => {
        return { id: '123', name: payload.name, email: payload.email };
    }, { 
        delay: 500,
        message: 'User created successfully'
    }),
    
    // Mock session expired
    lambderMSW.mockSessionExpired('protectedApi'),
];

const server = setupServer(...handlers);
```

📖 **[Read the LambderMSW Guide](docs/LAMBDER_MSW.md)** for complete testing documentation!

## Contributing

Contributions are welcome! Especially for documentation. If you have an idea for an improvement or have found a bug, please open an issue or submit a pull request.

## License

This project is licensed under the [MIT License](License.md).
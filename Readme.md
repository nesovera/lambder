# Lambder - Serverless NodeJS Web Framework (v4)

Lambder is a highly opinionated dynamic serverless framework designed to facilitate the management and implementation of routes and APIs within AWS Lambda functions, specifically tailored for TypeScript projects. It provides a streamlined approach to handling HTTP requests, managing sessions, and defining API routes, making serverless application development more intuitive and structured.

**New in v4:**

- **Declarative auth as guards**: guards take per-API params (`guards: { orgPermission: "SOME.PERMISSION" }`), can require a session (`session: true`, compile-checked), and RETURN typed values that land on the handler's `ctx.guardData[name]`. Together with the apiInput/guardInput input modes, permission checks and device auth become registration-time declarations instead of per-handler boilerplate.
- **Hardened policy layer**: rate-limit policies can share one counter across APIs (`scope: "policy"`); idempotency replays answer before rate limits, survive client IP changes (key-scoped for public APIs, 16-char minimum keys), store full response headers, refuse to store Set-Cookie responses, and Brotli-compress stored bodies of 1KB+ so the ~350KB replay budget applies to compressed bytes.
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
import { initLambder } from 'lambder';
import { z } from 'zod';
import * as path from 'path';

interface SessionData { userId: string; }

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    publicPath: path.resolve(`./public`),
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
    // Serve real files from publicPath. This is a terminal fallback slot, NOT
    // a catch-all route, so it can never shadow routes registered after it.
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
import Lambder from "lambder";

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

const lambder = new Lambder({ publicPath: './public' })
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
| `cookie` | Cookies | `{ rememberMe: "true" }` |
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
| `res.apiBinary(payload, config?, options?)` | API response with forced gzip |

Responses are finalized once at the end of the request: automatic gzip (when the client accepts it, the body is compressible and large enough), automatic ETag + `If-None-Match` 304 handling on GET/HEAD, and a clear error if the body would exceed Lambda's ~6MB cap. Override per response with `compress: true | false` and `etag: false`.

**API Config Options**: `{ notAuthorized, message, errorMessage, versionExpired, sessionExpired, logList }`

**Die Methods**: `res.die.*` - Builds the response and throws it, immediately halting the request at any call depth (handlers, hooks, nested helper functions). Plain `throw res.html(...)` works the same way.

### Typed API Refusals (refuse / LambderApiError)

A refusal ("you are not allowed", "quota exceeded") is not a crash. `res.die.*` covers refusals where you hold the resolver, but shared helpers (permission checks, validators) usually don't. The one-liner for the common case is `refuse()`: callable from anywhere in an API call's stack, it throws a typed refusal carrying the standard `LambderRefusalMessage` shape (`{ type, title?, content }`) that the pipeline maps onto the envelope's `errorMessage`, so refusals never pollute crash logging and clients get a parseable response:

```typescript
import { refuse } from "lambder";

if (!row) refuse("Record not found.");                                  // { type: "warning", content }
if (!isAdmin) refuse("Admins only.", { notAuthorized: true });          // + envelope flag
refuse("Too many attempts.", { type: "error", statusCode: 429 });       // custom rendering intent + status
// TypeScript applies never-return narrowing: after `if (!row) refuse(...)`, row is defined.
```

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
    //    declares its windows AND what one counter tracks ("per").
    rateLimits: {
        limiter: new LambderDdbRateLimiter({ tableName: "app-rate-limiter", region: "us-east-1", failOpen: true }),
        policies: {
            authPerIp:    { perMin: 5, perHour: 30, per: "ip" },
            writePerUser: { perMin: 30, per: "session" },   // only referable from addSessionApi (also enforced at compile time)
            codePerEmail: {
                perMin: 3,
                // scope "policy": ONE combined budget across every API that
                // references this policy (send + register + reset share the
                // 3/min). Default scope "api" gives each API its own counter.
                scope: "policy",
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
    rateLimit: ["authPerIp", "codePerEmail"],   // stacked: checked in order, first exceeded refuses (429 envelope)
    guards: "captcha",                          // one name, a list of names, or a { name: param } map
}, handler);

lambder.addSessionApi("secure.order.create", {
    input: OrderSchema,
    output: OrderResultSchema,
    rateLimit: "writePerUser",
    guards: { orgPermission: "ORDERS.CREATE" }, // param typed per guard; entries run in insertion order
    idempotency: true,                          // or { ttlSeconds: 3600 }; type error unless created with idempotency
}, async (ctx, res) => {
    const { organizationId } = ctx.guardData.orgPermission;  // typed guard output
    // ...
});
```

Guard results are typed end to end: the handler's `ctx.guardData` carries exactly the declared guards that return a value, a session guard on a public API is a compile error (and a startup assert), an apiInput guard is declarable only where the API's schema carries its fields, and a parameterized guard's param is typechecked in the declaration.

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

Request flow per API: session (session APIs) → idempotency replay lookup → rate limits → guards → zod validation → idempotency claim → handler → idempotency store. The replay lookup runs first on purpose: a completed idempotent request answers its stored response without burning rate-limit quota or re-running guards (the original already passed them, and no handler executes either way). Refusals ride the envelope via `LambderApiError` (429 rate limited, 409 duplicate in flight), so the caller's `errorMessageHandler` surfaces them with zero client code.

**Idempotency semantics**: the client sends an `idempotencyKey` per call (see LambderCaller below); generate it once per logical operation with `LambderCaller.createIdempotencyKey()` and reuse it on retries. Keys must be 16-200 characters and UNGUESSABLE random (shorter keys refuse with 400): on session APIs the scope is session + API name + key, and on public APIs it is the key itself + API name, deliberately NOT the client IP, because the retry idempotency exists for (a timeout followed by a network switch) frequently arrives from a new IP. Concurrent duplicates of an in-flight request refuse with 409, repeats of a completed one replay the stored response verbatim until the TTL (response headers included, so headers set via `res.setHeader`/`res.addHeader` replay too), and a crashed original releases its claim so a retry actually retries. The replay rule for failures: RESPONSES are stored and replayed, refusals returned as envelopes (`res.api(null, { errorMessage })`) and thrown responses (`res.die.*`) included; EXCEPTIONS are not, so a thrown `LambderApiError`/`refuse()` releases the claim and a retry re-executes and decides afresh. Stored bodies of 1KB or more are Brotli-compressed (the same scheme as LambderDdbCache; `compressionQuality` on the store, default 5): JSON envelopes typically shrink 5-10x, which cuts DynamoDB write cost, and the ~350KB item budget applies to the COMPRESSED bytes, so even large responses usually stay replayable. Responses with status ≥ 500, bodies over the budget even compressed, and responses that set cookies are never stored (replaying one request's Set-Cookie, e.g. session tokens, into another would be wrong; such APIs still get in-flight 409 dedupe, just not replays). Claims are owner-checked, so an original that stalls past the pending window can no longer overwrite or delete the claim a retry has since taken. Requests without a key execute normally.

Also enforced at registration: **duplicate API names throw** (dispatch is first-match, so a second registration of the same name would be silently dead code).

### DynamoDB Cache (LambderDdbCache)

Standalone, persistent JSON cache backed by a DynamoDB table (`pk`/`sk` keys + `expiresAt` TTL attribute, same shape as the session table). Items are prefixed `CACHE#<namespace>#`, and the rate limiter (`RL#`) and idempotency store (`IDEM#`) prefix theirs too, so all three non-session systems can share one table without collisions; keep sessions in their own table for IAM scoping. Brotli-compressed values, in-memory LRU layer, single-flight deduplication, a DynamoDB lease so only one Lambda fills a missing key, and fail-open semantics. Server-only. **Full guide with table setup: [docs/DDB_CACHE.md](./docs/DDB_CACHE.md).**

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
- **Guard inputs**: for APIs whose guards run in guardInput mode, pass their values per call as `guardInputs: { <guardName>: value }`; the typed contract makes the options argument (and the correct value shape) mandatory for those APIs.
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
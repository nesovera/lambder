# Lambder - Serverless NodeJS Web Framework (v3)

Lambder is a highly opinionated dynamic serverless framework designed to facilitate the management and implementation of routes and APIs within AWS Lambda functions, specifically tailored for TypeScript projects. It provides a streamlined approach to handling HTTP requests, managing sessions, and defining API routes, making serverless application development more intuitive and structured.

**New in v3:** Public file serving with `servePublicFiles()` + `serveIndexHtml()`, unified `addAction()` for non-HTTP triggers, automatic gzip + ETag, thrown responses with a real `die`, the comment-based `LambderTemplatingEngine`, type-safe `html`/`xml` tagged templates, and API Gateway HTTP API (payload v2) / Lambda Function URL support.

## Features

- **Type-Safe APIs with Zod**: Define inputs and outputs with Zod schemas. Get automatic runtime validation and compile-time type inference.
- **Method Chaining**: Build your API contract incrementally with a fluent interface.
- **Simple API & Route Declaration**: Define your APIs and routes using concise and expressive syntax.
- **Session Management**: Built-in session management to secure and personalize user experiences.
- **Flexible Hooks System**: Employ hooks to execute code at different stages of the request lifecycle.
- **Error Handling**: Comprehensive error handling capabilities, including global error handlers and route-specific fallbacks.
- **Seamless Integration**: Works with API Gateway REST APIs (payload v1), HTTP APIs (payload v2) and Lambda Function URLs; the payload format is detected per event.

## Installation

```bash
npm install lambder zod
# or
yarn add lambder zod
```

## Backend Usage

### Basic Setup

```typescript
import Lambder from 'lambder';
import { z } from 'zod';
import * as path from 'path';

const lambder = new Lambder({
    apiPath: "/api",
    publicPath: path.resolve(`./public`),
});

// Enable session and CORS
lambder
    .enableDdbSession({
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING"
    })
    // true allows any origin; or configure: { origins: ["https://app.example.com"], credentials: true }
    .enableCors(true);

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

Enable DynamoDB-based sessions with `enableDdbSession()`. Optional configuration:

```typescript
lambder
    .enableDdbSession({
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING",
        enableSlidingExpiration: true // Optional: extend session on each access
    })
    // Optionally customize session cookie names (defaults: LMDRSESSIONTKID, LMDRSESSIONCSTK)
    .setSessionCookieKey("MY_SESSION_TOKEN", "MY_CSRF_TOKEN");
```

#### DynamoDB Session Table Structure

- Primary Key: "pk"
- Sort Key: "sk"
- TTL Key: "expiresAt" (optional, recommended)

See [docs/DYNAMODB_SETUP.md](docs/DYNAMODB_SETUP.md) for detailed setup instructions.

#### Session Controller

Access the session controller with `lambder.getSessionController(ctx)`:

| Method | Description |
|--------|-------------|
| `createSession(sessionKey, data?, ttlInSeconds?)` | Start new session, persist to DDB |
| `fetchSession()` | Fetch & validate existing session (throws if not found) |
| `fetchSessionIfExists()` | Returns session or null |
| `updateSessionData(newData)` | Update session data in DDB |
| `endSession()` | End session, delete from DDB |
| `endSessionAll()` | End all sessions for this sessionKey (all devices) |
| `regenerateSession()` | Regenerate token (use after password change) |

### Type-Safe Templating (html / xml)

Lambder ships zero-dependency tagged template literals instead of a template engine. Interpolated values are HTML-escaped automatically, and everything is plain TypeScript, so templates are fully type-checked and refactorable.

```typescript
import { html, xml, raw } from "lambder";

// Values are escaped by default (XSS-safe):
const page = html`<h1>Hello ${user.name}</h1>`;

// Arrays flatten; nested fragments are not double-escaped:
const list = html`<ul>${items.map((item) => html`<li>${item.label}</li>`)}</ul>`;

// Conditionals: null/undefined/false render as empty string:
const nav = html`${isLoggedIn && html`<a href="/logout">Log out</a>`}`;

// raw() inserts trusted markup verbatim (never pass user input):
const head = html`${raw('<meta charset="utf-8">')}`;

// Works for XML too (xml is an alias of html):
return res.xml(xml`<?xml version="1.0" encoding="UTF-8"?>
<urlset>${urls.map((loc) => xml`<url><loc>${loc}</loc></url>`)}</urlset>`);
```

### Templating with LambderTemplatingEngine

`LambderTemplatingEngine` is a standalone, comment-only HTML template engine. Every construct is an HTML comment, so templates survive HTML build pipelines (e.g. Vite) untouched, and during frontend development the browser simply renders the default content because the markers are invisible. It can template anything: SPA shells, emails, error pages.

**Syntax** (everything is an HTML comment):

```html
<title><!--slot:title-->Default Title<!--/slot:title--></title>   <!-- replaceable region -->
<!--slot:head/-->                                                  <!-- insert-only point -->
<!--if:isRtl--><body dir="rtl"><!--else--><body><!--/if:isRtl-->   <!-- conditional -->
<!--if:!minimal--><nav>...</nav><!--/if:!minimal-->                <!-- negated conditional -->
```

**Usage** (standalone, importable directly from `lambder`):

```typescript
import { LambderTemplatingEngine, html, jsonScript } from "lambder";

// Compile once (throws early on unclosed/mismatched blocks) ...
const template = await LambderTemplatingEngine.fromFile("./templates/page.html");
// ... render many times, per request:
const output = template.render({
    title: userInput,                                         // plain values are escaped (XSS-safe)
    head: html`<link rel="canonical" href="${canonicalUrl}" />
        ${jsonScript("app-data", preloadedState)}`,           // html`...`/raw()/jsonScript() inserted verbatim
    isRtl: lang === "ar",                                     // condition names use truthiness
});

// Runtime introspection (dynamically typed by design):
template.slotNames;       // e.g. ["title", "head"]
template.conditionNames;  // e.g. ["isRtl", "minimal"]
template.has("title");    // true
```

Rules:
- Slot values: strings/numbers escaped; `html`/`raw()`/`jsonScript()` verbatim; arrays flattened; `null`/`undefined`/`false` keep the slot's default content
- Unknown data keys are ignored, so one data object can serve several templates with different slots
- Blocks nest freely; there are intentionally no loops or inline expressions: build dynamic lists server-side with `html` and pass them into a slot
- Attribute-position values (e.g. `<html lang="...">`) are handled with if/else around whole-tag variants

### Hosting a frontend build (servePublicFiles + templateFile)

Lambder has no SPA-specific machinery; hosting a frontend build is a recipe built from three generic primitives:

1. **`servePublicFiles(options?)`**: a terminal slot that serves real files under `publicPath`. It runs only when no route or API matched, so unlike a `"/(.*)"` catch-all route it can never shadow routes registered after it. Traversal-safe, mime-typed, memory-cached for warm invocations, immutable Cache-Control for content-hashed assets (`app-4f8a1b2c.js`), automatic ETag/gzip. When the file does not exist, the request **falls through**.
2. **`serveIndexHtml(handler?, options?)`**: the next slot in the fallback chain, gated by a built-in filter: only `GET`/`HEAD` (option `methods`) and, by default, only paths that do not look like files (`skipFilePaths: true`, so a missing `/logo.png` is a 404, not a soft-404 HTML shell). Optional `redirectTrailingSlash` (default false) 301s `/about/` to `/about`. Gated-out requests fall through to `setRouteFallbackHandler`. Without a handler it serves `publicPath/index.html` (option `indexFile`) via `res.templateFile` with `no-cache`, so plain hosting is zero-config and templating is opt-in.
3. **`res.templateFile(path, data?, options?)`**: render any HTML file under `publicPath` through `LambderTemplatingEngine` (compiled once, cached across warm invocations) and return it as an HTML response.

```html
<!-- frontend index.html (markers survive the Vite build; defaults show in vite dev) -->
<title><!--slot:title-->My App<!--/slot:title--></title>
<!--slot:head/-->
```

```typescript
lambder
    // Multi-tenant roots are just app logic in the path mapper:
    .servePublicFiles({ path: (ctx) => `${getBrandFromHost(ctx.host)}${ctx.path}` })
    // Only GET/HEAD page requests reach this handler:
    .serveIndexHtml(async (ctx, res) => {
        return res.templateFile(`${getBrandFromHost(ctx.host)}/index.html`, {
            title: pageTitle(ctx),                        // escaped automatically
            head: html`<link rel="canonical" href="${canonicalUrl(ctx)}" />
                ${jsonScript("app-data", preloadedState(ctx))}`,
            isRtl: activeLang(ctx) === "ar",
        }, { cacheControl: "no-cache" });
    });

// Or, zero-config for a single-tenant app without templating:
lambder.servePublicFiles().serveIndexHtml();
```

Files without template markers can opt into virtual slots (`title` = the `<title>` element, `head` = before `</head>`) with `res.templateFile(path, data, { htmlVirtualSlots: true })`. File cache policies (`cacheControl`, `immutablePattern`, `memoryCache`) are configurable via `LambderPublicFilesOptions`, and both slots take an explicit compression policy: `servePublicFiles({ compress: (ctx) => /\.(css|js|svg)$/.test(ctx.path) })` and `serveIndexHtml(handler, { compress: true })` (default "auto").

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

## Frontend Usage with LambderCaller

LambderCaller is a frontend companion library for Lambder (only 2kb compressed) designed to simplify making type-safe API requests to your Lambder backend.

### Basic Setup with Type Safety

```typescript
import { LambderCaller } from "lambder";
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
import { LambderMSW } from 'lambder';
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
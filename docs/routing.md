# Routing and actions

Routes answer HTTP requests that are not API calls. Actions answer the
non-HTTP invocations the same Lambda function receives, and can intercept HTTP
requests too. Both are registered on the created instance and dispatched by
`getHandler()`.

## Adding routes

```typescript
lambder
    // A simple path
    .addRoute("/hello-world", (ctx, res) => {
        return res.html("Hello World");
    })
    // Path parameters, typed from the pattern
    .addRoute("/user/:userId", async (ctx, res) => {
        const user = await getUser(ctx.pathParams.userId);
        if (!user) return res.status404("Not found");
        // html`` (from "lambder") escapes what it interpolates; a plain template string would not.
        return res.html(html`Hello ${user.name}`);
    })
    // A regular expression
    .addRoute(/\/hello-regex/, (ctx, res) => {
        return res.html("Hello Regex");
    })
    // A predicate, which can route on any context value
    .addRoute((ctx) => ctx.path === "/hello-fn-route", (ctx, res) => {
        return res.html("Hello from a function route");
    })
    // A structured matcher: path, host, method and an extra condition
    .addRoute({ path: "/stripe-webhook", method: "POST" }, (ctx, res) => {
        return res.json({ received: true });
    });
```

Routes are matched in registration order, first match wins.

### Matcher forms

| Form | Example | Notes |
| --- | --- | --- |
| Path string | `"/user/:userId"` | `path-to-regexp` syntax, matched case-sensitively as API Gateway routes and CloudFront behaviors are (`/User/7` does not reach it); params land on `ctx.pathParams`, typed from the literal |
| RegExp | `/\/reports\/\d+/` | Matched against `ctx.path`, its `%2F` and `%25` included; captures land on `ctx.pathParams` with those turned back |
| Predicate | `(ctx) => boolean` | Any context value: host, header, cookie, method |
| Matcher object | `{ path, host, method, condition }` | All present fields must match |

The matcher object's fields:

| Field | Type | Notes |
| --- | --- | --- |
| `path` | string or RegExp | Same as the standalone forms |
| `host` | string or RegExp | Matched against `ctx.host` |
| `method` | string or string[] | HEAD requests also match GET routes |
| `condition` | `(ctx) => boolean` | An extra predicate, ANDed with the rest |

### Session-protected routes

`addSessionRoute` takes the same matchers and fetches the session first;
`ctx.session` is typed from the instance's session data type. When no valid
session exists, the request short-circuits: API calls get the protocol's
`{ sessionExpired: true }` envelope, routes get
`setSessionExpiredRouteHandler`'s response, and without one, a plain 401.

```typescript
lambder
    .addSessionRoute("/account", (ctx, res) => res.html(renderAccount(ctx.session.data)))
    .setSessionExpiredRouteHandler((ctx, res) => res.redirect("/login"));
```

The same answer goes to a route or a hook that meets
`LambderSessionNotFoundError`: the session controller throws it when the
session was ended while the request held it (a logout or a password change
in another tab), and `fetchSession()` throws it when there is none, or its
subclass `LambderSessionAmbiguousError` when the cookies name more than one
live session (the answer then also carries the cookies that clear them). An
API call gets the `sessionExpired` envelope for it, as it does from an API
handler, and anything else the session-expired route answer. It is a missing
session, not a crash, so it never reaches the global error handler or the
crash reporter.

## The fallback chain

After every route and API has been tried, the request walks a fixed chain.
Each slot is optional, and each one falls through when it does not answer:

1. **`servePublicFiles()`** serves a real file from the `files` source. This is
   a terminal slot rather than a catch-all route, so it can never shadow
   routes registered after it. It falls through when the source has no such
   file.
2. **`serveIndexHtml()`** serves the app shell for GET/HEAD page requests.
3. **`setRouteFallbackHandler()`** decides whatever is left.

Both file slots are covered in [Frontend hosting](./frontend-hosting.md).

```typescript
lambder
    .servePublicFiles()
    .serveIndexHtml()
    .setRouteFallbackHandler((ctx, res) => res.status404("Not Found"));
```

## Fallback and error handlers

```typescript
lambder
    // Unmatched API names
    .setApiFallbackHandler((ctx, res) => {
        return res.api(null, { errorMessage: "API not found" });
    })
    // A Zod input rejection, from an API's own schema or from a guard or
    // rate-limit key slice. One failure, one shape, whichever schema rejected it.
    .setApiInputValidationErrorHandler((ctx, res, zodError) => {
        // Never echo the issues wholesale: a public API validates before any
        // guard runs, and one strictObject issue carries every key the
        // client posted, so the answer would be larger than the request.
        const where = zodError.issues[0]?.path.join(".") || "the payload";
        return res.api(null, { errorMessage: { type: "warning", content: `Invalid input at ${where}.` } });
    })
    // Anything that throws and is not a response or a LambderApiRefusal
    .setGlobalErrorHandler((err, ctx, res) => {
        return res.raw({ statusCode: 500, body: "Internal Server Error" });
    });
```

When an API call crashes with no `setGlobalErrorHandler` (or the handler itself
fails), the last-resort 500 is the API envelope,
`{ apiVersion, payload: null, errorMessage: { type: "error", content: "Internal server error." } }`,
with `crash` and `logList` beside it only for a caller `crashes.reveal` trusts
(see [Crashes](#crashes)); routes get a plain-text 500.

The `logList` the request had accumulated is on `ctx.logList` (`ctx` is null
when the context itself could not be built), and `describeCrash(err, ctx)`
packs the error itself (name, message, stack, cause chain, request id) into the
envelope's `crash` field for a caller entitled to see it. Browsers should not
be; another lambda invoking this one is the case it exists for. See
[Calling a Lambder app from another lambda](./invoke.md#errors-and-logs).

### Crashes

The global error handler decides what a crash is answered with. Reporting a
crash is a separate job with its own place, because a crash can happen where
no answer is written at all: an `addAction` handling a schedule or an SQS
batch, a `created` hook, the error handler itself.

```typescript
initLambder<SessionData>().create({
    apiPath: "/api",
    crashes: {
        // Told every crash, wherever it happened; awaited before the answer goes out.
        report: async (error, site) => {
            await saveCrash(error, site.kind, site.kind === "api" ? site.ctx.apiName : null);
        },
        // How long the answer waits for report, in milliseconds. Default: 3000.
        reportTimeoutMs: 3000,
        // Who may read a crash in the framework's 500: a developer's own browser, say.
        reveal: (ctx) => isDeveloper(ctx),
    },
});
```

`report(error, site)` receives every crash on every path, with where it
happened in `site.kind`:

| `kind` | What crashed | What `site` carries |
| --- | --- | --- |
| `"api"` | An API call's hooks, guards or handler | `ctx`, `lambdaContext` |
| `"route"` | Any other HTTP request: a route, a served file or page, a fallback | `ctx` (null when the request could not be read), `lambdaContext` |
| `"event"` | A non-HTTP invocation whose action threw, or that no action matched | `event`, `lambdaContext` |
| `"startup"` | A `created` hook, before the invocation could start | `lambdaContext` |

It is awaited before the answer goes out, because a Lambda can be frozen the
moment it answers and a report left running might never land. The wait lasts
up to `reportTimeoutMs` (default 3000): a reporter still running then is
logged with `console.error`, beside the crash, as unfinished, and the request
is answered, so a stalled error tracker cannot turn every crash into a
function timeout. The report itself is not cancelled; only the wait ends.

`site.ctx` is the request's context, secrets included: the Cookie header
carries the session token, `ctx.cookie` the session and CSRF cookies,
`rawBody` and `post` a login's password, and `ctx.session` the session record.
When a `beforeRender` hook handed back a context of its own, `site.ctx` is
that one, as the handler's was, and so is the context `reveal(ctx)` and the
global error handler receive.
Forward the fields a crash needs (`apiName`, `path`, `method`, a user id)
rather than the whole context, so an error tracker never stores what would
let its readers act as your users.

A refusal is an answer, not a crash, and never reaches the reporter. A global
error handler that throws while answering a crash is reported too, as a second
crash whose `cause` is what it threw. A reporter that throws is logged and
swallowed: the request is answered either way. An event's error is rethrown to
Lambda after the report, so retries and dead-letter queues see it as before.

With no reporter, a crash nothing else answered is logged by the framework's
own 500 with `console.error`, so it is never silent: that invocation succeeds
(it answered), and Lambda's own error metric does not count it.

`reveal(ctx)` decides whether the framework's 500 carries the crash:
`describeCrash` on an API call's `crash` field beside the call's `logList`,
the stack as text on a route. It governs the framework's answer only; a global
error handler writes its own answer and calls `describeCrash` itself if it
wants to. A reveal that throws counts as no. By default nobody is shown
anything.

## Hooks

Hooks run at fixed points in the request lifecycle. Each takes an optional
priority (lower runs first, default 0).

| Event | Signature | Purpose |
| --- | --- | --- |
| `created` | `(lambder) => void` | Runs once, lazily, before the first request or event is handled (and again on the next one if it failed). One-time setup that needs the instance |
| `beforeRender` | `(ctx, res) => ctx \| response \| Error` | Inspect or modify the context; return a response to short-circuit, or throw |
| `afterRender` | `(ctx, res, response) => response` | Inspect or modify the finished response |
| `fallback` | `(ctx, res) => void` | Runs when nothing matched, after `beforeRender`. Logging and cleanup; it cannot answer |

`beforeRender` runs on every request, not only on the ones a route or an API
matched: a `servePublicFiles` asset and a `serveIndexHtml` shell go through it
too, before the fallback chain is walked, so a hook that writes a security
header, blocks an address or turns on maintenance mode covers the frontend as
well as the APIs. For a matched route, `ctx.pathParams` is already populated
when the hook runs. The CORS preflight is the one request that skips it: it is
answered by the CORS layer before anything else sees it.

A `beforeRender` hook that returns a new object (`{ ...ctx, tenant }`)
replaces the context for the rest of the request: the handler, the later
hooks, the `afterRender` hooks, the global error handler and `crashes` all
receive the replacement, and the session a session route or API reads lands
on it. The context's tools (`ctx.sessionController`, `ctx.rateLimit`) are
bound onto it again.

A header a `beforeRender` hook writes with `res.setHeader` belongs to the
call, so it rides on every answer the call ends in, a crash answer and a
refusal included. `afterRender` does not run for a crash, so security headers
(`Strict-Transport-Security`, `X-Content-Type-Options`) written there are
missing from exactly the 500s; write them in `beforeRender`.

```typescript
lambder
    .addHook("beforeRender", async (ctx, res) => {
        console.log("Request received:", ctx.path);
        return ctx;   // the (modified) ctx continues; a response short-circuits
    })
    .addHook("afterRender", async (ctx, res, response) => {
        console.log("Response status:", response.statusCode);
        return response;
    })
    .addHook("fallback", async (ctx, res) => {
        console.log("No handler matched for:", ctx.path);
    });
```

## Actions (non-HTTP invocations)

The same Lambda often also receives non-HTTP invocations: EventBridge and
CloudWatch schedules, custom events, SQS batches. `addAction(filter, action)`
registers a handler whose filter sees the **raw Lambda event** (always) and the
**HTTP context** (`ctx`, or `null` for non-HTTP invocations). `getHandler()`
dispatches everything.

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

- The handler's second argument is `{ ctx, res, lambdaContext }`, discriminated
  on `ctx`: both `ctx` and `res` are non-null for HTTP invocations and `null`
  otherwise, so `if (tools.ctx)` narrows both.
- **HTTP invocations**: actions join the same first-match chain as routes and
  APIs (registration order) and must return a response built with `tools.res`.
- **Non-HTTP invocations**: actions are the only handlers; return values pass
  through to Lambda untouched (`{ batchItemFailures }` for SQS, say) and errors
  **rethrow**, never routed to `setGlobalErrorHandler`, preserving
  Lambda-native retry and DLQ semantics.
- A trailing `.addAction(() => true, handler)` acts as the fallback for
  unmatched non-HTTP events; with no match at all, a descriptive error is
  thrown.

## Modular routes

Route and API modules are plain functions over the instance, applied with
`use()`; inferred types are preserved through the chain. See
[APIs](./apis.md#modular-apis-with-use).

## Event formats

API Gateway REST APIs (payload v1), HTTP APIs (payload v2) and Lambda Function
URLs are all supported, and the payload format is detected per event, so one
function can sit behind more than one of them. `ctx.event` carries the raw
event when a handler needs something the context does not surface.

The context evens out what the gateways disagree on:

- **The path.** A REST API and a Function URL deliver it percent-encoded, an
  HTTP API decoded in either payload format (a Function URL is told apart by
  its own `*.lambda-url.<region>.on.aws` domain, which its events always
  carry, and an HTTP API sending payload format 1.0 from a REST API by the
  `version: "1.0"` its events carry; like 2.0, it keeps a named stage at the
  front of the path, which the context drops). The 2.0 events Lambder
  synthesizes itself (`LambderInvokeCaller`, `lambder/testing`, the handler
  transport) carry the path decoded and say so by their own
  `requestContext.apiId`, so a caller naming a lambda-url host gets no second
  decode.
  `ctx.path` is the path decoded exactly once whichever sent it, so
  `addRoute("/hakkımızda")` and a file named `team photo.jpg` are found on
  all three, and an escape inside the path stays text: `/%2561dmin` is never
  `/admin`. Two escapes stay in `ctx.path` so it reads back unambiguously: a
  slash inside a segment is `%2F`, so it is never a separator, and a percent
  sign is `%25`. A path param and a RegExp route's captures get both turned
  back. `servePublicFiles` looks up the file the path names, its `%25` read
  as `%` (the path its mapper receives), and a path with an encoded slash
  names no file. On an HTTP API an encoded slash has already become a
  separator before the function sees it. `ctx.rawPath` is the path as it
  arrived.
- **Binary bodies on a REST API.** A REST API decodes a base64 body only for
  the API's `binaryMediaTypes`. Lambder sends text as text, so pages, JSON
  and served text files need nothing; serving binary files (images, fonts)
  or turning compression on needs `binaryMediaTypes: ["*/*"]` on the API.
  Compression is therefore off on a REST API unless `compression` is named at
  creation (see [Responses](./responses.md#compression)).

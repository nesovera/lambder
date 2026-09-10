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
        return res.html(`Hello ${user.name}`);
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
| Path string | `"/user/:userId"` | `path-to-regexp` syntax; params land on `ctx.pathParams`, typed from the literal |
| RegExp | `/\/reports\/\d+/` | Matched against `ctx.path` |
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
        return res.api(null, { errorMessage: zodError.issues });
    })
    // Anything that throws and is not a response or a LambderApiError
    .setGlobalErrorHandler((err, ctx, res) => {
        console.error("Error:", err);
        return res.raw({ statusCode: 500, body: "Internal Server Error" });
    });
```

When an API call crashes with no `setGlobalErrorHandler` (or the handler itself
fails), the last-resort 500 is a JSON envelope
(`{ payload: null, errorMessage: "Internal server error." }`); routes get a
plain-text 500.

## Hooks

Hooks run at fixed points in the request lifecycle. Each takes an optional
priority (lower runs first, default 0).

| Event | Signature | Purpose |
| --- | --- | --- |
| `created` | `(lambder) => void` | Runs once, lazily, at the first render. One-time setup that needs the instance |
| `beforeRender` | `(ctx, res) => ctx \| response \| Error` | Inspect or modify the context; return a response to short-circuit, or throw |
| `afterRender` | `(ctx, res, response) => response` | Inspect or modify the finished response |
| `fallback` | `(ctx, res) => void` | Runs when nothing matched. Logging and cleanup; it cannot answer |

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

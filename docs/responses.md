# Responses

A route, a hook or a fallback handler receives the request context (`ctx`)
and a resolver (`res`), and returns a response built by the resolver. An API
handler receives the context alone and returns its output, which the framework
wraps in the API envelope (see [APIs](./apis.md#defining-apis)). Either way,
headers, cookies and debugging entries are written through the context.
Responses are finalized once at the end of the request: compression, ETag and
the size guard are applied there, not per call site.

## Render context (ctx)

| Property | Description | Example |
| --- | --- | --- |
| `host` | Request host: the Host the gateway received, or a header listed in [`trustedHostHeaders`](./configuration.md#trustedhostheaders) (never read on a Lambda invoke) | `"www.example.com"` |
| `path` | Request path, decoded exactly once whatever gateway sent it, with two escapes kept: a slash inside a segment stays `%2F`, so it is never a separator, and a percent sign stays `%25`. What routes match and files are looked up by (see [Routing](./routing.md)) | `"/hakkımızda"` |
| `rawPath` | The path as the gateway delivered it (stage stripped): percent-encoded from a REST API or a Function URL, decoded from an HTTP API | `"/hakk%C4%B1m%C4%B1zda"` |
| `pathParams` | Path parameters (routes) | `{ userId: "123" }` |
| `method` | HTTP method | `"GET"`, `"POST"` |
| `get` | Query parameters | `{ page: "1" }` |
| `post` | POST body as fields: a JSON object, or urlencoded fields when the body is not JSON. Always an object; a JSON body that is not an object (an array, a number) leaves it empty and is read from `rawBody` | `{ name: "John" }` |
| `rawBody` | Decoded request body as received (webhook signatures) | `'{"a":1}'` |
| `ip` | The address the gateway observed, or the leftmost entry of a header listed in [`trustedClientIpHeaders`](./configuration.md#trustedclientipheaders); no header is trusted by default, and none on a Lambda invoke | `"1.2.3.4"` |
| `header(name)` | Case-insensitive request header lookup | `ctx.header("accept-language")` |
| `headers` | Request headers. With [`originProof`](./configuration.md#originproof) the proof header is never here, and on a request without a valid proof neither are the trusted headers and `proxyHeaders` | `{ "Content-Type": "..." }` |
| `arrivedVia` | How the request reached the function: `"proxy"` (over HTTP with a valid [`originProof`](./configuration.md#originproof)), `"direct"` (over HTTP without one, sent to the gateway's own address), `"invoke"` (a [Lambda invoke](./invoke.md), told by the event's `requestContext.apiId`, which no HTTP client can set), or `"unverified"` (over HTTP with no `originProof` configured, where nothing tells the two apart). Read-only | `"proxy"` |
| `cookie` | Cookies (the first value when a name arrived more than once) | `{ rememberMe: "true" }` |
| `cookieList` | Every value per cookie name, in header order (a name held at several scopes arrives several times) | `{ rememberMe: ["true"] }` |
| `event` | Raw Lambda event (`APIGatewayProxyEvent` or `APIGatewayProxyEventV2`), as it arrived: with an origin proof configured, its headers still hold what a request without the proof wrote under the proxy's headers, which `headers` and `header()` drop | |
| `lambdaContext` | AWS Lambda Context | |
| `apiName` | The endpoint called, `group.action`, read off the call's path (API calls) | `"users.get"` |
| `apiPayload` | Validated input (API calls) | `{ userId: "123" }` |
| `guardData` | Values returned by the API's guards, keyed by guard name | `{ staffPermission: { storeId } }` |
| `session` | The session record, or `null` where none was read or created. Non-null on a session endpoint (one whose guards need a session) and on `addSessionRoute` | |
| `api` | The parsed API request on an API call, `null` on a route | |
| `eventFormat` | Which payload format the event arrived in | `"v1"`, `"v2"` |
| `responseHeaders` | Headers written during the call (the response tools below, session cookies), applied onto the response at the end | |
| `logList` | Entries for the envelope's `logList` channel, for debugging: push what the caller's log should show | `ctx.logList.push({ step: "priced", total })` |
| `setResponseHeader`, `addResponseHeader`, `setCookie`, `clearCookie` | The response tools: write a header or a cookie onto whatever answer the request ends with (see [Headers and cookies](#headers-and-cookies)) | `ctx.setCookie("theme", "dark")` |
| `sessionController` | The request's session controller: create, rotate, refresh and end sessions (see [Sessions](./sessions.md)) | `ctx.sessionController.createSession(userId, data)` |
| `rateLimit(policy, key?)`, `isRateLimited(policy, key?)` | Charge a named rate-limit policy from code: refuse with a 429 when it is over, or answer the verdict (see [API policies](./api-policies.md#charging-a-policy-from-code)) | `await ctx.rateLimit("invitesPerRecipient", email)` |

### Typing a helper's context

A handler's `ctx` is typed where the handler is registered: an API handler's
with its payload, guard data and refusal codes, a route's on a path string
with its path parameters, both with the instance's session data and its
rate-limit policy names. A route matched by a RegExp, a predicate or a
matcher object, a hook and a guard see the policy names as any string. A
helper in another file names the instance's context from the instance's own
type rather than writing out `LambderRenderContext`'s parameters:

```typescript
// app.ts
export const lambderApp = initLambder<SessionData>().create({ /* ... */ });
export type AppContext = LambderRenderContextOf<typeof lambderApp>;
export type AppSessionContext = LambderSessionRenderContextOf<typeof lambderApp>;

// store/coupons.ts
export const redeemCoupon = async (ctx: AppContext, coupon: string) => {
    await ctx.rateLimit("couponsPerCode", coupon);   // one of the instance's policies
    return ctx.session?.data.userId ?? null;           // the instance's session data
};
```

`LambderRenderContextOf` takes any payload, path parameters and guard data, so
an API handler's, a route's, a hook's and a guard's context can each be handed
to it. `LambderSessionRenderContextOf` has the session present: the context of
a session route, of an endpoint whose guards need a session, or of a guard
with `session: true`. A guard is part of the instance's type, so the data a
guard returns cannot come from a helper typed this way (TypeScript reports the
instance as referencing itself); calling one for what it does is fine.

## Response methods

The resolver (`res`) builds responses and writes nothing onto the call. Routes,
hooks, fallback handlers, the input validation handler and actions receive
one; the global error handler receives its base, a `LambderResponseBuilder`,
with the same build methods. All accept an options object:
`{ statusCode?, headers?, cacheControl?, compress?, etag? }`.

| Method | Description |
| --- | --- |
| `res.raw(init)` | Custom HTTP response |
| `res.json(data, options?)` | JSON response |
| `res.text(data, options?)` | Plain text response; with `{ statusCode }`, a message under any status |
| `res.xml(data, options?)` | XML response; takes safe markup only (below) |
| `res.html(data, options?)` | HTML response; takes safe HTML only (below) |
| `res.status(code, body?, options?)` | HTML response with any status code; `body` is safe HTML, none sends an empty body |
| `res.redirect(url, statusCode?, options?)` | Redirect, default 302. A path stays on this origin: a leading run of slashes and backslashes collapses to one slash (`//evil.example` is another host), so a Location built from the decoded `ctx.path` cannot leave the site; another host is named with its scheme. What a URL may not carry as it is (control characters, a space, a backslash, anything outside ASCII) is percent-encoded, so it cannot end the header either; `%` is left alone |
| `res.status404(data, options?)` | HTML 404 Not Found; `data` is safe HTML |
| `res.versionExpired(options?)` | The stale-client refusal envelope, the one the signature gate answers: `res.apiRefusal({ versionExpired: true })` |
| `res.fileBase64(base64, mimeType, options?)` | File from base64 content |
| `await res.file(path, options?)` | Serve a file from the `files` source (a plain-text 404 when missing) |
| `await res.templateFile(path, data?, options?)` | Render an HTML file via `LambderTemplatingEngine` (cached; throws when missing, and for a data key the file has no slot or condition for). `res.templateFile<"title" \| "head">(...)` types the data to the file's names. See [Templating](./templating.md#rendering-a-template-as-a-response) |
| `res.apiRefusal(config, options?)` | An API call answered from outside its handler, always as a refusal; see below |

### HTML bodies

`res.html`, `res.status`, `res.status404` and `res.xml` send a body the
browser renders as markup, so they take safe markup only: a `LambderSafeHtml`,
which is what the `html` and `xml` tagged templates, `raw()` and
`jsonScript()` produce (see [Templating](./templating.md)). A plain string is
a type error, and throws when it gets there anyway, naming the tag, `raw()`
and `res.text`. Nothing can tell markup an author wrote from text a request
supplied, and `res.html("No match at " + ctx.path)` would run whatever
script the path carried; the tag escapes what it interpolates:

```typescript
import { html, raw } from "lambder";

lambder
    .addRoute("/search", (ctx, res) => res.html(html`<p>No match for ${ctx.get.q}</p>`))   // escaped
    .addRoute("/legal", (ctx, res) => res.html(raw(LEGAL_PAGE_MARKUP)))                       // trusted markup, as it is
    .addRoute("/healthz", (ctx, res) => res.text("ok"))                                        // text is text
    .setRouteFallbackHandler((ctx, res) => res.text("Not found", { statusCode: 404 }));
```

`raw()` is the one place markup passes unescaped, and it is meant to be seen:
never hand it something a request supplied. A message that is not markup goes
out with `res.text`, under any status with `{ statusCode }`, as the
framework's own 401, 404 and 500 do.

### API answers outside a handler

`res.apiRefusal` writes the answers an API handler does not give: what a
hook, the API fallback, the input validation handler or the global error
handler answers an API call with. It is always a refusal, never a success:
its config carries a `refusal` or one of the `versionExpired`,
`sessionExpired` and `notAuthorized` flags (a compile error and a thrown
error otherwise), and the envelope's payload is null. That is what lets a
caller trust a success: only a handler's own output, parsed through its
schema, ever reads as one. An API handler never holds a resolver: it returns
its output or refuses.

```typescript
lambder.setGlobalErrorHandler((err, ctx, res) => {
    // An API call is answered in its envelope, which a caller reads as a failure of the server.
    if (ctx?.api) return res.apiRefusal({ refusal: "Something went wrong. Please try again." }, { statusCode: 500 });
    return res.text("Internal Server Error", { statusCode: 500 });
});
```

**The config** (the first argument):
`{ refusal, notAuthorized, versionExpired, sessionExpired, logList, crash }`.
`logList` defaults to what the request accumulated on `ctx.logList`. Its
`refusal` carries a framework code or none, and never data: it answers
outside any one endpoint's declared refusals, which are what a caller's types
allow (see [Declared refusals](./apis.md#declared-refusals)). An app code there
is a thrown error; a hook that means a declared code throws it with
`refuse()`, and it is checked against the endpoint the call names.

`crash` carries a failure described in full (name, message, stack, cause chain,
and the request id it happened under), built with `describeCrash(err, ctx)`.
The framework's own 500 sets it for a caller the app's `crashes.reveal` trusts
(see [Crashes](./routing.md#crashes)); a global error handler that writes its
own answer sets it itself. `LambderCaller` leaves it on the outcome's
`response`, and `LambderInvokeCaller` reads it back as the cause of the error
it throws.

Be deliberate about revealing it: the framework sets `crash` only where
`crashes.reveal` said yes, and never withholds one a handler set. It goes to
whoever the answer that carries it goes to, in the same JSON envelope as everything else, so a browser that asked
receives the stack trace whether or not anything on the page displays it.
`LambderCaller` not surfacing the field is a display choice in one client, not
a gate. No header is a gate either: the `x-lambder-invoke` header an invoke
carries is a marker any HTTP client can write, and authorizes nothing.

Decide by what the caller proved. `ctx.arrivedVia === "invoke"` is read from
the event's `requestContext.apiId`, which a gateway writes itself, so only a
caller IAM lets invoke the function produces it: a handler on a function that
also answers HTTP sets `crash` for that caller and no other. Beyond that, a
function with no HTTP trigger at all has no browser callers to withhold
anything from, and a guard or a signature proves what it checks. See
[Calling a Lambder app from another lambda](./invoke.md#errors-and-logs).

## Headers and cookies

Headers and cookies are written through the context, on every context a
handler receives: an API handler's, a route's, a hook's, a guard's, and a mock
handler's alike, so a server handler and its mock twin read the same. What
they write is collected on `ctx.responseHeaders` and applied to whatever
answer the request ends with, a refusal and a crash answer included:

| Method | Description |
| --- | --- |
| `ctx.addResponseHeader(key, value)` | Add a header value (repeatable for the same key) |
| `ctx.setResponseHeader(key, value)` | Set a header, replacing existing values |
| `ctx.setCookie(name, value, options?)` | Add a Set-Cookie header |
| `ctx.clearCookie(name, options?)` | Add a Set-Cookie header that deletes the cookie |
| `ctx.logList.push(entry)` | Add an entry to the envelope's `logList` (debugging) |

The writers are named for the response because `ctx.header(name)` reads a
request header. A header set this way replaces one the response itself
carries (a `Content-Type`, say), and an added one is appended to it, exactly
as if written on the response directly.

```typescript
export const orderApis = defineApiGroup("orders", {
    export: defineApi({ input, output, guards: "signedIn" }, async (ctx) => {
        const orders = await listOrders(ctx.session.data.storeId);
        ctx.setResponseHeader("Cache-Control", "private, max-age=60");
        ctx.setCookie("lastExport", new Date().toISOString(), { maxAge: 30 * 24 * 3600 });
        ctx.logList.push({ exported: orders.length });
        return { orders };
    }),
});
```

`setCookie` options: `domain` (a string, or a `(hostname) => string | undefined`
function resolved against the request host), `path` (default `/`), `sameSite`
(default `Lax`), `secure` (default true), `httpOnly`, `maxAge` (seconds),
`expires` (Date), `encode` (default `encodeURIComponent`, which `ctx.cookie`
reverses).

A cookie's identity is (name, domain, path), so `clearCookie` must be passed
the `domain` and `path` the cookie was set with. A deletion under another scope
deletes nothing.

Serialization goes through the `cookie` package;
`serializeCookie`, `serializeClearCookie` and `resolveCookieDomain` are
exported for code holding a `LambderResponse` directly.

## Die methods

`res.die.*` builds the response and throws it, immediately halting the request
at any call depth of a route or a hook (the handler, a nested helper function
it calls). Plain `throw res.html(...)` works the same way. An API call says no
with [`refuse()`](./apis.md#refusals) instead, which needs no resolver and
works from any depth of the call.

## The response pipeline

Responses are finalized once at the end of the request:

- **Automatic compression** when the client accepts it, the body is
  compressible and large enough. On a REST API only when `compression` is
  named at creation; see [Event formats](./routing.md#event-formats).
- **Automatic ETag** plus `If-None-Match` 304 handling on GET/HEAD 200
  responses. The tag is taken over the uncompressed body and names the
  encoding (`"<hash>-br"`), so each representation has its own and a
  revalidation that ends in a 304 compresses nothing.
- **Text as text.** A text body (a string, or a text-typed Buffer that is
  valid UTF-8) goes out as text when it is not compressed; only bytes and
  compressed bodies are base64.
- **No shared copy of a cookie.** An answer that carries a Set-Cookie and a
  Cache-Control that is neither `private` nor `no-store` goes out `private`:
  `public`, `s-maxage` and `immutable` are dropped and the rest is kept. A
  shared cache that stores an answer with its Set-Cookie hands that cookie to
  everyone, so a hook that sets a guest cookie on a content-hashed asset
  would otherwise publish one visitor's session for a year. This applies to
  every answer, the 304 and the crash answer included.
- **A clear error** when the body would exceed Lambda's ~6MB cap
  (`maxResponseBytes`, default 5,500,000).

Override per response with `compress: true | false` and `etag: false`. An
API's answers follow the API's declared `compress` option instead (below).

### Compression

The encoding is negotiated against `Accept-Encoding` in the order
`compression.encodings` declares, `["br", "gzip"]` by default. Brotli at
quality 5 (`compression.quality`) runs at roughly gzip's speed while producing
smaller bodies: 15-25% on markup and prose, and substantially more on the
repetitive record lists API responses tend to be. Because the ~6MB cap is
checked on the FINAL body, that is headroom as well as bandwidth.

A client that offers only gzip gets gzip, and
`compression: { encodings: ["gzip"] }` turns Brotli off entirely for a CDN or
client that mishandles it. `Vary: Accept-Encoding` rides every compressible
response, whether or not this particular client accepted an encoding, so shared
caches stay correct.

```typescript
initLambder().create({
    compression: { minBytes: 860, encodings: ["br", "gzip"], quality: 5 },  // the defaults
    // compression: false,  // no automatic compression at all
});
```

On a REST API (payload v1) compression is off unless `compression` is given
at creation, `true` included: API Gateway passes a compressed body on only
for the API's `binaryMediaTypes`, so turn it on together with
`binaryMediaTypes: ["*/*"]`, or leave it to the REST API's own
`minimumCompressionSize`. HTTP APIs and Function URLs pass base64 through
and compress by default.

An API's answers compress by these rules on their own, and an API that needs
otherwise says so where it is declared, with `compress` beside its schemas:

```typescript
export const invoiceApis = defineApiGroup("invoices", {
    download: defineApi({
        input: z.object({ invoiceId: z.uuid() }),
        output: z.object({ fileName: z.string(), pdfBase64: z.string() }),
        // A base64 body gains little from compression: see below.
        compress: false,
    }, async ({ apiPayload }) => await loadInvoicePdf(apiPayload.invoiceId)),
});
```

`"auto"`, the default, is the behavior above. `false` never compresses the
API's answers, and `true` compresses them for every caller that accepts an
encoding, below `minBytes` too and on an instance whose `compression` is off.
That includes a REST API (payload v1), where compression is otherwise off, so
there `true` needs the `binaryMediaTypes: ["*/*"]` the REST API note above
asks for: without it the gateway hands the caller the compressed bytes' base64 text
instead of the body.

A body of base64 bytes (a PDF, an image) is what `false` is for. Compression
takes back the quarter that base64 added, but a compressed body leaves the
function base64-encoded, so the answer is no smaller under the ~6MB cap or to
a caller reaching the function through a Lambda invoke (see
[Calling another lambda](./invoke.md#compression)). Only a browser, behind a
gateway that decodes the body, receives it about a quarter smaller, and pays
for that with compression time on the server and decompression on its side.
The option covers whatever the call is answered with short of a crash, a
refusal and a replayed answer included, and is not part of the API's
contract or its signature.

`compression` is the same option vocabulary the DynamoDB stores, sessions and
the request-payload path use: `true` for that site's defaults, `false` for off,
an object to override, `minBytes` as the threshold, `quality` as the Brotli
quality. Invalid settings (`{ quality: 99 }`, `{ encodings: [] }`) are a
construction error rather than being silently ignored, and a field set to
`undefined` keeps its default.

### Size caps

Lambda's invoke and response payload caps are around 6MB each, and they apply
to what the gateway hands the function and what the function returns.

- Responses are guarded by `maxResponseBytes`, checked on the final
  (compressed) body.
- Request payloads are bounded by `maxRequestPayloadBytes` (default
  20,000,000), which caps what a compressed payload may restore to. See
  [Frontend client](./client.md#compressed-request-payloads).
- Anything larger than that belongs on S3 with a presigned URL, not proxied
  through the function.

## Building a response outside a handler

`lambder.getResponseBuilder(ctx?)` returns a `LambderResponseBuilder` for code
that needs to build a response without being a handler (a hook helper, a
shared error mapper). It has every build method a resolver has and no
`res.die.*`: throwing a response short-circuits the request, and the code
calling this is not inside one. Pass `ctx` so that `res.apiRefusal()` carries the
`logList` the request accumulated; headers and cookies go through the context
itself.

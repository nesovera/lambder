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
| `host` | Request host: the Host the gateway received, or a header listed in [`trustedHostHeaders`](./configuration.md#trustedhostheaders) (never read on a direct invoke) | `"www.example.com"` |
| `path` | Request path, decoded exactly once whatever gateway sent it, with two escapes kept: a slash inside a segment stays `%2F`, so it is never a separator, and a percent sign stays `%25`. What routes match and files are looked up by (see [Routing](./routing.md)) | `"/hakkımızda"` |
| `rawPath` | The path as the gateway delivered it (stage stripped): percent-encoded from a REST API or a Function URL, decoded from an HTTP API | `"/hakk%C4%B1m%C4%B1zda"` |
| `pathParams` | Path parameters (routes) | `{ userId: "123" }` |
| `method` | HTTP method | `"GET"`, `"POST"` |
| `get` | Query parameters | `{ page: "1" }` |
| `post` | POST body, parsed as JSON with a urlencoded fallback (`Record<string, unknown>`) | `{ name: "John" }` |
| `rawBody` | Decoded request body as received (webhook signatures) | `'{"a":1}'` |
| `ip` | The address the gateway observed, or the leftmost entry of a header listed in [`trustedClientIpHeaders`](./configuration.md#trustedclientipheaders); no header is trusted by default, and none on a direct invoke | `"1.2.3.4"` |
| `header(name)` | Case-insensitive request header lookup | `ctx.header("accept-language")` |
| `headers` | Request headers | `{ "Content-Type": "..." }` |
| `cookie` | Cookies (the first value when a name arrived more than once) | `{ rememberMe: "true" }` |
| `cookieList` | Every value per cookie name, in header order (a name held at several scopes arrives several times) | `{ rememberMe: ["true"] }` |
| `event` | Raw Lambda event (`APIGatewayProxyEvent` or `APIGatewayProxyEventV2`) | |
| `lambdaContext` | AWS Lambda Context | |
| `apiName` | API name (API calls) | `"getUser"` |
| `apiPayload` | Validated input (API calls) | `{ userId: "123" }` |
| `guardData` | Values returned by the API's guards, keyed by guard name | `{ orgPermission: { organizationId } }` |
| `session` | The session record, or `null` where none was read or created. Non-null on `addSessionApi` and `addSessionRoute` | |
| `api` | The parsed API request on an API call, `null` on a route | |
| `eventFormat` | Which payload format the event arrived in | `"v1"`, `"v2"` |
| `responseHeaders` | Headers written during the call (the response tools below, session cookies), applied onto the response at the end | |
| `logList` | Entries for the envelope's `logList` channel, for debugging: push what the caller's log should show | `ctx.logList.push({ step: "priced", total })` |
| `setResponseHeader`, `addResponseHeader`, `setCookie`, `clearCookie` | The response tools: write a header or a cookie onto whatever answer the request ends with (see [Headers and cookies](#headers-and-cookies)) | `ctx.setCookie("theme", "dark")` |
| `sessionController` | The request's session controller: create, rotate, refresh and end sessions (see [Sessions](./sessions.md)) | `ctx.sessionController.createSession(userId, data)` |
| `rateLimit(policy, key?)`, `isRateLimited(policy, key?)` | Charge a named rate-limit policy from code: refuse with a 429 when it is over, or answer the verdict (see [API policies](./api-policies.md#charging-a-policy-from-code)) | `await ctx.rateLimit("invitesPerRecipient", email)` |

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
| `res.text(data, options?)` | Plain text response |
| `res.xml(data, options?)` | XML response (accepts `xml` tagged templates) |
| `res.html(data, options?)` | HTML response (accepts `html` tagged templates) |
| `res.status(code, body?, options?)` | Response with any status code |
| `res.redirect(url, statusCode?, options?)` | Redirect, default 302. A path stays on this origin: a leading run of slashes and backslashes collapses to one slash (`//evil.example` is another host), so a Location built from the decoded `ctx.path` cannot leave the site; another host is named with its scheme. What a URL may not carry as it is (control characters, a space, a backslash, anything outside ASCII) is percent-encoded, so it cannot end the header either; `%` is left alone |
| `res.status404(data, options?)` | 404 Not Found |
| `res.versionExpired(options?)` | The stale-client refusal envelope, the one the signature gate answers: `res.api(null, { versionExpired: true })` |
| `res.fileBase64(base64, mimeType, options?)` | File from base64 content |
| `await res.file(path, options?)` | Serve a file from the `files` source (404 when missing) |
| `await res.templateFile(path, data?, options?)` | Render an HTML file via `LambderTemplatingEngine` (cached; throws when missing) |
| `res.api(payload, config?, options?)` | An API envelope written by hand, for code that answers an API call outside its handler; the payload is sent as given |

`res.api` writes the answers an API handler does not give: what a hook, the
API fallback, the input validation handler or the global error handler
answers an API call with, usually `null` beside a refusal flag, an
`errorMessage` or a crash. Nothing parses its payload through an output
schema, so what it is handed is what goes out. An API handler never holds a
resolver: it returns its output, parsed through its schema by the framework,
or throws `refuse()`.

```typescript
lambder.setGlobalErrorHandler((err, ctx, res) => {
    // An API call is answered in its envelope, which a caller reads as a failure of the server.
    if (ctx?.api) return res.api(null, { errorMessage: "Something went wrong. Please try again." }, { statusCode: 500 });
    return res.status(500, "Internal Server Error");
});
```

**API config options** (the second argument of `res.api`):
`{ notAuthorized, errorMessage, versionExpired, sessionExpired, logList, crash }`.
`logList` defaults to what the request accumulated on `ctx.logList`.

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
a gate. There is no trustworthy in-band signal to condition it on either: the
`x-lambder-invoke` header an invoke carries is a hint for guards and hooks and
authorizes nothing, because any client can write it.

The honest gate is deployment: a function with no HTTP trigger, reachable only
through IAM, has no browser callers to withhold anything from, and a handler on
a public function should decide by what the caller proved (a guard, a
signature, an IAM-only path), not by a header. See
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
lambder.addSessionApi("orders.export", { input, output, guards }, async (ctx) => {
    const orders = await listOrders(ctx.session.data.storeId);
    ctx.setResponseHeader("Cache-Control", "private, max-age=60");
    ctx.setCookie("lastExport", new Date().toISOString(), { maxAge: 30 * 24 * 3600 });
    ctx.logList.push({ exported: orders.length });
    return { orders };
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
lambder.addApi("invoices.download", {
    input: z.object({ invoiceId: z.uuid() }),
    output: z.object({ fileName: z.string(), pdfBase64: z.string() }),
    // A base64 body gains little from compression: see below.
    compress: false,
}, async ({ apiPayload }) => await loadInvoicePdf(apiPayload.invoiceId));
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
a caller invoking the function directly (see
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
calling this is not inside one. Pass `ctx` so that `res.api()` carries the
`logList` the request accumulated; headers and cookies go through the context
itself.

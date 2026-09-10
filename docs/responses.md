# Responses

Every handler receives the request context (`ctx`) and a resolver (`res`), and
returns a response built by the resolver. Responses are finalized once at the
end of the request: compression, ETag and the size guard are applied there, not
per call site.

## Render context (ctx)

| Property | Description | Example |
| --- | --- | --- |
| `host` | Request host | `"www.example.com"` |
| `path` | Request path | `"/api"` |
| `pathParams` | Path parameters (routes) | `{ userId: "123" }` |
| `method` | HTTP method | `"GET"`, `"POST"` |
| `get` | Query parameters | `{ page: "1" }` |
| `post` | POST body (parsed) | `{ name: "John" }` |
| `rawBody` | Decoded request body as received (webhook signatures) | `'{"a":1}'` |
| `ip` | Client IP (CF-Connecting-IP / X-Forwarded-For / source IP) | `"1.2.3.4"` |
| `header(name)` | Case-insensitive request header lookup | `ctx.header("accept-language")` |
| `headers` | Request headers | `{ "Content-Type": "..." }` |
| `cookie` | Cookies (the first value when a name arrived more than once) | `{ rememberMe: "true" }` |
| `cookieList` | Every value per cookie name, in header order (a name held at several scopes arrives several times) | `{ rememberMe: ["true"] }` |
| `event` | Raw Lambda event (`APIGatewayProxyEvent` or `APIGatewayProxyEventV2`) | |
| `lambdaContext` | AWS Lambda Context | |
| `apiName` | API name (API calls) | `"getUser"` |
| `apiPayload` | Validated input (API calls) | `{ userId: "123" }` |
| `guardData` | Values returned by the API's guards, keyed by guard name | `{ orgPermission: { organizationId } }` |
| `session` | The session, on `addSessionApi` and `addSessionRoute` | |

## Response methods

All accept an options object: `{ statusCode?, headers?, cacheControl?, compress?, etag? }`.

| Method | Description |
| --- | --- |
| `res.raw(init)` | Custom HTTP response |
| `res.json(data, options?)` | JSON response |
| `res.text(data, options?)` | Plain text response |
| `res.xml(data, options?)` | XML response (accepts `xml` tagged templates) |
| `res.html(data, options?)` | HTML response (accepts `html` tagged templates) |
| `res.status(code, body?, options?)` | Response with any status code |
| `res.redirect(url, statusCode?, options?)` | Redirect, default 302 |
| `res.status404(data, options?)` | 404 Not Found |
| `res.fileBase64(base64, mimeType, options?)` | File from base64 content |
| `await res.file(path, options?)` | Serve a file from the `files` source (404 when missing) |
| `await res.templateFile(path, data?, options?)` | Render an HTML file via `LambderTemplatingEngine` (cached; throws when missing) |
| `res.api(payload, config?, options?)` | Standardized API response |
| `res.apiBinary(payload, config?, options?)` | API response with forced compression |

**API config options** (the second argument of `res.api`):
`{ notAuthorized, message, errorMessage, versionExpired, sessionExpired, logList }`.

## Headers and cookies

Call these before returning the response:

| Method | Description |
| --- | --- |
| `res.addHeader(key, value)` | Add a header value (repeatable for the same key) |
| `res.setHeader(key, value)` | Set a header, replacing existing values |
| `res.setCookie(name, value, options?)` | Add a Set-Cookie header |
| `res.clearCookie(name, options?)` | Add a Set-Cookie header that deletes the cookie |
| `res.logToApiResponse(data)` | Add data to `logList` in API responses (debugging) |

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
at any call depth (handlers, hooks, nested helper functions). Plain
`throw res.html(...)` works the same way. For refusals raised from shared
helpers that do not hold a resolver, use
[`refuse()`](./apis.md#refusals) instead.

## The response pipeline

Responses are finalized once at the end of the request:

- **Automatic compression** when the client accepts it, the body is
  compressible and large enough.
- **Automatic ETag** plus `If-None-Match` 304 handling on GET/HEAD 200
  responses.
- **A clear error** when the body would exceed Lambda's ~6MB cap
  (`maxResponseBytes`, default 5,500,000).

Override per response with `compress: true | false` and `etag: false`.

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

`lambder.getResponseBuilder(ctx?)` returns a resolver for code that needs to
build a response without being a handler (a hook helper, a shared error
mapper).

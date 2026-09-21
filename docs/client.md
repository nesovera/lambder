# Frontend client (LambderCaller)

`LambderCaller` is the frontend companion for a Lambder backend. Import it
from the `lambder/client` entry: everything reachable from there is
browser-safe by construction (no AWS SDK, no Node built-ins, no server
pipeline), so your bundle can never pick up server code.

Its server-side counterpart is
[`LambderInvokeCaller`](./invoke.md), which calls a Lambder app running in
another lambda over the same envelope.

## Setup

```typescript
import { LambderCaller } from "lambder/client";
import type { ApiContractType } from "./backend/handler";   // type-only import

const caller = new LambderCaller<ApiContractType>({
    apiPath: "/api",
    isCorsEnabled: false,
    timeoutMs: 30_000,
    fetchStartedHandler: ({ fetchParams, activeFetchList }) => {
        console.log("API called:", fetchParams.apiName);
    },
    fetchEndedHandler: ({ fetchParams, fetchResult, activeFetchList }) => {
        console.log("Ongoing calls:", activeFetchList.length);
    },
    errorMessageHandler: (message) => showToast(message),
    sessionExpiredHandler: () => redirectToLogin(),
});

// Fully typed: API names autocomplete, the payload and result are inferred.
const user = await caller.api("getCompanyPage", { companyName: "Acme" });
```

## Constructor options

| Option | Default | Description |
| --- | --- | --- |
| `apiPath` | `"/api"` | Must match the server's `apiPath` |
| `apiVersion` | none | Sent with each call as `version`; informational, the server stamps its own on every answer |
| `apiSignatures` | none | The server's generated signature map. Every call carries its endpoint's signature, and a stale one answers `versionExpired`. See [The signature map](#the-signature-map) |
| `isCorsEnabled` | `false` | Send credentialed cross-origin requests |
| `timeoutMs` | none | Default per-request timeout. API Gateway caps around 29s, so ~30000 is sensible. Overridable per call |
| `sessionCookieDomain` | none | Must mirror the server's session cookie `Domain`, otherwise expired cookies cannot be cleared |
| `requestCompression` | `false` | Gzip large payloads. `true` is `{ minBytes: 4096 }` |
| `guardInputsProvider` | none | Supply guardInput-mode guard values for every call from one place |
| `transport` | fetch | How a call reaches the server; see [Transports](#transports) |
| `versionExpiredHandler` | none | The server answered `versionExpired`: this build's signature for the endpoint is not the server's. Usually reloads. Not called again for a repeat, see [The signature map](#the-signature-map) |
| `sessionExpiredHandler` | none | The session is missing or expired |
| `messageHandler` | none | The envelope carried a `message` |
| `errorMessageHandler` | none | The envelope carried an `errorMessage` (a refusal) |
| `notAuthorizedHandler` | none | The envelope carried `notAuthorized` |
| `errorHandler` | none | Network, timeout, server or unknown failure |
| `apiInputValidationErrorHandler` | none | The server rejected the input (422), with the Zod issues |
| `logListHandler` | `console.log` | Receives each answer's `logList`, with the API name; the browser twin of `LambderInvokeCaller`'s `onLogList` |
| `fetchStartedHandler` / `fetchEndedHandler` | none | Call lifecycle, for global loading state |

`setSessionCookieKey(tokenKey, csrfKey)` mirrors non-default server cookie
names. `caller.fetchTrackerList` is the calls currently in flight, in the order
they started, and `caller.isLoading` is derived from it, so neither holds
anything about a call that has already settled.

## The signature map

Pass the map `lambder.apiSignatures()` generated for this build (see
[APIs](./apis.md#signatures-when-a-client-must-update)), the same file the
server is given at `create()`, and every call carries the signature of the
endpoint it names:

```typescript
import { apiSignatures } from "../shared/generated/apiSignatures.generated.js";

const caller = new LambderCaller<ApiContractType>({
    apiPath: "/api",
    isCorsEnabled: false,
    apiSignatures,
    versionExpiredHandler: () => window.location.reload(),
});
```

A server whose shape of the endpoint differs answers `versionExpired`, and
`versionExpiredHandler` runs; a server whose shape is the same runs the call,
whatever else changed since this build. A name the map does not hold fails the
call before anything is sent, as an `unknown` outcome whose error says to
regenerate the map: the file predates the endpoint.

**The reload loop.** A bundle shipped with a stale map (a generator that did
not run, a cached bundle, a server deploy that failed behind a fresh frontend)
would answer `versionExpired`, reload, get the same bundle back, and repeat.
The caller keeps the last `versionExpired` it saw, per tab in `sessionStorage`,
and when the same endpoint fails with the same signature within
`RELOAD_LOOP_WINDOW_MS` (five minutes), it does not call
`versionExpiredHandler` again: a bundle that had actually changed the endpoint
would carry a different signature. The failure is reported through
`errorHandler` instead, and the outcome still says `versionExpired`. Once a
repeat is confirmed, every `versionExpired` within the window from the first
one counts, whichever endpoint it names; after the window a reload is allowed
again, so a stuck client retries a few times an hour and recovers once the
deploy is fixed. Without `sessionStorage` the record is kept in memory for
the page's lifetime.

## Per-call options

Every constructor handler can be overridden in the options of a single
`api`/`apiOutcome` call, alongside these request extras:

| Option | Description |
| --- | --- |
| `headers` | Extra request headers |
| `timeoutMs` | Overrides the constructor default for this call |
| `signal` | External `AbortSignal`, combined with the timeout when both are set |
| `compressRequest` | `false` sends the payload plainly, `true` compresses regardless of the threshold |
| `guardInputs` | Values for the API's guardInput-mode guards, keyed by guard name |
| `idempotencyKey` | Replay-protection key for APIs declared idempotent on the server. The typed contract makes it mandatory for those APIs, as it does `guardInputs` |

## Failure semantics

`api()` collapses every failure to `undefined`, which is indistinguishable
from a legitimately-undefined payload (a structured refusal is the one
exception: it hands back whatever payload the envelope carried, usually
`null`). When the call site needs to know why, use `apiOutcome()`; it never
throws and resolves to a discriminated union:

```typescript
const outcome = await caller.apiOutcome("getCompanyPage", { companyName: "Acme" });
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

| `reason` | Meaning |
| --- | --- |
| `network` | The request never completed |
| `timeout` | `timeoutMs` elapsed and the fetch was aborted |
| `server` | 5xx, a body that is not a Lambder envelope, or a transport failure naming `protocol` |
| `validation` | 422; `zodError` carries the issue detail |
| `versionExpired` | This build's signature for the endpoint is not the server's, its version is below the server's `minApiVersion`, or the app answered `res.versionExpired` |
| `sessionExpired` | No valid session |
| `notAuthorized` | The envelope's `notAuthorized` flag |
| `errorMessage` | A structured refusal; `errorMessage` carries it |
| `unknown` | Anything else |

Failure outcomes also carry `retryAfterSeconds` (from a 429's `Retry-After`),
and the rest by reason, because the failure side is a discriminated union
rather than one arm of optional fields: `network`, `timeout`, `server` and
`unknown` always carry `error`; `validation` always carries `zodError`; and
`versionExpired`, `sessionExpired`, `notAuthorized` and `errorMessage` always
carry `response`, the parsed envelope (a `server` failure carries it too when
the server answered with Lambder's own 500 body, which is how `crash` and
`logList` arrive). So narrowing on `reason` narrows to what that reason
actually has, with no optional reads and no `!`.

Every configured handler still fires on the matching failure, so global UX
(toasts, re-login prompts) lives in the constructor while individual call sites
branch on the outcome. An answer's `logList` reaches `logListHandler` whatever
the outcome, a 5xx and a 422 included, which is where a crashed call's log
trail arrives.

`errorMessage` is `LambderAppRefusalMessage | string`, because
`refuse("Denied.")` and `new LambderApiRefusal("Denied.")` both put the plain
message there, while `refuse("Denied.", { code })` and
`res.api(null, { errorMessage: { type, code, content } })` put the object.
Narrow before reading a refusal's fields:

```typescript
const showRefusal = (message: LambderAppRefusalMessage | string) => {
    if (typeof message === "string") return showToast(message);
    if (message.code === LAMBDER_REFUSAL_CODES.rateLimited) return showRetryLater(message.content);
    showToast(message.content, { type: message.type, title: message.title });
};

const caller = new LambderCaller<ApiContractType>({ ..., errorMessageHandler: showRefusal });
```

A client with its own code vocabulary annotates the object half as
`LambderRefusalMessage<"app/not-verified" | "app/over-quota">` and gets a
`switch (message.code)` the compiler checks, `default: never` included; see
[Responses](./responses.md).

## Guard inputs

For APIs whose guards run in guardInput mode, pass their values per call as
`guardInputs: { <guardName>: value }`. The typed contract makes the options
argument, and the correct value shape, mandatory for those APIs.

A `guardInputsProvider` supplies values for every call from one place, keyed by
guard name, with per-call `guardInputs` merged on top. Name the guards it
covers in the caller's second type parameter:

```typescript
const caller = new LambderCaller<ApiContractType, "orgPermission">({
    apiPath: "/api",
    isCorsEnabled: false,
    guardInputsProvider: () => ({ orgPermission: { orgSlug } }),
});
```

Calls to APIs whose guardInput guards are all covered take an optional options
argument again; uncovered ones (a Turnstile token) still require it. Naming
guards in the type parameter makes the provider itself mandatory.

## Idempotency keys

For APIs declared idempotent on the server (see
[API policies](./api-policies.md#idempotency)), pass `idempotencyKey` per call.
Generate it once per logical operation with
`LambderCaller.createIdempotencyKey()` (safe in insecure contexts where
`crypto.randomUUID` is missing) and send the same key on retries; rotate after
a confirmed success.

`LambderCaller.createIdempotencyKeyScope()` packages that pattern for a
component performing one operation repeatedly:

```typescript
const submitKey = LambderCaller.createIdempotencyKeyScope();

await caller.api("order.create", payload, { idempotencyKey: submitKey.current });
submitKey.rotate();   // after a confirmed success
```

Read `scope.current` on every attempt (first try, retry after a failure,
double-tap) so the server collapses them into one operation. Keys must be
unguessable random and 16-200 characters, because they scope the replay record
for logged-out clients; the server refuses shorter keys with a 400.

## Compressed request payloads

Large payloads run into Lambda's ~6MB invoke payload cap long before the API
Gateway limit, and the cap applies to what the gateway hands the function.
`requestCompression` gzips the payload of any call whose JSON reaches the
threshold, so that budget holds the compressed bytes instead of the raw ones:

```typescript
const caller = new LambderCaller<ApiContractType>({
    apiPath: "/api",
    isCorsEnabled: false,
    requestCompression: true,                    // { minBytes: 4096 }
    // requestCompression: { minBytes: 64_000 }, // only genuinely large calls
});

// Nothing at the call sites changes; this one goes compressed, that one plain.
await caller.api("importStops", { stops: bigArray });
await caller.api("getStop", { id: "42" });

// Per call, either way:
await caller.api("importStops", huge, { compressRequest: false });
```

A compressed call sends `payloadGz` (gzip bytes, base64) beside `payloadBytes`
(the JSON's UTF-8 byte length) in place of `payload`. It is only sent when it
is smaller than the JSON it replaces: a payload that is mostly a base64 image
gzips to nearly its own size, and such a call goes plain rather than slightly
larger. The server also accepts `payloadBr`, the same pair compressed with
Brotli, which is what a Node caller
([`LambderInvokeCaller`](./invoke.md#compression)) sends; nothing changes for
browsers, which keep sending `payloadGz`.

Everything else in the envelope stays plain text, so `apiName` routing, request
logs and MSW mocks are unaffected, and the request stays `application/json`: no
`Content-Encoding` negotiation for a gateway, CDN or proxy to get wrong, and no
new CORS preflight surface. Base64 inside the JSON rather than a binary body is
not a compromise for the size cap, because API Gateway hands a binary request
body to Lambda base64-encoded anyway; base64's 4/3 overhead applies to bytes
that already shrank several times over. Record-shaped JSON typically gzips
5-10x, so a ~5MB budget of compressed payload carries roughly 25-40MB of it.

The option is off by default and safe to turn on or off at any time: the server
understands both shapes regardless, so a deployed client and server never need
to agree. gzip rather than Brotli because the browser's `CompressionStream`
offers gzip and deflate only; responses, compressed by Node, do prefer Brotli.
A runtime without `CompressionStream` sends payloads plainly.

**Server side**: nothing to enable. The payload is restored before rate-limit
key slices, guards and input validation run, so handlers, schemas and policies
see an ordinary payload and need no awareness of the wire format.
`payloadBytes` both bounds the decompression and verifies it (the restored
length must match exactly), so a truncated or hostile body is refused rather
than expanded, and `maxRequestPayloadBytes` at creation (default 20,000,000)
caps what any body may expand to. Size that ceiling to the function's memory:
the restored JSON is parsed in full before any session or policy check, and a
parsed document occupies several times its text size on the heap. Every
malformed case answers a 400 envelope coded
`lambder/invalid-request-payload` instead of a 500.

```typescript
initLambder().create({ apiPath: "/api", maxRequestPayloadBytes: 20_000_000 });
```

Compression moves the ceiling rather than removing it. Past roughly 25-40MB of
JSON the answer is a presigned S3 upload plus a job reference, or chunking, not
a better codec.

## Transports

Every call is one transport call: the envelope in, the answer out in the
accessor form `resolveApiOutcome()` reads. The default is
`lambderFetchTransport`, one POST to `apiPath` over fetch with the CORS
behaviour `isCorsEnabled` selects. Pass `transport` at construction, or
`setTransport()` later, to route calls elsewhere:

| Transport | Use |
| --- | --- |
| `mockApp.transport()` | The [mock runtime](./mock.md), in development and in tests |
| `lambderHandlerTransport(handler)` | A real Lambder handler in this process, for integration tests with no HTTP and no AWS (root entry). Options: `host`, `clientIp`, `context`, `maxResponseBytes`, and `eventFormat` (`"v2"` by default, `"v1"` for a REST API's event). `lambderTestApp` from `lambder/testing` wires it for you, with a cookie jar per visitor; see [Testing](./testing.md) |
| `lambderCookieJarTransport(inner, { jar })` | Any transport carrying a `LambderCookieJar`, so a session survives between calls where there is no browser |

```typescript
const caller = new LambderCaller<ApiContractType>({ apiPath: "/api", isCorsEnabled: false, transport: mockApp.transport() });
```

What a transport owes the caller, whether it ships here or you write one:

- **Any HTTP status is an answer.** A 4xx or 5xx resolves, status and body
  included, because reading what a status means is `resolveApiOutcome()`'s job
  alone. A transport that rejects on a status throws away the envelope a
  refusal, a validation failure or a crash arrived in.
- **A rejection is a transport failure**, reported as `network`. A transport
  that knows better throws a `LambderTransportFailure`: `protocol` says
  something came back and was not an answer, or the callee threw instead of
  answering, which the caller reports as `server` rather than as flaky
  connectivity. Its `cause` is what actually went wrong, and it reaches the
  call site as `outcome.error`.
- **`request.signal` must be honoured**, by rejecting as soon as it aborts. It
  is what makes `timeoutMs` and a per-call `signal` mean anything. The caller
  does not take a late answer on trust either: an answer that arrives after its
  own abort fired is reported as `timeout` (or `network`), never as a success.
- **Timeouts and retries belong to the caller**, so one call is one delivery
  attempt and an idempotency key means what it says.

A jar over `lambderFetchTransport` works outside a browser: the transport
sends the jar's cookies as one `Cookie` header, which undici does send. In a
page it has no effect, because `Cookie` is a forbidden header name there and
the browser attaches its own cookie store instead, which is the right answer.
Per-call `headers` go onto the request first and the two the transport owns
(`Content-Type` and that `Cookie`) after them, so a call adding a header of
its own cannot displace the session the jar just built.

The caller itself runs anywhere `fetch` exists: in a page, a worker, Node or an
edge runtime, since it reads the site host from `globalThis.location` when
there is one and the CSRF cookie through js-cookie where there is a document.
One thing does not travel: a relative `apiPath` is resolved against the page,
and outside a page there is none, so give the caller an absolute `apiPath`
(`https://api.example.com/api`) there. `lambderFetchTransport` says as much
rather than letting it read as a dead network, and `lambderHandlerTransport`
routes an absolute `apiPath` by its path.

A `LambderCookieJar` holds cookies the way a browser does, with the matching
itself delegated to [tough-cookie](https://github.com/salesforce/tough-cookie):
domain and path matching, default-path, Max-Age against Expires, Secure,
HttpOnly, and the `__Host-`/`__Secure-` prefixes, against the public suffix
list. `cookiePairs()` hands them over in RFC 6265 send order, longest `Path`
first and then oldest first, which is the order a server reading the first of
a repeated name actually sees. A target that says it speaks plain http (an
absolute `http://` apiPath) neither accepts a `Secure` cookie nor sends one,
so the jar never holds a session it could not use. That list is what lets it refuse `Domain=co.uk` as well as `Domain=com`;
a rule that only counts labels can catch the second and never the first.

The jar is scoped by the host it is told about, which is how it
declines to send one host's session to another. The decorator learns that host
from an absolute `apiPath` first, then from its own `host` option, then from
the page's host in a browser: an `apiPath` that names its own host is a fact
about where this call goes, so it outranks both, and a cross-origin API's host
outranks the page that happens to be calling it, because the cookies belong to
the API's host. `host` is the fallback for a relative path, which names no
host at all.

```typescript
const jar = new LambderCookieJar();
caller.setTransport(lambderCookieJarTransport(mockApp.transport({ cookies: false }), { jar, host: "app.example.com" }));
```

Given none of the three (an in-process or mock transport posting to a relative
path outside a browser), the jar is a single host's: every cookie it holds
travels on every call it makes, and a `Set-Cookie` carrying a `Domain` is
refused outright, since there is no sending host to check that `Domain`
against and believing it is how a jar hands one host a cookie set for another.
`new LambderCookieJar({ host })` scopes such a jar in one place instead.

## Mocking the contract

`lambder/mock` serves the same contract from typed mock handlers over the
real API pipeline, so frontend development and tests need no backend. See
[The mock runtime](./mock.md).

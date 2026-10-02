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
    timeoutMs: 30_000,
    fetchStartedHandler: ({ fetchParams, activeFetchList }) => {
        console.log("API called:", fetchParams.apiName);
    },
    fetchEndedHandler: ({ fetchParams, fetchResult, activeFetchList }) => {
        console.log("Ongoing calls:", activeFetchList.length);
    },
    refusalHandler: (message) => showToast(message),
    sessionExpiredHandler: () => redirectToLogin(),
    errorHandler: (error, failure) => reportError(error, { reason: failure.reason, status: failure.status }),
});

// Fully typed: groups and endpoints autocomplete, the payload and result are inferred.
const company = await caller.companies.getPage({ companyName: "Acme" });
```

Every group of the contract is a property of the caller, and each of its
endpoints a function: `caller.companies.getPage(input)` calls the endpoint
`companies.getPage`, a POST to `{apiPath}/companies/getPage`, and
`caller.companies.getPage.outcome(input)` resolves to its full outcome (see
[Failure semantics](#failure-semantics)). Code that holds an endpoint's name as
a value calls `caller.api("companies.getPage", input)` and
`caller.apiOutcome("companies.getPage", input)`, the same two calls by name. No
group may take the name of a public member a caller has
(`LAMBDER_RESERVED_GROUP_NAMES`), and a caller keeps its own state in
`#private` fields, which no group name reaches, so the two never collide. The
groups need nothing at runtime: a caller over a type-only contract ships no
endpoint list.

Importing the contract from the server's entry compiles the server's sources
in the frontend's type check. In a large app, import it instead from the file
`writeApiContract` generates, which holds the same type as plain types; see
[the contract as a generated file](./apis.md#the-contract-as-a-generated-file).

## Constructor options

| Option | Default | Description |
| --- | --- | --- |
| `apiPath` | `"/api"`, the server's own default | Must match the server's `apiPath` |
| `apiVersion` | none | Sent with each call as `version`; informational, the server stamps its own on every answer |
| `apiSignatures` | none | The server's generated signature map. Every call carries its endpoint's signature, and a stale one answers `versionExpired`. See [The signature map](#the-signature-map) |
| `isCorsEnabled` | cross-origin `apiPath` | Send credentialed cross-origin requests (fetch's `cors` mode, cookies included). By default on exactly when `apiPath` is an absolute URL on another origin than the page's, which is when a browser needs it; an explicit value wins. Ignored when `transport` is passed |
| `timeoutMs` | none | Default per-request timeout. API Gateway caps around 29s, so ~30000 is sensible. Overridable per call |
| `sessionCookieDomain` | none | Must mirror the server's session cookie `Domain`, otherwise expired cookies cannot be cleared |
| `requestCompression` | `false` | Gzip large payloads. `true` is `{ minBytes: 4096 }` |
| `guardInputsProvider` | none | Supply guardInput-mode guard values for every call from one place |
| `transport` | fetch | How a call reaches the server; see [Transports](#transports) |
| `versionExpiredHandler` | none | The server answered `versionExpired`: this build's signature for the endpoint is not the server's. Usually reloads. Asked one at a time per page, whichever of the page's callers hears it: a refusal heard while it runs calls nothing, and one heard after it returned with the page still here asks again. Not called for a bundle the reload brought back, see [The signature map](#the-signature-map) |
| `sessionExpiredHandler` | none | The session is missing or expired. Called, and the CSRF cookie cleared, only while that cookie is still the one the call sent or is gone: a call sent before a login that answers after it comes back as its `sessionExpired` outcome, with no handler called and nothing touched. Over a cookie jar (the mock's memory mode, `lambder/testing`, `lambderCookieJarTransport`) the jar's CSRF cookie is the one compared, since that session never reaches `document.cookie` |
| `refusalHandler` | none | The envelope carried a `refusal`, handed over as the message object |
| `notAuthorizedHandler` | none | The envelope carried `notAuthorized` |
| `errorHandler` | none | `(error, failure)`: every failure no other handler takes (see [Failure semantics](#failure-semantics)), with the error to report and the failure outcome it came from. Never told of a call its own `signal` aborted |
| `apiInputValidationErrorHandler` | none | The server rejected the input (422), with the Zod issues |
| `logListHandler` | `console.log` | Receives each answer's `logList`, with the API name; the browser twin of `LambderInvokeCaller`'s `onLogList` |
| `fetchStartedHandler` / `fetchEndedHandler` | none | Call lifecycle, for global loading state. `fetchEndedHandler` is told of every call that started, however it ended, with its outcome as `fetchResult` |

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
The caller asks for one reload at a time per page: a `versionExpired` calls
`versionExpiredHandler`, and the rest the page hears while that handler runs
(the other stale endpoints it boots with, another caller's) are only
recorded; every caller a page builds shares the one ask. A handler that
returns without reloading (a per-call handler that does something else, a
reload cancelled at a `beforeunload` prompt) is asked again on the next
refusal. The caller keeps every call refused within `RELOAD_LOOP_WINDOW_MS`
(five minutes), by endpoint, signature and version, with the time it was
refused, in `sessionStorage`, so per tab and per origin. When a call an
earlier load recorded is refused again, the reload brought the same bundle
back (a bundle that had actually changed the endpoint would carry a different
signature, and a rebuilt one a different version), so it does not call
`versionExpiredHandler`: the failure is reported through `errorHandler`
instead, and the outcome still says `versionExpired`. A call refused again by
the page that recorded it is no such evidence, since no reload came between.
Once a repeat is confirmed, every `versionExpired` within the window from the
first one counts, whichever endpoint it names; after the window a reload is
allowed again, so a stuck client retries a few times an hour and recovers
once the deploy is fixed. Without `sessionStorage` (storage blocked, a
runtime with no page) the protection lasts for the page only: nothing
survives a reload, so every load asks. The ask in progress is module state of
`lambder/client`, and a load's time is the document's
(`performance.timeOrigin`), so a test that loads the page more than once
evaluates the client's modules afresh for each load (`vi.resetModules()` and
a dynamic import) and moves `performance.timeOrigin` past what the last load
recorded, as a reload does.

## Per-call options

Every constructor handler can be overridden in the options of a single call
(`caller.orders.place(input, options)`, its `.outcome`, `api` or
`apiOutcome`), alongside these request extras:

| Option | Description |
| --- | --- |
| `headers` | Extra request headers |
| `timeoutMs` | Overrides the constructor default for this call |
| `signal` | External `AbortSignal`, combined with the timeout when both are set. A call it aborts fails as `aborted`, which no handler reports; one it aborts with a `TimeoutError` (`AbortSignal.timeout()`, alone or inside `AbortSignal.any()`) fails as `timeout` |
| `compressRequest` | `false` sends the payload plainly, `true` compresses regardless of the threshold |
| `guardInputs` | Values for the API's guardInput-mode guards, keyed by guard name |
| `idempotencyKey` | Replay-protection key for APIs declared idempotent on the server. The typed contract makes it mandatory for those APIs, as it does `guardInputs` |

## Failure semantics

A call (`caller.companies.getPage(input)`, or `api()` by name) resolves to the
endpoint's output on success and to `undefined` on every failure, refusals
included. An output is always an object or an array
(see [APIs](./apis.md#defining-apis)), so the result is truthy exactly when
the call succeeded, and `if (!result) return` is a complete check once the
constructor's handlers have told the user why. When the call site needs to
know why, use the endpoint's `.outcome()` (or `apiOutcome()` by name); it
never throws and resolves to a discriminated union:

```typescript
const outcome = await caller.companies.getPage.outcome({ companyName: "Acme" });
if (outcome.ok) {
    render(outcome.payload);
} else if (outcome.reason === "aborted") {
    return;   // this page gave the call up itself
} else if (outcome.reason === "network" || outcome.reason === "timeout") {
    showOfflineScreen();
} else if (outcome.reason === "sessionExpired") {
    redirectToLogin();
} else {
    // 'server' (5xx / non-envelope body), 'validation' (422), 'versionExpired',
    // 'notAuthorized', 'refusal' (structured refusal), 'unknown'
    showError(outcome.refusal);
}
```

| `reason` | Meaning | The handler told |
| --- | --- | --- |
| `network` | The request never completed | `errorHandler` |
| `timeout` | `timeoutMs` elapsed and the fetch was aborted, or the call's own `signal` aborted with a `TimeoutError` | `errorHandler` |
| `aborted` | The call's own `signal` aborted it for any other reason, before it was sent or while it was out: the site gave it up | none |
| `server` | 5xx, a body that is not a Lambder envelope (API Gateway's own `{"message": ...}` errors included, on a 5xx too: an object is an envelope only when it carries `apiVersion`), a non-2xx envelope that names no reason, a 2xx envelope that names none but whose payload is not an object or an array (no handler of the API wrote it), or a transport failure naming `protocol` | `errorHandler` |
| `validation` | 422; `zodError` carries the issue detail | `apiInputValidationErrorHandler`, or `errorHandler` without one |
| `versionExpired` | This build's signature for the endpoint is not the server's, its version is below the server's `minApiVersion`, or the app answered `res.versionExpired` | `versionExpiredHandler`, or `errorHandler` without one; `errorHandler` when the reload brought the same bundle back (see [The signature map](#the-signature-map)) |
| `sessionExpired` | No valid session | `sessionExpiredHandler`, or `errorHandler` without one; neither for an answer about an older session than the page holds |
| `notAuthorized` | The envelope's `notAuthorized` flag | `notAuthorizedHandler`, or `errorHandler` without one |
| `refusal` | A structured refusal; `refusal` carries it | `refusalHandler` |
| `unknown` | Anything else | `errorHandler` |

`errorHandler` is called as `errorHandler(error, failure)`: `error` is the
Error to report (the outcome's own, or one that names what happened, such as
`"Not Authorized;"` for a `notAuthorized` with no handler of its own), and
`failure` the failure outcome that led there, with its `reason`, `status`,
`refusal`, `response` and `retryAfterSeconds` where the call has them. A
reporter that files failures by kind reads `failure.reason` rather than the
message, and a handler written as `(error) => ...` keeps working. Its type
is `LambderApiFailure`, typed on the constructor with every refusal code the
contract declares and on a per-call override with the endpoint's own.
`fetchEndedHandler` is handed the same outcome `apiOutcome()` resolves to, as
`fetchResult`, for every call that started.

**Aborting a call.** A call whose own `signal` aborts fails as `aborted` and
tells no handler but `fetchEndedHandler`: a page that gives up a read the
person has moved past (a search superseded by the next keystroke, a view
that closed) aborts it, and nobody sees "could not reach the server" for
it. One controller per read, aborted when the next one starts, is all a
search box needs:

```typescript
let searchController: AbortController | undefined;
const search = async (query: string) => {
    searchController?.abort();
    searchController = new AbortController();
    const outcome = await caller.stores.search.outcome({ query }, { signal: searchController.signal });
    if (outcome.ok) showResults(outcome.payload);
};
```

Only the call's own `signal` reads as `aborted`. Its `timeoutMs` firing is
`timeout`, still a failure that is reported, and whichever of the two aborted
the call first names it. A deadline carried on the signal is a timeout too:
a signal that aborts with a `TimeoutError`, as `AbortSignal.timeout(ms)` does
alone or inside `AbortSignal.any([viewSignal, AbortSignal.timeout(ms)])`,
fails the call as `timeout`, so a call bounded that way is reported when its
deadline passes.

Failure outcomes also carry `retryAfterSeconds` (from the answer's
`Retry-After`: a 429's, or a 503 that says when to come back),
and the rest by reason, because the failure side is a discriminated union
rather than one arm of optional fields: `network`, `timeout`, `aborted`,
`server` and `unknown` always carry `error`; `validation` always carries `zodError`; and
`versionExpired`, `sessionExpired`, `notAuthorized` and `refusal` always
carry `response`, the parsed envelope (a `server` failure carries it too when
the server answered with Lambder's own 500 body, which is how `crash` and
`logList` arrive; a gateway's or a proxy's JSON on a 5xx is not that body, so
none of its fields reach `response`, `refusal` or `logList`). So
narrowing on `reason` narrows to what that reason
actually has, with no optional reads and no `!`.

Every configured handler still fires on the matching failure, as the table
says, so global UX (toasts, re-login prompts) lives in the constructor while
individual call sites branch on the outcome. An answer's `logList` reaches `logListHandler` whatever
the outcome, a 5xx and a 422 included, which is where a crashed call's log
trail arrives.

A success's `payload` is typed as exactly the endpoint's output, with no
`null` or `undefined` beside it: only the handler's own parsed output reads as
a success (see [APIs](./apis.md#defining-apis)).

A refusal's `refusal` always reaches a reader as the message object,
`{ type, code?, title?, content, data? }`, on the outcome and in
`refusalHandler` alike. The server may be handed a plain string
(`new LambderApiRefusal("Denied.")`, or an error handler's
`res.apiRefusal({ refusal: "Denied." })`), and it sends it as
`{ type: "error", content: "Denied." }`. The
caller still reads whatever arrives that way before anything sees it, since a
body no Lambder server wrote (a hand-built mock answer, a proxy) can carry a
string or no message at all, so no reader narrows.
`refusalMessageOf(value)` is that reading, for code that holds a raw envelope
(`outcome.response.refusal` is the wire value, left as it came):

**The message is typed from the contract.** An outcome's `refusal`, on
every failure arm, is one arm per code the endpoint declares (with that
code's `data`) plus one for the framework's codes and the uncoded refusal
(see [Declared refusals](./apis.md#declared-refusals)); a per-call
`refusalHandler` is handed the same type, and the constructor's the
union across every endpoint of the contract:

```typescript
const showRefusal = (message: LambderContractAnyRefusalMessage<ApiContractType>) => {
    switch (message.code) {
        case "wallet-short": return showTopUp(message.data.available);
        case LAMBDER_REFUSAL_CODES.rateLimited: return showRetryLater(message.content);
        default: return showToast(message.content, { type: message.type, title: message.title });
    }
};

const caller = new LambderCaller<ApiContractType>({ ..., refusalHandler: showRefusal });
```

A switch over every declared code and the framework's, ending in
`default: never`, is checked by the compiler, since the server never sends a
code the endpoint does not declare.

## Guard inputs

For APIs whose guards run in guardInput mode, pass their values per call as
`guardInputs: { <guardName>: value }`. The typed contract makes the options
argument, and the correct value shape, mandatory for those APIs.

A `guardInputsProvider` supplies values for every call from one place, keyed by
guard name, with per-call `guardInputs` merged on top. Name the guards it
covers in the caller's second type parameter:

```typescript
const caller = new LambderCaller<ApiContractType, "staffPermission">({
    apiPath: "/api",
    guardInputsProvider: () => ({ staffPermission: { storeSlug } }),
});
```

Calls to APIs whose guardInput guards are all covered take an optional options
argument again; uncovered ones (a Turnstile token) still require it. Naming
guards in the type parameter makes the provider itself mandatory.

## Idempotency keys

For APIs declared idempotent on the server (see
[API policies](./api-policies.md#idempotency)), pass `idempotencyKey` per call.
The easy form is a key scope, one per component that performs the operation:

```typescript
const submitKey = createIdempotencyKeyScope();

await caller.order.create(payload, { idempotencyKey: submitKey });
```

Every attempt of one operation (a retry after a dropped connection, a
double-tap) sends the scope's current key, so the server collapses them, and
the caller moves the scope to a new key once an answer settles the
operation:

- A success settles it, and so does `lambder/idempotency-key-reused`: the
  server refuses a key reused for a different request, which is a different
  payload or a different value for one of the API's `guardInput` guards (one
  declaring `singleUseInput: true`, a captcha token or a refreshed short-lived
  token, is not counted; see
  [Guard inputs and idempotency](./api-policies.md#guard-inputs-and-idempotency)),
  so that key can never carry the person's new request.
- A refusal of this request (a `refusal`, a rejected input, not
  authorized) settles it too, so the person's next attempt, a corrected form
  included, is a new operation. The exception is a key an earlier attempt
  may have used: after a timeout, a network failure, a call aborted after it
  was sent, a 5xx or a duplicate of an original still in flight, the
  operation may have run under that key,
  and guards, validation and rate limits refuse before the replay record is
  claimed. The key is kept, so the next attempt replays the original's
  answer rather than running it again. A double-tap is the one duplicate the
  scope can see the original of: while the first tap still waits for its
  answer, the second tap's duplicate refusal leaves the key to that answer,
  so a first tap refused ("only 5 in stock") still moves the scope on and the
  corrected order goes under a new key.
- A rate limit (a 429), an expired session, a stale version and a call
  aborted before it was sent keep the key.

An answer that arrives for a key the scope has already moved past changes
nothing, so a slow first attempt cannot rotate away the key a later one is
using.

A plain string works too, for a site that manages keys itself: generate one
per logical operation with `createIdempotencyKey()` (safe in
insecure contexts where `crypto.randomUUID` is missing), send it on every
retry, and replace it after an answer that settles the operation. Keys must be
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
    requestCompression: true,                    // { minBytes: 4096 }
    // requestCompression: { minBytes: 64_000 }, // only genuinely large calls
});

// Nothing at the call sites changes; this one goes compressed, that one plain.
await caller.products.importAll({ products: bigArray });
await caller.products.get({ id: "42" });

// Per call, either way:
await caller.products.importAll(huge, { compressRequest: false });
```

A compressed call sends `payloadGz` (gzip bytes, base64) beside `payloadBytes`
(the JSON's UTF-8 byte length) in place of `payload`. It is only sent when it
is smaller than the JSON it replaces: a payload that is mostly a base64 image
gzips to nearly its own size, and such a call goes plain rather than slightly
larger. The server also accepts `payloadBr`, the same pair compressed with
Brotli, which is what a Node caller
([`LambderInvokeCaller`](./invoke.md#compression)) sends; nothing changes for
browsers, which keep sending `payloadGz`.

The endpoint is the call's path and everything else in the envelope stays
plain text, so routing, request logs and MSW mocks are unaffected, and the
request stays `application/json`: no `Content-Encoding` negotiation for a
gateway, CDN or proxy to get wrong, and no new CORS preflight surface. Base64 inside the JSON rather than a binary body is
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
`lambderFetchTransport`, one POST to `{apiPath}/{group}/{action}` over fetch
with the CORS behaviour `isCorsEnabled` selects (its `cors` option, when built by hand: left
out, credentialed cross-origin mode applies exactly when the call's `apiPath`
is on another origin than the page's). Pass `transport` at construction, or
`setTransport()` later, to route calls elsewhere:

| Transport | Use |
| --- | --- |
| `mockApp.transport()` | The [mock runtime](./mock.md), in development and in tests |
| `lambderHandlerTransport(handler)` | A real Lambder handler in this process, for integration tests with no HTTP and no AWS (root entry). Options: `host`, `clientIp`, `context`, `maxResponseBytes`, and `eventFormat` (`"v2"` by default, `"v1"` for a REST API's event). `lambderTestApp` from `lambder/testing` wires it for you, with a cookie jar per visitor; see [Testing](./testing.md) |
| `lambderCookieJarTransport(inner, { jar })` | Any transport carrying a `LambderCookieJar`, so a session survives between calls where there is no browser |

```typescript
const caller = new LambderCaller<ApiContractType>({ apiPath: "/api", transport: mockApp.transport() });
```

What a transport owes the caller, whether it ships here or you write one:

- **Any HTTP status is an answer.** A 4xx or 5xx resolves, status and body
  included, because reading what a status means is `resolveApiOutcome()`'s job
  alone. A transport that rejects on a status throws away the envelope a
  refusal, a validation failure or a crash arrived in.
- **A rejection is a transport failure**, reported as `network`, unless the
  call's own timeout or signal had aborted it, which the caller alone knows
  and reports as `timeout` or `aborted` whatever the rejection says. A transport
  that knows better throws a `LambderTransportFailure`: `protocol` says
  something came back and was not an answer, or the callee threw instead of
  answering, which the caller reports as `server` rather than as flaky
  connectivity. Its `cause` is what actually went wrong, and it reaches the
  call site as `outcome.error`.
- **`request.signal` must be honoured**, by rejecting as soon as it aborts. It
  is what makes `timeoutMs` and a per-call `signal` mean anything. The caller
  does not take a late answer on trust either: an answer that arrives after its
  own abort fired is reported as `timeout` (or `aborted`), never as a success.
- **Timeouts and retries belong to the caller**, so one call is one delivery
  attempt and an idempotency key means what it says.
- **A transport that keeps the session's cookies itself says which CSRF
  token it posted**, as the answer's `csrfTokens: { posted, held() }`, `held()`
  reading the one it holds now. The caller compares the two to tell a
  `sessionExpired` about an older session (a poll sent before a login) from
  one about the session the page holds; without them it compares
  `document.cookie` before and after the call, which such a transport never
  writes. `lambderCookieJarTransport` reports them for whatever it wraps.

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

## Retrying with a backoff

A client that has to come back by itself (a socket that reconnects, a screen
that recovers after a deploy, a loop that tries storage again) waits longer
after each failure, and most such clients also wait for other reasons (a
refresh cadence, a pause before recreating something) that must never stack
with a retry. `LambderBackoffTimer`, from `lambder/client` (and the root entry),
holds exactly one wait of either kind: `retry` and `wait` climb the ladder,
`after` waits a fixed time without climbing it, and scheduling any of them
replaces whatever was waiting. A caller says what to run and when it worked,
and never keeps a handle and a counter of its own.

```typescript
import { LambderBackoffTimer } from "lambder/client";

const reconnect = new LambderBackoffTimer({ baseMs: 1_000, maxMs: 60_000 });

socket.onclose = () => reconnect.retry(open);      // waits longer after each failure
socket.onopen = () => reconnect.reset();           // the next failure waits the shortest time again
page.onhide = () => reconnect.cancel();            // drops the pending wait, keeps the count
```

The ladder: a retry waits the base plus a share of a ceiling that grows by
`factor` with every retry, the whole never past `maxMs`. With full jitter (the
default) the share is random, so anything many clients fail at together (a
deploy dropping every socket, a power cut bringing every screen in a building
up at once) is retried across the whole window instead of in step, which is
what keeps the herd off the server; even the first wait falls between the
base and twice it. `jitter: "none"` waits the whole ceiling, a predictable
ladder for a caller that is alone: twice the base, then climbing to `maxMs`.

| Option | Default | Description |
| --- | --- | --- |
| `baseMs` | `1000` | The shortest retry wait, above 0; the first after a reset falls between it and twice it |
| `maxMs` | `60000`, or `baseMs` when that is longer | The longest any retry wait is; at least `baseMs`, at most 2147483647 |
| `factor` | `2` | How much the ceiling grows with each retry; at least 1 |
| `jitter` | `"full"` | `"full"`: the base plus a random share of the ceiling. `"none"`: the base plus the whole ceiling |

Options that would make the ladder a retry loop with no pause are refused
where the timer is built: a `baseMs` of 0 (every wait is a multiple of it),
and a `maxMs` past 2147483647 ms, the longest delay `setTimeout` keeps (a
longer one fires at once). So are a `factor` below 1 and a `jitter` other
than the two.

`wait(signal?)` is `retry` for code that awaits rather than calls back: it
resolves after the next rung, rejects at once with the signal's reason when
`signal` aborts, and rejects with an `Error` when `cancel()` or a later wait
drops it before it ran, so an `await` on it always settles. `pending` is true
while a wait of any kind is scheduled and false again by the time it runs, so
what it runs may schedule the next one. `retries` is how many retries `retry`
and `wait` have scheduled since the last `reset()`, a dropped one included, so
a loop that gives up after so many reads the timer:

```typescript
const storageBackoff = new LambderBackoffTimer({ baseMs: 1_000, maxMs: 15_000 });
for(;;){
    if(await tryStorage()) break;
    if(storageBackoff.retries === 3) throw new Error("storage stayed unreachable");   // four tries in all
    await storageBackoff.wait(signal);   // throws the abort reason if the caller gives up meanwhile
}
```

That loop is what [`LambderUploadRunner`](./uploads.md) runs between tries at
storage and at the app's own ticket and confirm calls; its `storageRetry`
option's `baseDelayMs` and `maxDelayMs` are the timer's `baseMs` and `maxMs`,
and its `attempts` the first try plus the retries, which a step that succeeds
gives back with `reset()`.

## Mocking the contract

`lambder/mock` serves the same contract from typed mock handlers over the
real API pipeline, so frontend development and tests need no backend. See
[The mock runtime](./mock.md).

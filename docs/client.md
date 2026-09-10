# Frontend client (LambderCaller)

`LambderCaller` is the frontend companion for a Lambder backend, about 2KB
compressed. Import it from the `lambder/client` entry: everything reachable
from there is browser-safe by construction (no AWS SDK, no Node built-ins, no
server pipeline), so your bundle can never pick up server code.

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
| `apiVersion` | none | Sent with each call; a server mismatch answers `versionExpired` |
| `isCorsEnabled` | `false` | Send credentialed cross-origin requests |
| `timeoutMs` | none | Default per-request timeout. API Gateway caps around 29s, so ~30000 is sensible. Overridable per call |
| `sessionCookieDomain` | none | Must mirror the server's session cookie `Domain`, otherwise expired cookies cannot be cleared |
| `requestCompression` | `false` | Gzip large payloads. `true` is `{ minBytes: 4096 }` |
| `guardInputsProvider` | none | Supply guardInput-mode guard values for every call from one place |
| `versionExpiredHandler` | none | The server rejected `apiVersion` |
| `sessionExpiredHandler` | none | The session is missing or expired |
| `messageHandler` | none | The envelope carried a `message` |
| `errorMessageHandler` | none | The envelope carried an `errorMessage` (a refusal) |
| `notAuthorizedHandler` | none | The envelope carried `notAuthorized` |
| `errorHandler` | none | Network, timeout, server or unknown failure |
| `apiInputValidationErrorHandler` | none | The server rejected the input (422), with the Zod issues |
| `fetchStartedHandler` / `fetchEndedHandler` | none | Call lifecycle, for global loading state |

`setSessionCookieKey(tokenKey, csrfKey)` mirrors non-default server cookie
names. `caller.isLoading` and `caller.fetchTrackerList` expose in-flight state.

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
| `idempotencyKey` | Replay-protection key for APIs declared idempotent on the server |

## Failure semantics

`api()` collapses every failure to `null`, which is indistinguishable from a
legitimately-null payload. When the call site needs to know why, use
`apiOutcome()`; it never throws and resolves to a discriminated union:

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
| `server` | 5xx, or a body that is not a Lambder envelope |
| `validation` | 422; `zodError` carries the issue detail |
| `versionExpired` | The server rejected `apiVersion` |
| `sessionExpired` | No valid session |
| `notAuthorized` | The envelope's `notAuthorized` flag |
| `errorMessage` | A structured refusal; `errorMessage` carries it |
| `unknown` | Anything else |

Failure outcomes also carry `retryAfterSeconds` (from a 429's `Retry-After`),
`error` for network/timeout/server/unknown failures, and `response` with the
parsed envelope when one was received.

Every configured handler still fires on the matching failure, so global UX
(toasts, re-login prompts) lives in the constructor while individual call sites
branch on the outcome.

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
larger.

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

## Testing against the contract

`lambder/testing` ships `LambderMSW`, which serves the same contract from MSW
handlers so frontend tests and local development need no backend. See
[Testing](./testing.md).

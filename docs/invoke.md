# Calling a Lambder app from another lambda (LambderInvokeCaller)

API Gateway delivers an HTTP request to a Lambder app as a JSON event and takes
a JSON response object back. A direct `InvokeCommand` carries JSON in both
directions too, so a caller that builds the event API Gateway would have built,
invokes the function with it, and reads the response object Lambder returns is
talking to an unmodified Lambder app. That is all `LambderInvokeCaller` is.

Use it when one function's work belongs in another function: a lambda inside a
VPC with no egress calling the one that has it, a function whose IAM role a
public web function should not carry, a `tools/` script or a scheduled lambda
reaching into a deployed app. The callee stays an ordinary Lambder app whose
APIs are registered with `addApi`, so everything it offers over HTTP comes
along unchanged: zod validation, the inferred contract, refusals, guards, rate
limits, idempotency, Brotli in both directions, `logList`, and the crash detail
its global error handler chooses to send.

It is server-only (zlib and the Lambda SDK), so it is exported from `lambder`
and never from `lambder/client`. The browser counterpart is
[`LambderCaller`](./client.md); the two speak the same envelope and read it
through the same mapping, so their outcomes agree.

## Setup

### The callee is an ordinary Lambder app

Nothing about it is invoke-specific. What makes a function invoke-only is its
deployment: no HTTP trigger and no Function URL, with `lambda:InvokeFunction`
granted to the one role that may call it. There is no header to check for that,
because a header is something any HTTP client can set. The guard below asserts
how the request arrived, so a misrouted event fails loudly instead of running,
and it is worth writing for that alone:

```typescript
// gateway-lambda/src/index.ts
import { initLambder, lambderGuard, refuse, describeCrash, LAMBDER_INVOKE_HEADER, LAMBDER_INVOKE_PROTOCOL } from "lambder";
import { z } from "zod";

const lambder = initLambder().create({
    apiPath: "/api",
    guards: {
        // NOT an authorization: the marker is an ordinary request header, so
        // on a function that also answers HTTP any client can set it. What
        // authorizes this call is the IAM grant, and what keeps a browser out
        // is that this function has no HTTP trigger at all. This says the
        // expectation out loud, and turns a misrouted event into a refusal
        // rather than a run.
        arrivedByInvoke: lambderGuard({
            handler: async (ctx) => {
                if (ctx.header(LAMBDER_INVOKE_HEADER) !== LAMBDER_INVOKE_PROTOCOL) refuse("This function is reached by invoke only.");
            },
        }),
    },
    requirePublicApiGuards: true,
});

lambder.addApi("sendEmail", {
    input: z.object({ to: z.string(), subject: z.string(), html: z.string() }),
    output: z.object({ messageId: z.string() }),
    guards: "arrivedByInvoke",
}, async (ctx, res) => res.api(await sendThroughSes(ctx.apiPayload)));

// The only caller is our own code, so the crash detail crosses in full.
lambder.setGlobalErrorHandler((err, ctx, res, logList) => res.api(null, {
    errorMessage: "Internal server error.",
    crash: describeCrash(err, ctx),
    logList,
}, { statusCode: 500 }));

export type GatewayApiContract = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

### The caller

```typescript
// web-lambda/src/lib/gatewayCaller.ts
import { LambderInvokeCaller } from "lambder";
import type { GatewayApiContract } from "../../../gateway-lambda/src/index.js";   // type-only import

export const gatewayCaller = new LambderInvokeCaller<GatewayApiContract>({
    functionName: `app-${process.env.STAGE}-gateway`,
    clientConfig: { region: "us-east-1" },
    requestCompression: true,
    onFailure: reportFailure,
});

// Fully typed: API names autocomplete, the payload and the result are inferred.
const sent = await gatewayCaller.api("sendEmail", { to, subject, html });
```

The contract is a type, so the import never reaches a bundle and the two
packages may resolve their own copies of `lambder` and `zod`: contract entries
are structural (`{ input, output, guards? }` of plain inferred types), so
nothing has to be the same instance. A misspelt API name, a missing payload
field, a guard input left out or a field the callee stopped returning is a
compile error on the caller's side, and the callee parses the input against the
same schema at runtime.

### The Lambda SDK

`@aws-sdk/client-lambda` is an optional peer dependency, imported on the first
call the way `LambderS3FileSource` imports the S3 client. The Lambda Node
runtimes (`nodejs20.x` and later) already provide the AWS SDK v3, so a function
deployed there installs nothing new: keep the package a dev dependency and out
of the deployment package. Anywhere else (a container, a long-running server, a
local script) install it alongside `lambder`. Without it the first call fails
with `LambderInvokeCaller requires @aws-sdk/client-lambda`. The `transport`
option replaces the SDK entirely, which is what the in-process transport below
does.

The caller's IAM role needs `lambda:InvokeFunction` on the callee's ARN. That
grant is the authorization for the whole protocol.

## What one call sends, and what the callee sees

The caller synthesizes a payload-format-2.0 event (the HTTP API and Function
URL shape: single-valued headers and a `cookies` array) and `POST`s it to the
callee's `apiPath`, so `createContext` builds an ordinary API context:

| `ctx` field | Value |
| --- | --- |
| `method`, `path` | `POST` and `apiPath`, which is what makes it an API call |
| `apiName`, `apiPayload` | From the body envelope, after a compressed payload is restored |
| `host` | The `host` option, defaulting to the callee's function name, so hooks that branch on host see a stable value |
| `ip` | The per-call `clientIp`, which becomes the event's `requestContext.http.sourceIp`; empty when the call did not supply one. No IP header is trusted, here or on the server |
| `header("x-lambder-invoke")` | `"1"` |
| `header("x-lambder-invoked-by")` | The calling function's name, when the caller runs in Lambda (`AWS_LAMBDA_FUNCTION_NAME`) |
| `cookie` | Empty, unless the call carries a session |
| `headers` | The above plus any per-call `headers` |
| `event`, `lambdaContext` | The synthesized event and the callee's own real context |

The body is the envelope `LambderCaller` sends: `apiName`, `version`, `token`,
`siteHost`, `payload` (or `payloadBr` plus `payloadBytes`), `guardInputs` and
`idempotencyKey`. Nothing in the callee can tell an invoke from a browser
except the marker header, which is the point: every server feature applies
unchanged.

The marker is a marker, never an authorization. On a function that is also
reachable over HTTP it is a header any client can set, so what makes an invoke
API safe is the IAM grant and, for a function with both roles, whatever guard
the API declares. `ctx.ip` is likewise whatever the caller forwarded, so an
IP-keyed rate limit on an invoke API limits per forwarded address, and a guard
that assumes a browser (a cookie, a CSRF token) only applies when the call
carries one. The event is a synthesis, and these two fields are where that
shows.

Per-call `headers` are the caller's own assertion about its own call, not a
channel for someone else's. Forwarding an incoming browser request's headers
into them wholesale, which is an ordinary gateway-lambda reflex, hands the
callee attacker-chosen values for everything it reads out of `ctx.headers`, so
forward the few the callee actually needs and name the end user's address as
`clientIp` instead. Three headers the event owns whatever the caller passes,
and drops from `headers` if they are there: `x-forwarded-for` (the address
travels in `requestContext.http.sourceIp`, which is the only channel the
server trusts without configuration) and the two invoke markers, so a call can
neither invent a forwarded address nor claim to be an invoke it is not.

The constants are exported for guards and hooks that want to read them by name:
`LAMBDER_INVOKE_HEADER`, `LAMBDER_INVOKED_BY_HEADER` and
`LAMBDER_INVOKE_PROTOCOL` (the `"1"`, which a future incompatible event shape
would bump).

## Constructor options

| Option | Default | Description |
| --- | --- | --- |
| `functionName` | required | The callee's function name or ARN |
| `client` | none | A ready `LambdaClient`, e.g. one shared with the rest of the app. It keeps whatever `maxAttempts` it was built with (the SDK's own **3** unless the app said otherwise): `clientConfig` is not consulted for a client this caller did not create. See the note below |
| `clientConfig` | `{ maxAttempts: 1 }` | Otherwise the client is built from this on the first call (region, credentials, `maxAttempts`). See the note below on why retries default to one attempt |
| `apiPath` | `"/api"` | Must match the callee's `apiPath` |
| `apiVersion` | none | Sent as the envelope's `version`; informational, the callee stamps its own on every answer |
| `apiSignatures` | none | The callee's generated signature map (`callee.apiSignatures()`), so each call carries its endpoint's signature and the callee answers `versionExpired` to a stale one. See [APIs](./apis.md#signatures-when-a-client-must-update) |
| `host` | `functionName` | The Host the callee sees as `ctx.host` |
| `requestCompression` | `false` | Brotli the request payload. `true` is `{ minBytes: 4096, quality: 5 }` |
| `maxResponsePayloadBytes` | `20_000_000` | Ceiling on what a compressed answer may restore to, the counterpart of the callee's `maxRequestPayloadBytes` |
| `timeoutMs` | none | Default per-call timeout. The callee keeps running regardless, so its own timeout is the real ceiling |
| `onLogList` | `console.log` | Receives each answer's `logList`, with the API name |
| `onFailure` | none | Awaited for every failed call, before `api()` throws or `apiOutcome()` returns. A throw inside it is logged and ignored: `apiOutcome()` never throws |
| `sessionTokenCookieKey` | `"LMDRSESSIONTKID"` | The session token cookie's name, when a session is carried and the callee uses a non-default `tokenCookieKey`. The CSRF value rides in the envelope's `token` field, which has no name to configure |
| `transport` | the Lambda SDK | Replaces the SDK: `(event, { functionName, eventJson, signal }) => Promise<{ functionError, result }>`. `eventJson` is the event serialized once; the SDK sends those bytes as they are |
| `guardInputsProvider` | none | Supplies guard inputs for every call from one place |

One `LambdaClient` is created per caller instance and reused across calls,
unless `client` supplied one, in which case that client is used exactly as it
was built.

Retries stay with the SDK, and `maxAttempts` defaults to **1** here rather than
to the SDK's own 3. The SDK retries throttles and service errors, which are
answered before the callee runs, and it does not retry a function that returned
an error. What it cannot tell apart is a response that was lost in transit: the
callee has already run, and a retry executes the operation a second time. Since
`LambderApiTransport` states that one call is one delivery attempt, the caller
defaults to holding that. Raise it deliberately when the callee is idempotent:

```typescript
new LambderInvokeCaller({ functionName: "orders", clientConfig: { maxAttempts: 3 } });
```

For an operation that must not run twice, send an `idempotencyKey` and let the
callee settle it, which is the mechanism that actually makes a retry safe
rather than merely rare.

The one-attempt default applies to the client this caller builds. A client
passed as `client` keeps whatever it was built with, which is the SDK's own 3
unless the app said otherwise, and `clientConfig` is not consulted for it: a
shared client is the app's to configure, and quietly rebuilding it here would
change every other caller that holds it. Build a shared client with
`new LambdaClient({ maxAttempts: 1 })` if its invokes should not re-execute.

A caller `timeoutMs` only bounds the wait: a synchronous invoke cannot be
cancelled, so a callee that keeps working after the caller gave up still
finishes its work.

## Per-call options

| Option | Description |
| --- | --- |
| `timeoutMs` | Overrides the constructor default for this call |
| `signal` | External `AbortSignal`, combined with the timeout when both are set |
| `compressRequest` | `false` sends the payload plainly, `true` compresses regardless of the threshold |
| `clientIp` | The address the callee reads as `ctx.ip`: it becomes the synthesized event's `requestContext.http.sourceIp`, the field a gateway fills in, since no IP header is trusted |
| `headers` | Extra request headers the callee sees |
| `guardInputs` | Values for the API's guardInput-mode guards, keyed by guard name |
| `idempotencyKey` | Replay-protection key for APIs declared idempotent on the callee |
| `session` | `{ token, csrf }`, so a session API on the callee runs on a user's behalf |

## `api()` and `apiOutcome()`

`api()` resolves to the typed payload and throws a `LambderInvokeError` on
every failure. That is the opposite of `LambderCaller.api()`, which collapses a
failure to `undefined` so a UI keeps rendering, and the difference is deliberate: a
lambda calling a lambda has a failed dependency, which is a failed request. The
throw carries the whole outcome and reaches the app's own global error handler
with the callee's error chained as its `cause`, which is what a call site
would otherwise have had to write by hand. Its result is the output the
callee declared: `res.api(null)` compiles on the callee only for an output
that allows null or beside a reason (see [Responses](./responses.md)), so a
nullable output is where `null` arrives, and a non-nullable one never needs
a guard.

```typescript
// Throws on any failure; typed as the declared output, here `{ body, contentType } | null`.
const file = await gatewayCaller.api("getFileFromR2", { bucketName, filePath });
```

`apiOutcome()` never throws and resolves to a discriminated union, for sites
that degrade rather than fail:

```typescript
const outcome = await gatewayCaller.apiOutcome("verifyToken", { provider, token });
if (outcome.ok) {
    signIn(outcome.payload);
} else if (outcome.reason === "errorMessage") {
    refuse("Authentication failed. Please try again.");
} else {
    showTemporaryFailure();   // outcome.error is ready to throw or report
}
```

A success outcome carries `payload`, the parsed envelope as `response`,
`logList` and `cookies`. A failure carries `reason`, always an `error` (the
`LambderInvokeError` `api()` would have thrown), `logList` and `cookies`, and
`status`, `errorMessage` and `retryAfterSeconds` whenever the callee answered.

The rest is per reason, because the failure side is a discriminated union
rather than one arm of optional fields: `validation` always carries `zodError`,
`crash` always carries `functionError`, `payloadTooLarge` always carries
`bytes`, and `versionExpired`, `sessionExpired`, `notAuthorized` and
`errorMessage` always carry `response`, the parsed envelope (`network`,
`timeout`, `server`, `protocol` and `unknown` carry it too when the callee
answered with Lambder's own envelope, which is how `crash` and `logList` arrive
with a 5xx). So narrowing on `reason` narrows to what that reason actually has,
with no optional reads and no `!`:

```typescript
if (!outcome.ok && outcome.reason === "validation") {
    reportBadRequest(outcome.zodError.issues);   // no `?.`, no `!`
}
```

The arms are exported as `LambderInvokeValidationFailure`,
`LambderInvokeCrashFailure`, `LambderInvokePayloadTooLargeFailure`,
`LambderInvokeEnvelopeFailure` and `LambderInvokeDeliveryFailure`, for a site
that wants to annotate one.

`cookies` is the answer's `Set-Cookie` values, empty when no answer came back;
see [Carrying a user's session](#carrying-a-users-session) for why they matter.
The envelope's `message` field has no handler here, since there is no UI on
this side: it is on `outcome.response.message` for a caller that wants it. The
browser caller routes it to a `messageHandler` instead.

## Failure reasons

The first nine are the same reasons, in the same order of precedence, that
`LambderCaller` reports for an HTTP call; the last three exist only here.

| `reason` | Meaning |
| --- | --- |
| `network` | Nothing came back: a connectivity failure, or an external signal aborted the call |
| `timeout` | `timeoutMs` elapsed and the invoke was given up on. An answer that arrives after that is reported here too, never as a success |
| `server` | The callee answered 5xx, or with a body that is not a Lambder envelope. `response` carries the envelope when it sent one, which is how `crash` and `logList` arrive |
| `validation` | 422: the callee rejected the input. `zodError` carries the issues |
| `versionExpired` | The callee answered `versionExpired`: this caller's signature for the endpoint is not the callee's |
| `sessionExpired` | The carried session is missing or expired |
| `notAuthorized` | The envelope's `notAuthorized` flag |
| `errorMessage` | A structured refusal (`refuse()`, `LambderApiRefusal`); `errorMessage` carries it |
| `unknown` | Anything else, including a `guardInputsProvider` that threw before the call was sent |
| `crash` | Lambda reported a `FunctionError`: the callee failed outside the framework (an init failure, a timeout, out of memory). `functionError` carries the runtime's `errorType`, `errorMessage` and `trace` |
| `protocol` | The invoke was answered, but not by the callee: the Lambda service refused it (`AccessDeniedException`, `ResourceNotFoundException`, `RequestEntityTooLargeException`, a throttle), the answer is not a Lambda HTTP response object, or its compressed body could not be restored. A permission, wiring or size fault to fix, which is why it is not reported as flaky connectivity |
| `payloadTooLarge` | Refused before sending: the event exceeds the invoke cap. `bytes` is its size |

A 404 with a non-envelope body is reported as a `server` failure whose message
names the likely cause (`no API at /api on <function> (HTTP 404): does apiPath
match the callee's?`), because a caller and a callee configured with different `apiPath`
values is the one misconfiguration every first integration hits.

## Compression

Each side decides for its own direction and both understand either shape, so
there is nothing to negotiate and either end can be switched on a live pair.

**Answers** need no configuration. The caller always sends
`accept-encoding: br, gzip`, and the callee's own `compression` option
(on by default: `{ minBytes: 860, encodings: ["br", "gzip"], quality: 5 }`)
compresses the body as it would for a browser, so answers arrive Brotli and the
caller restores them. A handler whose answer will not shrink, a base64 file
body being the usual case, skips the attempt exactly as an HTTP handler would:

```typescript
// Compressing a multi-megabyte base64 body costs tens of milliseconds and saves nothing.
return res.api(object, {}, { compress: false });
```

The restore is capped by `maxResponsePayloadBytes` (default 20,000,000), so a
highly compressible answer cannot expand without limit; over the ceiling the
call fails as `protocol`. Size it to the caller's memory and to the largest
answer it actually expects, and remember that the callee's own
`maxResponseBytes` guard (default 5,500,000, checked on the final encoded body)
is what bounds the other end. A handler that trips that guard throws, so it
reaches the callee's global error handler and comes back as a `server` failure
with the byte count in the message.

**Requests** are off by default. `requestCompression: true` Brotlis the
payload's JSON whenever it reaches the threshold and sends it as `payloadBr`
beside `payloadBytes` (the JSON's UTF-8 byte length) in place of `payload`:

```typescript
const caller = new LambderInvokeCaller<GatewayApiContract>({
    functionName,
    requestCompression: true,                                  // { minBytes: 4096, quality: 5 }
    // requestCompression: { minBytes: 64_000, quality: 4 },   // only genuinely large calls
});

await caller.api("sendPushBatch", { recipients: bigList });                 // goes compressed
await caller.api("saveFile", { body: base64 }, { compressRequest: false }); // goes plain
```

It is only ever sent compressed when that is actually smaller, so a payload
that is mostly a base64 blob goes plain rather than slightly larger, and
`compressRequest: true` still honours that rule while ignoring the threshold.
Brotli rather than the browser client's gzip because both ends are Node;
`compressPayloadBrotli` is exported for code that wants to build the pair
itself. Nothing is needed on the callee: the server restores `payloadGz` or
`payloadBr` (one of the two, never both) before rate-limit key slices, guards
and validation run, and bounds it by `maxRequestPayloadBytes`.

Before sending, the caller measures the whole event's JSON and refuses at
`LAMBDER_INVOKE_MAX_EVENT_BYTES` (5,500,000, the same guard threshold the
response pipeline applies to an answer) with the `payloadTooLarge` reason,
rather than letting the SDK come back with
`RequestEntityTooLargeException`. Lambda caps a synchronous invoke at roughly
6MB in each direction, and compression moves that ceiling rather than removing
it: past it the answer is S3 with a presigned URL and a job reference, not a
better codec.

## Errors and logs

A callee often cannot write to the caller's error store (another VPC, another
role), so anything worth recording has to travel back with the answer. Four
things carry it: the envelope's `errorMessage` for a refusal, its `crash` for a
failure inside the framework, its `logList` for whatever the handler logged,
and Lambda's own `FunctionError` payload when the callee died outside the
framework entirely.

The callee's global error handler decides what a failed call learns.
`describeCrash(err, ctx)` builds the envelope's `crash` field: the error's
name, message and stack, its `cause` chain a few levels deep, and the request
id and function name from `ctx.lambdaContext`, so a row in the caller's error
table points at the right CloudWatch stream. A callee that only ever answers
trusted callers includes it unconditionally; one that also faces browsers
includes it for whoever it already trusts (a debug-cookie holder) and sends a
generic message to everyone else. `LambderCaller` ignores the field, so it
changes nothing a browser client does with the answer, but note what that does
and does not mean: the field is still on the wire, and a browser receives
whatever the handler put there. Attaching it unconditionally publishes your
stack traces to anyone who opens the network panel.

The caller turns whatever it learned into one `LambderInvokeError`:

- `message` is `<functionName> <apiName> failed (<reason>): <detail>`, where
  the detail is the crash's message, the `FunctionError`, the refusal's
  content, or the status. An error reporter that fingerprints on the message
  therefore groups one broken API into one row rather than one row per call.
- `stack` is the caller's own, naming the call site.
- `cause` is an Error rebuilt from the `crash` detail with its stack and cause
  chain (`errorFromCrashDetail`), or from Lambda's `FunctionError` payload, or
  the SDK's rejection. A reporter that walks causes stores the callee's stack
  without being taught anything about this protocol.
- `reason`, `apiName`, `functionName`, `status`, `errorMessage`, `crash`,
  `functionError`, `logList`, `zodError`, `retryAfterSeconds`, `bytes` and the
  full `outcome` are properties.
- `isLambderInvokeError(err)` detects it through a brand, so it survives two
  copies of the package, the way `isLambderApiRefusal` does.

`onFailure` is awaited for every failed call before `api()` throws or
`apiOutcome()` returns, which makes it the single place a failure is reported
whichever method the call site used, and it runs before the lambda answers, so
the write lands rather than racing a frozen container:

```typescript
const reportFailure: LambderInvokeFailureHandler =
    async (failure, { apiName, functionName }) => {
        // A refusal, a rejected input or a version answer is the callee saying no, not a crash.
        if (failure.reason === "errorMessage") return;
        if (failure.reason === "validation" || failure.reason === "versionExpired") return;
        await reportError(failure.error, {
            apiName: `${functionName}:${apiName}`,
            requestId: failure.crash?.requestId ?? null,
            extra: { reason: failure.reason, logList: failure.logList.slice(-20) },
        });
    };
```

An app that reports failures here should skip a `LambderInvokeError` in its own
global error handler, so a thrown `api()` failure is not recorded twice.

On the success path, anything the callee wrote with `res.logToApiResponse`
arrives as the answer's `logList`. It is on the outcome, and it also goes to
`onLogList`, which defaults to printing each entry with `console.log` so a
callee's logs show up in the caller's stream. A site that forwards them into
its own API response for developers reads `outcome.logList` instead.

## Guards and guard inputs

Guards run on the callee exactly as they do for an HTTP request, and the
contract types the caller the same way. An API whose guards run in guardInput
mode makes the options argument, and the shape of each value, mandatory at the
call site:

```typescript
await caller.api("cacheUrl", { url }, { guardInputs: { deviceAuth: { deviceToken } } });
```

`guardInputsProvider` supplies values for every call from one place, with
per-call `guardInputs` merged on top. Name the guards it covers in the second
type parameter, and calls whose guardInput guards are all covered take an
optional options argument again:

```typescript
const caller = new LambderInvokeCaller<GatewayApiContract, "tenant">({
    functionName,
    guardInputsProvider: () => ({ tenant: { tenantId } }),
});
```

A provider that throws fails the call as `unknown` before anything is sent.
This is the same typing `LambderCaller` uses, from the same shared module, so
the two callers cannot drift on what an API demands.

## Idempotency keys

For APIs declared idempotent on the callee (see
[API policies](./api-policies.md#idempotency)), pass `idempotencyKey` per call
and send the same key on retries; the same rules as the browser client apply
(unguessable, 16 to 200 characters, one per logical operation). The contract
makes it mandatory at the call site for exactly those APIs, the way it does
`guardInputs`, so a declaration that reads as protection cannot quietly provide
none. `LambderCaller.createIdempotencyKey()` generates one and is exported from
the root entry too, so a server-side caller has the same generator without
reaching for a UUID library.

It matters more here than it looks: the SDK's own retries happen before the
callee runs, so they do not double-execute anything, but an application-level
retry after a timeout may well reach a callee that is still working.

## Carrying a user's session

A session API on the callee runs on a user's behalf when the call carries the
two values a browser holds, the session token and the CSRF token:

```typescript
const outcome = await caller.apiOutcome("account.summary", { month }, {
    session: { token: sessionToken, csrf: csrfToken },
});
```

The token rides as the session cookie and the CSRF value as the envelope's
`token` field, so `ctx.session` is populated the way it is for a browser
request. `sessionTokenCookieKey` mirrors a non-default token cookie name on the callee;
only the token name reaches the wire, since the CSRF value travels in the body
rather than as a cookie. Everything else about it, the sliding expiration,
`dataRefresh`, the `sessionExpired` envelope flag, behaves as it does over
HTTP.

A caller carrying a session is the browser for that call, and nothing else is:
there is no cookie store behind it, so a `Set-Cookie` the callee sends reaches
nobody unless the caller reads it. Every outcome carries `cookies`, the
answer's `Set-Cookie` values, for exactly that:

```typescript
const outcome = await caller.apiOutcome("account.summary", { month }, { session });
// The callee rotated or cleared the session: keep the new values, or drop them.
const rotated = outcome.cookies.find((cookie) => cookie.startsWith("LMDRSESSIONTKID="));
```

Failures carry them too, which is the case that matters: the answer that
clears a session is a refusal, and a caller that ignores it keeps sending a
token the callee has dropped. Nothing rebuilds the `LambderInvokeSession` the
call was given: a rotation arrives as the answer's `Set-Cookie` values on
`outcome.cookies`, and the next call carries the new pair only if the caller
read them off and passed them. When the caller would rather be handed the two
values than parse cookie headers, the callee can answer them directly:
`getSessionController(ctx).reissueSession()` hands back the raw tokens for a
client that holds its own CSRF token (see
[Sessions](./sessions.md#session-controller)).

`LambderCookieJar` and `lambderCookieJarTransport` do this for the browser
caller (see [the client docs](./client.md#transports)); they are not wired
into this caller, whose calls are usually one server acting for one user
rather than a long-lived browser.

## Any route, not only APIs

`request()` synthesizes an arbitrary method and path and hands back the decoded
answer, whatever its status, so a script can hit a callee's `addRoute` handlers
or fetch a file it serves:

```typescript
const answer = await caller.request({ method: "GET", path: "/health", query: { deep: "1" } });
if (answer.statusCode === 200) console.log(answer.json());
```

It takes `method` (default `GET`), `path`, `query`, `headers`, `body` (a string
as-is, a `Buffer` base64-encoded as API Gateway would), `cookies`, `clientIp`,
`timeoutMs` and `signal`, and resolves to `{ statusCode, headers, cookies,
body, text(), json() }` with lowercased header names and the body already
decompressed. It is untyped: the contract covers APIs, not routes. It throws a
`LambderInvokeError` only when no HTTP answer came back at all (a rejected
invoke, a `FunctionError`, a non-HTTP answer), and those go through `onFailure`
like an API call's, named `GET /health`. The invoke cap applies here as it does
to an API call: an event over `LAMBDER_INVOKE_MAX_EVENT_BYTES` is refused
before it is sent, as a `payloadTooLarge` failure naming the size.

## Testing and boot checks

This section is about testing a caller of another function. For the app's own
endpoints, routes and sessions, see [Testing](./testing.md).

`LambderInvokeCaller.localTransport(handler)` runs a callee's real handler in
this process the way Lambda would, including turning a thrown error into a
`FunctionError` payload. Tests then exercise the real handlers behind the real
envelope, compression and all, with no SDK and no deployed function:

```typescript
import { LambderInvokeCaller } from "lambder";

const caller = new LambderInvokeCaller<GatewayApiContract>({
    functionName: "gateway-local",
    transport: LambderInvokeCaller.localTransport(lambder.getHandler()),
});

expect(await caller.api("sendEmail", { to, subject, html })).toEqual({ messageId: "..." });
```

A second argument overrides fields of the `Context` the handler receives
(`getRemainingTimeInMillis`, `awsRequestId` and the rest are filled in). It
honours the caller's `timeoutMs` and `signal` by ending the wait: a function
call in this process cannot be cancelled, so the handler runs to completion
regardless and what a timeout buys is the caller's answer, which is reported
as `timeout` rather than as a late success.

The browser caller has the same in-process path: `lambderHandlerTransport(handler)`
calls the handler through a browser-shaped event (no invoke marker) and wraps
in `lambderCookieJarTransport` to hold a session across calls. An absolute
`apiPath` is routed by its path, since a URL as the event's `rawPath` matches
no route, and its host becomes the Host the handler sees unless the `host`
option names one. A handler that throws (a failed import, a dead pool at
construction) answered nothing at all, so the call fails as `server` with the
handler's own error as `outcome.error`'s `cause`, rather than as a synthetic
502 whose message says nothing. A caller `timeoutMs` ends the wait here the
way it does over HTTP, and, as with an invoke, the callee keeps running: a
function call in this process cannot be cancelled. And the
[mock runtime](./mock.md) can stand in for a callee here:
`transport: lambderMockInvokeTransport(mockApp)` answers this caller from the
same registry a browser test uses.

`LambderInvokeCaller.createEvent({ apiPath, apiName, payload })` returns the
event a call would send, with a plain payload, for a boot check that hands a
built deployment package an event file and asserts it answers. Calling an API
name that does not exist is a useful smoke test on its own: unless the callee
registered its own `setApiFallbackHandler`, the answer is a 200 envelope whose
`errorMessage` carries `LAMBDER_REFUSAL_CODES.apiNotFound`, which proves the
whole bundle loaded and the pipeline ran.

```typescript
const event = LambderInvokeCaller.createEvent({ apiPath: "/api", apiName: "boot-check-no-such-api" });
```

It accepts the same fields a call does (`payload`, `host`, `apiVersion`,
`signature`, `guardInputs`, `idempotencyKey`, `clientIp`, `headers`, `session`,
`sessionTokenCookieKey`), defaulting `apiPath` to `"/api"` and `host` to
`"lambder-invoke"`.

## One function, both roles

A function that serves HTTP and is also an invoke target needs nothing: the
same `getHandler()` answers both, the marker header tells them apart, and an
API can be declared for one, the other or both through its guards. Bear in mind
that on such a function the marker is settable by any HTTP client, so an API
meant for invokes only needs a guard that checks something an HTTP client
cannot forge.

## Not supported

- **Asynchronous invocation** (`InvocationType: "Event"`). Fire and forget has
  no answer to map onto an outcome, so it is not what this caller does.
- **Response streaming.** A synchronous invoke returns one JSON document.
  Binary bodies travel base64-encoded inside it, within the same roughly 6MB
  cap as everything else, and `request()` will carry them in both directions.
- **Calling over HTTPS.** The transport here is a Lambda invoke. A caller that
  needs to reach a Lambder app over its URL uses `fetch` with
  [`LambderCaller`](./client.md).

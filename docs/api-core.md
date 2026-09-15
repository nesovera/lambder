# The API core

Every API call, on the Lambda server and in the mock runtime, goes through
one pipeline: `LambderApiPipeline`. The server is an adapter that turns a
Lambda event into a core request and a core answer into a Lambda response;
the mock runtime is an adapter that turns a caller's transport request into a
core request and a core answer into what the caller reads. Everything in
between runs once, in one place, on Node and in the browser.

```
 browser app            node test / server test          another Lambda
 LambderCaller          LambderCaller                    LambderInvokeCaller
      │                      │                                 │
      ▼                      ▼                                 ▼
   fetch transport   │  mock transport  │ handler transport │ invoke transport
      (production)   │   (dev, tests)   │   (in-process)    │  (Lambda SDK)
                     ▼                  ▼                   ▼
                LambderMockApp     Lambder.getHandler()  ──── (the real server)
                (mock adapter)      (server adapter)
                     │                  │
                     ▼                  ▼
            ══════════ LambderApiPipeline (isomorphic core) ══════════
            signature gate → payload restore → ip-keyed rate limits → session
            → replay → the remaining rate limits → guards → input validation
            → exec → answer
```

The core lives in `src/api/` and reaches into `core/` nowhere at all, at
runtime or in the types: the cookie serializer it used to import lives in
`shared/`, and the two builders bound to the server's render contexts
(`lambderGuard`, `lambderRateLimitKey`) live in `core/LambderPolicyBuilders.ts`
and are built from the generic `lambderGuardBuilder` /
`lambderRateLimitKeyBuilder` the core exports. That is what keeps
`lambder/client` and `lambder/mock` free of `aws-lambda` in their type graphs.
It does depend on `session/` at runtime, and that is deliberate: the pipeline
constructs the per-request session controller and hands it to the adapters, and
`session/` is itself isomorphic, so the core stays as portable as it is with it.

Compression arrives through the codec (zlib where it exists,
`DecompressionStream` otherwise) and session cryptography through WebCrypto.
The precise Node-free property is worth stating, because the word "isomorphic"
is usually claimed rather than measured: `shared/` names no Node built-in at
the value level or in the declarations it emits, and the repo's own
`tsconfig.json` supplies `@types/node` globally, which is what lets the
`typeof Buffer !== "undefined"` guards and the lazy `import()` returns in
`shared/util/LambderNodeModules.ts` typecheck here. Compiled with no `@types/node`
at all, the `.d.ts` graphs of `lambder/client` and `lambder/mock` name no Node
global, no `aws-lambda` type and no AWS SDK type. (`shared/contracts/LambderFileSource.ts`
types a file body as `Buffer`; no browser entry reaches it, which is why that
name appears in the root entry's graph and in neither of the other two.)

## Layering

Directories are layers, and imports only ever point down. From the bottom:

1. `shared/`: isomorphic utilities, vocabularies and store interfaces.
   Depends on nothing in `src/` but itself.
2. `stores/`: implementations of the interfaces in `shared/`. Only a
   `LambderDdb*` or `LambderS3*` store may name an AWS SDK, and then lazily.
3. `session/`: the session model and the per-request controller over a
   `LambderSessionStore`.
4. `api/`: this core, over `shared/` and `session/`.
5. `client/`: the browser caller, over `shared/` alone.
6. `core/`, `mock/`, `invoke/`: the three adapters, each over everything
   below it. `core/` and `mock/` never import each other; `invoke/` may name a
   `core/` TYPE (it synthesizes events for a Lambder server and decodes its
   results) and never a `core/` value; `mock/` may import only
   `stores/LambderMemory*`.
7. `index.ts`, `client.ts`, `mock.ts`: the three entries, each reaching only
   the layers its consumers may have.

A type-only import obeys the same rule as a value import. A type edge is still
a dependency: it binds every consumer's typecheck, it is where the next value
edge starts, and it is what makes a module unreadable on its own. Where a lower
layer needs to name something a higher layer declares, the declaration is in
the wrong layer: move it down, or give the lower layer a narrow interface of
its own to depend on. `shared/wire/LambderApiOptionValues.ts` is that move made: the
runtime shapes of the three per-API policy options (`guards`, `rateLimit`,
`idempotency`) sit below both the contract that records them and the engines in
`api/` that enforce them, so neither has to import the other.

## Naming

A module whose whole subject is one exported function takes that function's
name in camelCase (`lambderFetchTransport.ts`, `lambderMockMswHandler.ts`);
every other module is PascalCase (`LambderApiPipeline.ts`,
`LambderSessionStore.ts`). Either way the file is named for its subject rather
than for whichever export happens to be the principal one, so a module that
grows a second export beside the first does not need renaming.

The vocabulary around a request is fixed, and a new name is expected to reuse
it rather than coin a synonym. An **Answer** is this core's
transport-independent output, a **Response** the server's HTTP object, an
**Outcome** what a caller reads, and a **Result** what an internal function
hands back to its own caller. A **Refusal** is a `LambderApiRefusal` thrown to
say no; a **Failure** is a transport or an invoke that could not deliver at
all. A **Store** is a pluggable backing store, a **Manager** the model over a
store, and a **Controller** the per-request API over a manager.

## Request and answer

```typescript
type LambderApiRequest = {
    apiName: string;
    version: string | null;          // the caller's apiVersion, informational
    signature: string | null;        // the caller's signature for the endpoint, for the gate
    token: string;                   // the CSRF token the caller posted
    siteHost: string;
    payload: unknown;                // plain, or restored from its compressed form
    compressedPayload: { gzip, brotli, declaredBytes } | null;
    guardInputs: Record<string, unknown> | undefined;
    idempotencyKey: unknown;        // client data: the engine checks the shape

    headers: Record<string, string>; // lowercased
    cookies: Record<string, string[]>; // every value per name
    ip: string;
    host: string;
    signal?: AbortSignal;
};

type LambderApiAnswer = {
    statusCode: number;
    headers: Record<string, string[]>;
    body: string;
    isBodyBase64?: boolean;          // finalization hints the server keeps; the mock finalizes nothing
    compress?: boolean | "auto";
    etag?: boolean | "auto";
};
```

`readApiEnvelope(post, info)` reads the posted envelope into a request (null
when the body names no API), and `restoreCompressedPayload(request, maxBytes)`
restores a `payloadGz` or `payloadBr` pair under its declared length. The
answer is the shape the idempotency store persists and replays;
`toHttpAnswer(answer)` gives the accessor view `resolveApiOutcome()` reads.

## The envelope, once

`src/api/LambderApiEnvelope.ts` is the one place the wire envelope is written:

| Function | Answers |
| --- | --- |
| `buildApiEnvelope(apiVersion, payload, config)` | The envelope object, flags only when set |
| `envelopeAnswer(envelope, { statusCode?, headers? })` | An envelope as an answer |
| `refusalAnswer(err, apiVersion, logList?)` | A thrown `LambderApiRefusal`: its errorMessage and flags, status, headers |
| `validationAnswer(zodError, logList?)` | The standard 422 body, bounded by bytes |
| `apiNotFoundAnswer(apiVersion, logList?)` | The `lambder/api-not-found` refusal |
| `sessionExpiredAnswer(apiVersion, logList?)`, `versionExpiredAnswer(apiVersion)` | The protocol flags |
| `invalidPayloadAnswer(apiVersion, message)` | A compressed payload that could not be restored (400) |
| `crashAnswer(apiVersion)` | The last-resort 500, still an envelope |

The server's `res.api()` builds through `buildApiEnvelope`, and the mock wraps
a handler's return with it, so the two sides cannot drift on a byte.

## The pipeline

```typescript
const pipeline = new LambderApiPipeline<Ctx, SessionData>({
    apiVersion?: string,                 // stamped on every answer's envelope
    // Enables the signature gate: what signature a request should carry for
    // its endpoint (null for an unknown one). The server's is
    // LambderApiSignatureDigests over its own schemas; the mock's answers from
    // the generated map.
    signatures?: LambderApiSignatureSource,
    maxRequestPayloadBytes?: number,
    // null asks for the standard 422, so "no handler, standard 422" is
    // written once, here, rather than in every adapter.
    onInvalidInput?: (zodError, ctx, request) => LambderApiAnswer | null,
    sessions?: { manager: LambderSessionManager, tokenCookieKey?, csrfCookieKey?, cookieOptions? },
    // The policies are bound to this pipeline's own context, so a custom key
    // handler written for another adapter is a compile error here. A guard is
    // bound on both contexts it may run on: TCtx, and TCtx with the session
    // narrowed to a record, which is what an adapter's session context is.
    rateLimits?: { limiter: LambderRateLimiter, policies, failOpen? },
    guards?: Record<string, LambderApiGuard<any, any, any, Ctx, Ctx & { session: LambderSessionRecord<SessionData> }>>,
    idempotency?: { store: LambderIdempotencyStore, defaultTtlSeconds?, defaultPendingTtlSeconds?, failOpen?, callerIdentity? },
});

const { answer, replayed, guardsRun } = await pipeline.run(request, ctx, definition, exec);

// An adapter that reports what a call did even when it crashed passes its
// own trace: the pipeline writes `guardsRun` and `replayed` into that object,
// so a handler that threw still leaves them behind for the adapter's catch.
const trace = { guardsRun: [], replayed: false };
try { await pipeline.run(request, ctx, definition, exec, trace); }
catch(err){ report(trace.guardsRun); throw err; }
```

`failOpen` (on `rateLimits` and on `idempotency`, default true on both) says
what a broken store means: the request goes through, and the failure is logged
with `console.error` naming the policy or the API. Set it to false where an
unmetered or undeduplicated request is worse than a refused one.

`definition` is a `LambderApiDefinition`: `{ name, mode, guards?, rateLimit?,
idempotency?, input?, output? }`. The schemas are optional because the mock has
none; `output` is read by the signature digest alone.
`exec(ctx)` is the adapter's step: on the server it calls the app handler and
converts its `LambderResponse` to an answer; in the mock it calls the mock
handler and wraps the return in the envelope.

The steps, in the order `run` executes them:

1. **Signature gate**: a request carrying a signature that is not the one
   the `signatures` source expects for its endpoint answers `versionExpired`
   (see [APIs](./apis.md#signatures-when-a-client-must-update)); a request
   carrying none is not gated.
2. **Payload restore**: a compressed payload is restored before anything
   reads it.
3. **Rate limits whose key needs no session** (`per: "ip"`), in declared
   order. They run here because the session read below is one of the things
   they exist to bound: a request carrying a bogus session cookie costs a
   store scan plus a read per candidate, and it used to be answered
   `sessionExpired` without the limiter ever running. A replay costs those
   same reads, so an ip-keyed limit is charged to a replay too.
4. **Session** (session mode): the session controller reads the session the
   request's cookies name, checked against the posted CSRF token; none
   answers `sessionExpired`.
5. **Idempotency replay**: a completed record answers its stored answer
   without burning the remaining rate-limit quota or re-running guards.
6. **The remaining rate limits** (`per: "session"` and custom key handlers,
   which may read `ctx.session`), then **guards**, in declared order; a
   guard's return lands on `ctx.guardData`.
7. **Input validation**, when the definition carries a schema.
8. **exec**, inside the idempotency claim; the headers the handler itself
   wrote are drained onto the answer before the engine decides whether to
   store it. The engine hands the store a copy, so applying the call's own
   headers afterwards cannot reach into a stored record.

A `LambderApiRefusal` thrown by any step, guard or handler is rendered here, in
one place: a `LambderApiValidationRefusal` through `onInvalidInput` (the app's
`setApiInputValidationErrorHandler` on the server, the standard 422 otherwise),
any other refusal as the refusal envelope. Anything else propagates, because
only the adapter knows what a crash means. `run` never sees a name it has no
definition for; `answerUnknownApi(request, ctx?)` is what the adapters answer
with. It carries the call's own headers and holds no signature gate: both
adapters run `prepare(request, definition)` on the way in, with the definition
the name resolved to or null, so a signed stale client has already been
answered by then.

`assertRegistration(definition)` runs the registration-time checks (unknown
policy or guard names, session guards on public endpoints, empty guard and
rateLimit options, and a subsystem an API references that was never
configured) with the same messages on the server and in the mock.

## The call context

The pipeline, the engines and the session controller read and write nothing
on a context beyond `LambderApiCallContext`:

```typescript
type LambderApiCallContext<S> = {
    session: LambderSessionRecord<S> | null;
    guardData: Record<string, unknown>;
    responseHeaders: LambderAnswerHeaders;   // set()/add(), drained onto the answer
    logList: unknown[];                      // the envelope's logList channel
};
```

The server's `LambderRenderContext` extends it (with `ctx.api`, the parsed
request, beside the HTTP fields), and so does the mock's handler context.
`LambderAnswerHeaders` records header operations in call order, so `set`
replaces what the answer itself carries and `add` appends to it, exactly as
the two would if called on the answer directly.

## Stores are interfaces

Each engine takes its store through an interface that names only what the
engine calls, with a DynamoDB implementation and an in-memory one:

| Interface | DynamoDB | Memory |
| --- | --- | --- |
| `LambderRateLimiter` | `LambderDdbRateLimiter` | `LambderMemoryRateLimiter` |
| `LambderIdempotencyStore` | `LambderDdbIdempotencyStore` | `LambderMemoryIdempotencyStore` |
| `LambderSessionStore` | `LambderDdbSessionStore` | `LambderMemorySessionStore` |

The memory stores keep the same semantics (fixed windows and attempt counting,
owner-checked claims and expiry, session records under the two hashes) with a
`Map` in place of the table, and an injectable clock so a test can move time.
A test of a rate limit, a replay or a session therefore runs in microseconds
with no AWS, and an app may bring its own store (Redis, a database) by
implementing the interface.

## Transports

Both callers already funnel their answer through `resolveApiOutcome()`. The
browser caller's `transport` option is the seam in front of it:

```typescript
type LambderApiTransport = (request: LambderApiTransportRequest) => Promise<LambderApiHttpAnswer>;
```

| Transport | Where | What it does |
| --- | --- | --- |
| `lambderFetchTransport({ cors })` | `lambder/client` | The default: one POST to the API path over fetch |
| `mockApp.transport(options)` | `lambder/mock` | The mock runtime, cookies carried by a jar |
| `lambderHandlerTransport(handler, options)` | `lambder` | A real Lambder handler in this process, called through a browser-shaped event; with the memory stores, an integration test of the real app through the typed caller with no HTTP and no AWS |
| `lambderCookieJarTransport(inner, { jar })` | both | Makes any transport carry a `LambderCookieJar` the way a browser carries cookies, so a session survives between calls where there is no browser |

A transport may reject; the caller reports that as `network`, or `timeout`
when its own abort fired, so offline and timeout injection need nothing new
in the caller. `LambderInvokeCaller` keeps its event-shaped transport, since
a Lambda invoke is what it speaks; `lambderMockInvokeTransport(mockApp)` lets
the mock runtime stand in for a callee there.

## The server adapter

`Lambder.ts` keeps routes, actions, hooks, files, index serving, CORS,
templating, finalization and the global error handler. For an API call it
parses the event into `ctx.api`, runs the pipeline with an `exec` that calls
the handler and converts its response (`answerFromResponse`,
`responseFromAnswer`), and hands the answer to hooks, CORS and finalization
as a `LambderResponse`. The signature gate and the payload restore also run
before routing, so hooks see a plain payload and a stale client is answered
before any of them, whether or not the name it asked for exists.

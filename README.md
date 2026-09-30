# Lambder

A highly opinionated serverless web framework for TypeScript on AWS Lambda.
Lambder handles HTTP requests, routes, type-safe APIs, sessions and the
declarative policy layer around them (rate limits, authorization guards,
idempotency), so an application is a set of declarations rather than a pile of
per-handler boilerplate.

```typescript
import { initLambder, LambderLocalFileSource, LambderDdbSessionStore } from "lambder";
import { z } from "zod";

const app = initLambder<SessionData>().create({
    apiPath: "/api",
    files: new LambderLocalFileSource({ root: "./public" }),
    session: { store: new LambderDdbSessionStore({ tableName: "app-session", region: "us-east-1" }), sessionSalt: process.env.SESSION_SALT! },
});

const companyApis = app.defineApiGroup("companies", {
    get: app.defineApi({
        input: z.object({ slug: z.string() }),
        output: z.object({ id: z.string(), name: z.string() }),
    }, async ({ apiPayload }) => await loadCompany(apiPayload.slug)),
});

export const lambder = app.registerApiGroups(companyApis);
export type ApiContractType = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

An endpoint is a value: declared with `defineApi`, gathered into a named
group, registered with its groups in one call, and called at
`/api/companies/get`. A handler returns its output, which is parsed through
the output schema before it is sent, and says no by throwing a refusal:
`ctx.refuse()`, typed to the codes the API declares, or `refuse()` from
anywhere. Its guards say who may call it, and so whether it needs a session.

The frontend imports that contract type and gets autocomplete, typed payloads
and typed results with no hand-written client:

```typescript
import { LambderCaller } from "lambder/client";
import type { ApiContractType } from "./backend/handler";

const caller = new LambderCaller<ApiContractType>({ apiPath: "/api" });
const company = await caller.companies.get({ slug: "acme" });
```

## Features

- **Type-safe APIs with Zod.** Define inputs and outputs with Zod schemas; get
  runtime validation and compile-time inference on both sides of the wire.
- **One inferred contract.** The API contract is derived from the backend code
  and consumed by the frontend as a type-only import.
- **Exact results.** A success is only ever the handler's parsed output, an
  object or an array, so a caller's success is typed as exactly the output and
  is never null or falsy; everything a hook or an error handler answers is a
  refusal.
- **Declared refusals.** An app declares its refusal codes once, each with the
  schema of its data, the status it leaves with and whether it flags
  `notAuthorized`; every API and guard names the codes it may refuse with, and
  a guard's or a handler's `ctx.refuse` is typed to them. The contract carries
  them, a caller narrows `refusal.data` on the code, and a refusal outside its
  declaration is a crash, never an answer.
- **Simple route and API declaration.** Paths, regexes, predicates and
  structured matchers, chained fluently.
- **Sessions.** Over a store of your choosing (DynamoDB, memory, your own),
  with secrets hashed at rest, sliding expiration, session data checked
  against its schema on every read and refreshed from its source, and
  cross-subdomain cookies.
- **One API core, two runtimes.** The request pipeline (envelope, refusals,
  sessions, guards, rate limits, idempotency) is one isomorphic class; the
  Lambda server and the mock runtime are adapters over it, so a mock behaves
  like the server by construction and the whole policy layer is testable
  in-process with no AWS.
- **Declarative policies.** Named rate-limit policies, authorization guards and
  idempotency, referenced by name from an API declaration and checked at
  compile time.
- **A real response pipeline.** Automatic Brotli/gzip, ETag and 304 handling,
  cookies, and a guard against Lambda's response size cap.
- **Hooks and actions.** Lifecycle hooks, plus `addAction()` for the non-HTTP
  invocations (EventBridge, SQS, custom events) the same function receives.
- **A summary line per call.** Every API call is logged once, as JSON, with
  its endpoint, outcome, refusal code, status and timings, and the request
  ids that join it to the calls it made; nothing from its input or its
  caller.
- **Lambda to lambda calls.** `LambderInvokeCaller` invokes a Lambder app in
  another function directly, with no API Gateway in between, typed from the
  callee's own contract and carrying its refusals, crash detail and logs back.
- **Frontend hosting.** Serve a build from a folder, S3, R2 or any HTTP
  origin, with an app shell rendered through a build-pipeline-safe template
  engine.
- **Direct uploads.** Files go from the browser straight to S3, or to R2 on
  presigned PUTs, on tickets that pin their size, type and SHA-256, with a
  browser runner that hashes,
  retries and reports progress, and a memory bucket that holds tests and the
  mock to the same rules.
- **Runs anywhere Lambda does.** API Gateway REST APIs (payload v1), HTTP APIs
  (payload v2) and Lambda Function URLs; the payload format is detected per
  event.

## Installation

```bash
npm install lambder zod
```

`zod` is a required peer dependency: the published declarations name its types,
so npm installs it alongside lambder. The four AWS SDK clients and `msw` are
optional peers, so installing lambder never drags them into your tree. Add
whatever the code you actually import needs:

| What you import | What to install alongside |
| --- | --- |
| `lambder/client` (browser, shared isomorphic code) | `zod`. `LambderCookieJar` pulls in `tough-cookie` and its public suffix list, so a bundle that never imports the jar never carries either |
| `lambder` on AWS Lambda (any current Node.js runtime; the package needs Node 20 or later) | `zod`. The runtime already provides the AWS SDK v3, so mark the SDK packages as dev dependencies and keep them out of the deployment package, as long as the runtime's `@aws-sdk/client-dynamodb` is new enough for `LambderDdbRateLimiter` (3.868.0, see below) |
| `lambder` anywhere else (a long-running server, a container, local tests) | `zod`, plus `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` when sessions or the DynamoDB stores are used; both are loaded on the first table access, so an app that uses neither needs neither |
| `LambderS3FileSource` | `@aws-sdk/client-s3`, loaded on first read |
| `LambderInvokeCaller` | `@aws-sdk/client-lambda`, loaded on the first call |
| `lambder/mock` | nothing; `msw` only for the optional network-panel adapter |

The SDK and its `@smithy` tree are roughly 21MB installed, which is why they are
peers rather than dependencies: a frontend importing only `lambder/client` has
no use for any of it, and a Lambda deployment package should not ship a second
copy of what the runtime already loads. The runtime pins its own SDK version,
so if you need a specific one, install it and bundle it yourself. One version
matters to Lambder: `LambderDdbRateLimiter` needs `@aws-sdk/client-dynamodb`
3.868.0 or later, the first whose throttling errors name their reasons. Under
an older client it never recognizes a key-range throttle, so a flood on one
key goes to `failOpen` instead of being refused. Check the version your
runtime bundles before relying on it, or bundle the client yourself.

## Package entry points

The package ships five entry points; pick by where the code runs:

| Entry | Runs in | Carries |
| --- | --- | --- |
| `lambder` | Server (Lambda) | The full framework: pipeline, sessions, DDB stores, policies, plus the API core's building blocks and everything from `lambder/client` except the two request-compression helpers, `compressPayloadGzip` and `isRequestCompressionAvailable`, which stay on the client entry where a payload is compressed |
| `lambder/client` | Browser and isomorphic shared code | `LambderCaller`, `LambderApiRefusal`/`refuse`, the API contract and envelope types, `LambderUploadRunner`, `LambderBackoffTimer`, `LambderSignedClaims`, `html`/`xml` tagged templates, `createLambderI18n` |
| `lambder/mock` | Browser and Node, in development and tests | `LambderMockApp`, the mock runtime: your typed contract served from mock handlers over the real API pipeline and memory stores |
| `lambder/testing` | Node, in tests | `lambderTestApp`: your real instance under test in this process, memory stores put under it in place, simulated browsers with typed callers in front of it, and the outcome assertions; the store conformance suites, to hold a store you write to the rules Lambder's own meet |
| `lambder/build` | Node, in a build step | `writeApiSignatures`: the signature file both sides ship, written or checked from your instance; `writeApiOptions`: every API's declared options, policies and guard declarations as plain data, for the code that decides with them; `writeApiGuardParams`: one guard's parameters, one export per API and nothing else, so a browser gating on that guard carries only the ones it imports; `writeApiContract`: the contract as plain types a client compiles instead of the server; `generateApiFiles`: every one of them, for every app a script names, in one call |

Frontends and shared isomorphic packages should import from `lambder/client`
only; the entry's module graph contains no AWS SDK, Node built-ins, or server
pipeline, so the browser boundary is structural rather than left to
tree-shaking.

Source layout mirrors this: `src/api/` (the isomorphic API core: request,
answer, envelope, pipeline, and the declarative policies the pipeline runs),
`src/core/` (the Lambda server adapter: routes, files, hooks, finalization),
`src/session/` (the session manager, controller and crypto), `src/secrets/`
(one-shot secrets over their store), `src/stores/`
(every store and file-source implementation, DynamoDB and in-memory alike,
and the helpers the two caches share), `src/client/`,
`src/invoke/` (the lambda-to-lambda caller and the in-process handler
transport), `src/mock/` (the mock runtime), `src/testing/` (the test app and the store conformance suites),
`src/build/` (what a generator script runs at build time), and `src/shared/`
(isomorphic modules every entry re-exports, grouped into `wire/` for the
format both sides speak, `contracts/` for the six store and source
interfaces, `transport/` for the caller-to-server seam, and `util/` for
helpers).
Directories are layers and imports only ever point down;
[docs/api-core.md](./docs/api-core.md#layering) states the order and the test
that enforces it.

## Documentation

Start with [Getting started](./docs/getting-started.md), then reach for the
guide that matches what you are building. The full index lives in
[docs/](./docs/README.md).

| Guide | Covers |
| --- | --- |
| [Getting started](./docs/getting-started.md) | The three-step path from a first API to a typed frontend call |
| [Configuration](./docs/configuration.md) | Every `initLambder().create({...})` option, in one reference |
| [Routing and actions](./docs/routing.md) | Routes, matchers, hooks, fallbacks, crash reporting, and non-HTTP invocations |
| [APIs and refusals](./docs/apis.md) | `defineApi`, groups and lazy groups, the mode the guards decide, the inferred contract, `refuse()` and `LambderApiRefusal`, the signature file |
| [Responses](./docs/responses.md) | The render context and its response tools (headers, cookies, log entries), the response builder routes and hooks use, compression, ETag and the size cap |
| [Sessions](./docs/sessions.md) | Sessions over a store, cookie scope, secrets at rest, `dataRefresh`, the controller API |
| [API policies](./docs/api-policies.md) | Declarative rate limits, guards and idempotency, and mandatory authorization declarations |
| [Calling another lambda](./docs/invoke.md) | `LambderInvokeCaller`: invoking a Lambder app in another function, its contract, failures and compression |
| [Testing](./docs/testing.md) | `lambderTestApp`: the real instance under test with no HTTP and no AWS, visitors, sign-in without a login endpoint, outcome assertions, crashes, time, store conformance suites |
| [The API core](./docs/api-core.md) | `LambderApiPipeline`: the one pipeline the server and the mock runtime run, the store interfaces, the transports |
| [Frontend client](./docs/client.md) | `LambderCaller`: typed calls, failure outcomes, timeouts, guard inputs, request compression, transports |
| [Frontend hosting](./docs/frontend-hosting.md) | File sources, `servePublicFiles`, `serveIndexHtml`, `res.templateFile` |
| [Direct uploads](./docs/uploads.md) | Files the browser sends straight to S3 or R2 with tickets the server signs, verified before they count |
| [Templating](./docs/templating.md) | `html`/`xml` tagged templates and `LambderTemplatingEngine` |
| [Translations](./docs/i18n.md) | `createLambderI18n`: typed keys, extension, detection, on-demand languages, runtime dictionaries |
| [The mock runtime](./docs/mock.md) | `LambderMockApp`: the typed contract served from mock handlers over the real pipeline, in the browser and in tests |
| [DynamoDB tables](./docs/ddb-tables.md) | Table shapes, TTL and IAM for sessions, cache, rate limits and idempotency |
| [Exports reference](./docs/exports.md) | Every name the five entry points export, grouped by purpose |

## Standalone modules

Self-contained tools that ship with the package and work with or without the
framework:

| Module | Guide | Description |
| --- | --- | --- |
| `html` / `xml` tags + `LambderTemplatingEngine` | [Templating](./docs/templating.md) | Type-safe tagged templates and a comment-only HTML template engine (build-pipeline-safe) |
| `createLambderI18n` | [Translations](./docs/i18n.md) | Typed translations with enforced/optional languages, component-level extension, auto language detection and on-demand language loading (isomorphic) |
| `LambderDdbCache` / `LambderMemoryCache` / `LambderStorageBackedCache` | [DynamoDB cache](./docs/ddb-cache.md) | JSON cache behind one `LambderCache` interface: DynamoDB-backed and compressed, with lease-based single-fill and grouped keys (server-only), in memory for tests, or over an app's own storage (a SQL table, Redis) with the same rules |
| `LambderDdbRateLimiter` / `LambderMemoryRateLimiter` | [Rate limiter](./docs/ddb-rate-limiter.md) | Fixed-window rate limiter, atomic per window, in DynamoDB (server-only) or in memory |
| `LambderDdbIdempotencyStore` / `LambderMemoryIdempotencyStore` | [Idempotency store](./docs/ddb-idempotency.md) | Idempotency records with owner-checked claims, in DynamoDB (compressed replays, server-only) or in memory |
| `LambderMockApp` | [The mock runtime](./docs/mock.md) | The typed contract served from mock handlers over the real API pipeline, with failure injection, sessions and a call log (isomorphic) |

## Versioning and changes

Released versions and what each one changed are in
[CHANGELOG.md](./CHANGELOG.md). The current major is v10, which makes both
sides of an answer exact. A success is only ever the handler's parsed output,
and an output is an object or an array, so `caller.api()` is truthy exactly
on success and a success's payload is typed as exactly the output; a hook, a
fallback or an error handler answers an API call with `res.apiRefusal()`,
never with a payload. A refusal names a code the app declared, which the
contract carries and a caller narrows on, with its data typed. Every break
and what to do about it is in the 10.0.1 entry, and the compiler finds most
of them. The ones it cannot are changes of behavior: a refusal whose code its
API does not declare is now a crash rather than an answer, and a success
whose payload is not an object or an array now reads as a server failure. An
app still on v8 goes through the 9.0.1 entry first, and one on an older
major through the entries before it.

## Contributing

Contributions are welcome. Open an issue for a bug or an idea, or send a pull
request. `npm test` typechecks, builds `dist/` and runs the suite, and it must
pass before a change is ready: the type system carries a lot of this
framework's guarantees, so a change that only passes at runtime is not
finished. New behavior belongs in the matching page under
[docs/](./docs/README.md) and in [CHANGELOG.md](./CHANGELOG.md) too.

## License

MIT. See [LICENSE](./LICENSE).

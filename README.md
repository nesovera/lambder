# Lambder

A highly opinionated serverless web framework for TypeScript on AWS Lambda.
Lambder handles HTTP requests, routes, type-safe APIs, sessions and the
declarative policy layer around them (rate limits, authorization guards,
idempotency), so an application is a set of declarations rather than a pile of
per-handler boilerplate.

```typescript
import { initLambder, LambderLocalFileSource, LambderDdbSessionStore } from "lambder";
import { z } from "zod";

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    files: new LambderLocalFileSource({ root: "./public" }),
    session: { store: new LambderDdbSessionStore({ tableName: "app-session", region: "us-east-1" }), sessionSalt: process.env.SESSION_SALT! },
}).addApi("getCompany", {
    input: z.object({ slug: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
}, async ({ apiPayload }, res) => res.api(await loadCompany(apiPayload.slug)));

export type ApiContractType = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

Registration chains onto the creation call: every `addApi` returns an instance
carrying the contract so far, so the whole backend is one declaration and
`lambder.ApiContract` is the accumulated type.

The frontend imports that contract type and gets autocomplete, typed payloads
and typed results with no hand-written client:

```typescript
import { LambderCaller } from "lambder/client";
import type { ApiContractType } from "./backend/handler";

const caller = new LambderCaller<ApiContractType>({ apiPath: "/api", isCorsEnabled: false });
const company = await caller.api("getCompany", { slug: "acme" });
```

## Features

- **Type-safe APIs with Zod.** Define inputs and outputs with Zod schemas; get
  runtime validation and compile-time inference on both sides of the wire.
- **One inferred contract.** The API contract is derived from the backend code
  and consumed by the frontend as a type-only import.
- **Simple route and API declaration.** Paths, regexes, predicates and
  structured matchers, chained fluently.
- **Sessions.** Over a store of your choosing (DynamoDB, memory, your own),
  with secrets hashed at rest, sliding expiration, data refresh and
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
- **Lambda to lambda calls.** `LambderInvokeCaller` invokes a Lambder app in
  another function directly, with no API Gateway in between, typed from the
  callee's own contract and carrying its refusals, crash detail and logs back.
- **Frontend hosting.** Serve a build from a folder, S3, R2 or any HTTP
  origin, with an app shell rendered through a build-pipeline-safe template
  engine.
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
| `lambder` on AWS Lambda (any current Node.js runtime; the package needs Node 20 or later) | `zod`. The runtime already provides the AWS SDK v3, so mark the SDK packages as dev dependencies and keep them out of the deployment package |
| `lambder` anywhere else (a long-running server, a container, local tests) | `zod`, plus `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` when sessions or the DynamoDB stores are used; both are loaded on the first table access, so an app that uses neither needs neither |
| `LambderS3FileSource` | `@aws-sdk/client-s3`, loaded on first read |
| `LambderInvokeCaller` | `@aws-sdk/client-lambda`, loaded on the first call |
| `lambder/mock` | nothing; `msw` only for the optional network-panel adapter |

The SDK and its `@smithy` tree are roughly 21MB installed, which is why they are
peers rather than dependencies: a frontend importing only `lambder/client` has
no use for any of it, and a Lambda deployment package should not ship a second
copy of what the runtime already loads. The runtime pins its own SDK version,
so if you need a specific one, install it and bundle it yourself.

## Package entry points

The package ships three entry points; pick by where the code runs:

| Entry | Runs in | Carries |
| --- | --- | --- |
| `lambder` | Server (Lambda) | The full framework: pipeline, sessions, DDB stores, policies, plus the API core's building blocks and everything from `lambder/client` except the two request-compression helpers, `compressPayloadGzip` and `isRequestCompressionAvailable`, which stay on the client entry where a payload is compressed |
| `lambder/client` | Browser and isomorphic shared code | `LambderCaller`, `LambderApiRefusal`/`refuse`, the API contract and envelope types, `html`/`xml` tagged templates, `createLambderI18n` |
| `lambder/mock` | Browser and Node, in development and tests | `LambderMockApp`, the mock runtime: your typed contract served from mock handlers over the real API pipeline and memory stores |

Frontends and shared isomorphic packages should import from `lambder/client`
only; the entry's module graph contains no AWS SDK, Node built-ins, or server
pipeline, so the browser boundary is structural rather than left to
tree-shaking.

Source layout mirrors this: `src/api/` (the isomorphic API core: request,
answer, envelope, pipeline, and the declarative policies the pipeline runs),
`src/core/` (the Lambda server adapter: routes, files, hooks, finalization),
`src/session/` (the session manager, controller and crypto), `src/stores/`
(every store implementation, DynamoDB and in-memory alike), `src/client/`,
`src/invoke/` (the lambda-to-lambda caller and the in-process handler
transport), `src/mock/` (the mock runtime), and `src/shared/` (isomorphic
modules every entry re-exports, grouped into `wire/` for the format both
sides speak, `contracts/` for the four store interfaces, `transport/` for the
caller-to-server seam, and `util/` for helpers).
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
| [Routing and actions](./docs/routing.md) | Routes, matchers, hooks, fallbacks, and non-HTTP invocations |
| [APIs and refusals](./docs/apis.md) | `addApi`/`addSessionApi`, the inferred contract, `refuse()` and `LambderApiRefusal` |
| [Responses](./docs/responses.md) | The render context, resolver methods, cookies, compression, ETag and the size cap |
| [Sessions](./docs/sessions.md) | Sessions over a store, cookie scope, secrets at rest, `dataRefresh`, the controller API |
| [API policies](./docs/api-policies.md) | Declarative rate limits, guards and idempotency, and mandatory authorization declarations |
| [Calling another lambda](./docs/invoke.md) | `LambderInvokeCaller`: invoking a Lambder app in another function, its contract, failures and compression |
| [The API core](./docs/api-core.md) | `LambderApiPipeline`: the one pipeline the server and the mock runtime run, the store interfaces, the transports |
| [Frontend client](./docs/client.md) | `LambderCaller`: typed calls, failure outcomes, timeouts, guard inputs, request compression, transports |
| [Frontend hosting](./docs/frontend-hosting.md) | File sources, `servePublicFiles`, `serveIndexHtml`, `res.templateFile` |
| [Templating](./docs/templating.md) | `html`/`xml` tagged templates and `LambderTemplatingEngine` |
| [Translations](./docs/i18n.md) | `createLambderI18n`: typed keys, extension, detection, runtime dictionaries |
| [The mock runtime](./docs/mock.md) | `LambderMockApp`: the typed contract served from mock handlers over the real pipeline, in the browser and in tests |
| [DynamoDB tables](./docs/dynamodb-tables.md) | Table shapes, TTL and IAM for sessions, cache, rate limits and idempotency |
| [Exports reference](./docs/exports.md) | Every name the three entry points export, grouped by purpose |

## Standalone modules

Self-contained tools that ship with the package and work with or without the
framework:

| Module | Guide | Description |
| --- | --- | --- |
| `html` / `xml` tags + `LambderTemplatingEngine` | [Templating](./docs/templating.md) | Type-safe tagged templates and a comment-only HTML template engine (build-pipeline-safe) |
| `createLambderI18n` | [Translations](./docs/i18n.md) | Typed translations with enforced/optional languages, component-level extension and auto language detection (isomorphic) |
| `LambderDdbCache` | [DynamoDB cache](./docs/ddb-cache.md) | DynamoDB-backed compressed JSON cache with lease-based single-fill and grouped keys (server-only) |
| `LambderDdbRateLimiter` / `LambderMemoryRateLimiter` | [Rate limiter](./docs/ddb-rate-limiter.md) | Fixed-window rate limiter, atomic per window, in DynamoDB (server-only) or in memory |
| `LambderDdbIdempotencyStore` / `LambderMemoryIdempotencyStore` | [Idempotency store](./docs/ddb-idempotency.md) | Idempotency records with owner-checked claims, in DynamoDB (compressed replays, server-only) or in memory |
| `LambderMockApp` | [The mock runtime](./docs/mock.md) | The typed contract served from mock handlers over the real API pipeline, with failure injection, sessions and a call log (isomorphic) |

## Versioning and changes

Released versions and what each one changed are in
[CHANGELOG.md](./CHANGELOG.md). The current major is v7, which moved the API
pipeline into an isomorphic core, put the session layer behind a store
interface, dropped the resolver argument from guards, and replaced the MSW
adapter with a mock runtime. Every break and what to do about it is in the
7.0.0 entry. The compiler finds most of them. Three it cannot are named there:
leftover `session` fields that `const` generics stop it from seeing, a
`region` that went from required to optional, and mock handlers that now take
the call context rather than the payload.

## Contributing

Contributions are welcome. Open an issue for a bug or an idea, or send a pull
request. `npm test` typechecks, builds `dist/` and runs the suite, and it must
pass before a change is ready: the type system carries a lot of this
framework's guarantees, so a change that only passes at runtime is not
finished. New behavior belongs in the matching page under
[docs/](./docs/README.md) and in [CHANGELOG.md](./CHANGELOG.md) too.

## License

MIT. See [LICENSE](./LICENSE).

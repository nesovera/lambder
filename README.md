# Lambder

A highly opinionated serverless web framework for TypeScript on AWS Lambda.
Lambder handles HTTP requests, routes, type-safe APIs, sessions and the
declarative policy layer around them (rate limits, authorization guards,
idempotency), so an application is a set of declarations rather than a pile of
per-handler boilerplate.

```typescript
import { initLambder, LambderLocalFileSource } from "lambder";
import { z } from "zod";

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    files: new LambderLocalFileSource({ root: "./public" }),
    session: { tableName: "app-session", tableRegion: "us-east-1", sessionSalt: process.env.SESSION_SALT! },
});

lambder.addApi("getCompany", {
    input: z.object({ slug: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
}, async ({ apiPayload }, res) => res.api(await loadCompany(apiPayload.slug)));

export type ApiContractType = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

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
- **Sessions.** DynamoDB-backed, with secrets hashed at rest, sliding
  expiration, data refresh and cross-subdomain cookies.
- **Declarative policies.** Named rate-limit policies, authorization guards and
  idempotency, referenced by name from an API declaration and checked at
  compile time.
- **A real response pipeline.** Automatic Brotli/gzip, ETag and 304 handling,
  cookies, and a guard against Lambda's response size cap.
- **Hooks and actions.** Lifecycle hooks, plus `addAction()` for the non-HTTP
  invocations (EventBridge, SQS, custom events) the same function receives.
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

`zod` and the AWS SDK clients are optional peer dependencies, so installing
lambder never drags them into your tree. Add whatever the code you actually
import needs:

| What you import | What to install alongside |
| --- | --- |
| `lambder/client` (browser, shared isomorphic code) | `zod` |
| `lambder` on AWS Lambda (`nodejs18.x` and later) | `zod`. The runtime already provides the AWS SDK v3, so mark the SDK packages as dev dependencies and keep them out of the deployment package |
| `lambder` anywhere else (a long-running server, a container, local tests) | `zod`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` |
| `LambderS3FileSource` | `@aws-sdk/client-s3`, loaded on first read |
| `lambder/testing` | `msw` |

The SDK and its `@smithy` tree are roughly 21MB installed, which is why they are
peers rather than dependencies: a frontend importing only `lambder/client` has
no use for any of it, and a Lambda deployment package should not ship a second
copy of what the runtime already loads. The runtime pins its own SDK version,
so if you need a specific one, install it and bundle it yourself.

## Package entry points

The package ships three entry points; pick by where the code runs:

| Entry | Runs in | Carries |
| --- | --- | --- |
| `lambder` | Server (Lambda) | The full framework: pipeline, sessions, DDB stores, policies, plus everything from `lambder/client` |
| `lambder/client` | Browser and isomorphic shared code | `LambderCaller`, `LambderApiError`/`refuse`, the API contract and envelope types, `html`/`xml` tagged templates, `createLambderI18n` |
| `lambder/testing` | Dev and test tooling | `LambderMSW`, the MSW adapter that serves your typed contract from mock handlers |

Frontends and shared isomorphic packages should import from `lambder/client`
only; the entry's module graph contains no AWS SDK, Node built-ins, or server
pipeline, so the browser boundary is structural rather than left to
tree-shaking.

Source layout mirrors this: `src/core/` (request pipeline), `src/policies/`
(declarative rate limits, guards, idempotency), `src/session/`, `src/stores/`
(DynamoDB primitives), `src/client/`, and `src/shared/` (isomorphic modules
both entries re-export).

## Documentation

Start with [Getting started](./docs/getting-started.md), then reach for the
guide that matches what you are building. The full index lives in
[docs/](./docs/README.md).

| Guide | Covers |
| --- | --- |
| [Getting started](./docs/getting-started.md) | The three-step path from a first API to a typed frontend call |
| [Configuration](./docs/configuration.md) | Every `initLambder().create({...})` option, in one reference |
| [Routing and actions](./docs/routing.md) | Routes, matchers, hooks, fallbacks, and non-HTTP invocations |
| [APIs and refusals](./docs/apis.md) | `addApi`/`addSessionApi`, the inferred contract, `refuse()` and `LambderApiError` |
| [Responses](./docs/responses.md) | The render context, resolver methods, cookies, compression, ETag and the size cap |
| [Sessions](./docs/sessions.md) | DynamoDB sessions, cookie scope, secrets at rest, `dataRefresh`, the controller API |
| [API policies](./docs/api-policies.md) | Declarative rate limits, guards and idempotency, and mandatory authorization declarations |
| [Frontend client](./docs/client.md) | `LambderCaller`: typed calls, failure outcomes, timeouts, guard inputs, request compression |
| [Frontend hosting](./docs/frontend-hosting.md) | File sources, `servePublicFiles`, `serveIndexHtml`, `res.templateFile` |
| [Templating](./docs/templating.md) | `html`/`xml` tagged templates and `LambderTemplatingEngine` |
| [Translations](./docs/i18n.md) | `createLambderI18n`: typed keys, extension, detection, runtime dictionaries |
| [Testing](./docs/testing.md) | `LambderMSW`: typed MSW mocking of the API contract |
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
| `LambderDdbRateLimiter` | [Rate limiter](./docs/ddb-rate-limiter.md) | DynamoDB fixed-window rate limiter, atomic per window (server-only) |
| `LambderDdbIdempotency` | [Idempotency store](./docs/ddb-idempotency.md) | DynamoDB idempotency records with owner-checked claims and compressed replays (server-only) |
| `LambderMSW` | [Testing](./docs/testing.md) | Typed MSW mocking of the API contract for frontend development |

## Versioning and changes

Released versions and what each one changed are in
[CHANGELOG.md](./CHANGELOG.md). The current major is v5, which is v4's API
plus this documentation set: upgrading from 4.x needs no code changes.
Upgrading from 3.x is covered by the breaking-changes section of the 4.0.1
entry.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to
run the tests and what a good change looks like.

## License

MIT. See [LICENSE](./LICENSE).

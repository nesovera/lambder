# Lambder documentation

Reference and guides for [Lambder](../README.md), a serverless web framework
for TypeScript on AWS Lambda. Each page stands on its own; read them in this
order the first time.

## Start here

| Page | Covers |
| --- | --- |
| [Getting started](./getting-started.md) | Define an API, export the contract, call it from a typed frontend |
| [Configuration](./configuration.md) | Every option `initLambder().create({...})` accepts, in one reference |

## Building a backend

| Page | Covers |
| --- | --- |
| [Routing and actions](./routing.md) | `addRoute`, matchers, path params, hooks, fallback handlers, and `addAction` for non-HTTP invocations |
| [APIs and refusals](./apis.md) | `addApi` and `addSessionApi`, the inferred contract, modular APIs with `use()`, `refuse()` and `LambderApiRefusal` |
| [Responses](./responses.md) | The render context, resolver methods, `die`, cookies, compression, ETag, and Lambda's size caps |
| [Sessions](./sessions.md) | Sessions over a store (DynamoDB, memory, your own), cookie scope and migrations, secrets at rest, `dataRefresh`, the session controller |
| [API policies](./api-policies.md) | Declarative rate limits, guards and idempotency, and making an authorization declaration mandatory |
| [Calling another lambda](./invoke.md) | `LambderInvokeCaller`: invoking a Lambder app in another function directly, with its contract, crash detail and logs |
| [Testing](./testing.md) | `lambderTestApp`: your real instance under test in this process, memory stores put under it in place, simulated browsers in front of it, outcome assertions, time, and where every other kind of test lives |
| [The API core](./api-core.md) | `LambderApiPipeline`: the one request pipeline the server and the mock runtime run, the request and answer shapes, store interfaces, transports |

## Building a frontend

| Page | Covers |
| --- | --- |
| [Frontend client](./client.md) | `LambderCaller`: typed calls, `apiOutcome`, timeouts, guard inputs, idempotency keys, request compression, transports |
| [Frontend hosting](./frontend-hosting.md) | File sources (local, S3, R2, HTTP), `servePublicFiles`, `serveIndexHtml`, `res.templateFile` |
| [Templating](./templating.md) | `html`/`xml` tagged templates and the comment-only `LambderTemplatingEngine` |
| [Translations](./i18n.md) | `createLambderI18n`: typed keys, component extension, language detection, on-demand languages, runtime dictionaries |
| [The mock runtime](./mock.md) | `LambderMockApp`: your typed contract served from mock handlers over the real pipeline, in the browser and in tests |

## Infrastructure and stores

| Page | Covers |
| --- | --- |
| [DynamoDB tables](./dynamodb-tables.md) | Table shapes, TTL and IAM for sessions, cache, rate limits and idempotency |
| [DynamoDB cache](./ddb-cache.md) | `LambderDdbCache`: compressed values, memory layer, fill lease, grouped keys |
| [Rate limiter](./ddb-rate-limiter.md) | `LambderDdbRateLimiter`: fixed windows, atomic counting, fail-open |
| [Idempotency store](./ddb-idempotency.md) | `LambderDdbIdempotencyStore`: claims, replays, owner tokens, stored bodies |

## Full surface

| Page | Covers |
| --- | --- |
| [Exports reference](./exports.md) | Every name the four entry points export, grouped by purpose |

## Elsewhere in the repository

- [CHANGELOG.md](../CHANGELOG.md) covers what each released version changed.
- [examples/](../examples/) holds runnable sketches: a chained Zod API, a
  secure session flow, and a mock runtime setup.

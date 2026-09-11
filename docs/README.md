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
| [APIs and refusals](./apis.md) | `addApi` and `addSessionApi`, the inferred contract, modular APIs with `use()`, `refuse()` and `LambderApiError` |
| [Responses](./responses.md) | The render context, resolver methods, `die`, cookies, compression, ETag, and Lambda's size caps |
| [Sessions](./sessions.md) | DynamoDB sessions, cookie scope and migrations, secrets at rest, `dataRefresh`, the session controller |
| [API policies](./api-policies.md) | Declarative rate limits, guards and idempotency, and making an authorization declaration mandatory |

## Building a frontend

| Page | Covers |
| --- | --- |
| [Frontend client](./client.md) | `LambderCaller`: typed calls, `apiOutcome`, timeouts, guard inputs, idempotency keys, request compression |
| [Frontend hosting](./frontend-hosting.md) | File sources (local, S3, R2, HTTP), `servePublicFiles`, `serveIndexHtml`, `res.templateFile` |
| [Templating](./templating.md) | `html`/`xml` tagged templates and the comment-only `LambderTemplatingEngine` |
| [Translations](./i18n.md) | `createLambderI18n`: typed keys, component extension, language detection, runtime dictionaries |
| [Testing](./testing.md) | `LambderMSW`: typed MSW mocking of your API contract |

## Infrastructure and stores

| Page | Covers |
| --- | --- |
| [DynamoDB tables](./dynamodb-tables.md) | Table shapes, TTL and IAM for sessions, cache, rate limits and idempotency |
| [DynamoDB cache](./ddb-cache.md) | `LambderDdbCache`: compressed values, memory layer, fill lease, grouped keys |
| [Rate limiter](./ddb-rate-limiter.md) | `LambderDdbRateLimiter`: fixed windows, atomic counting, fail-open |
| [Idempotency store](./ddb-idempotency.md) | `LambderDdbIdempotency`: claims, replays, owner tokens, stored bodies |

## Full surface

| Page | Covers |
| --- | --- |
| [Exports reference](./exports.md) | Every name the three entry points export, grouped by purpose |

## Elsewhere in the repository

- [CHANGELOG.md](../CHANGELOG.md) covers what each released version changed.
- [CONTRIBUTING.md](../CONTRIBUTING.md) covers running the tests and the
  conventions a change is expected to follow.
- [examples/](../examples/) holds runnable sketches: a chained Zod API, a
  secure session flow, and an MSW test setup.

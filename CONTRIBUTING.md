# Contributing

Contributions are welcome. Open an issue for a
bug or an idea, or send a pull request.

## Getting set up

```bash
npm install
```

Node 18 or later. The AWS SDK v3 packages, `zod` and `msw` are optional peer
dependencies of the published package but ordinary dev dependencies here, so a
plain install gives you everything the tests need.

## Working on a change

| Command | What it does |
| --- | --- |
| `npm test` | Typecheck, then run the whole vitest suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc -p tsconfig.tests.json`, which covers `src` and `tests` |
| `npm run build` | Emit `dist/` with `tsc` |
| `npm run lint` | ESLint over the TypeScript sources, with `--fix` |

`npm test` must pass before a pull request is ready. The type system carries a
lot of this framework's guarantees, so the typecheck is not a formality: a
change that only passes at runtime is not finished.

## What a good change looks like

- **Tests come with it.** `tests/` is organized by feature area
  (`session.test.ts`, `api-policies.test.ts`, `response-pipeline.test.ts`, and
  so on); add to the file that already covers the area rather than starting a
  new one. Behavior that can only be verified at the type level belongs in a
  test too, as a compile-time assertion.
- **Types are inferred, not asserted.** Contract, policy names, guard metadata
  and session data types are all derived from what the caller declared. A new
  option that needs a hand-written type argument at the call site is usually a
  design problem, not an ergonomic one.
- **The browser boundary is structural.** Nothing reachable from
  `src/client.ts` may import the AWS SDK, a Node built-in, or the server
  pipeline. Isomorphic code lives in `src/shared/`.
- **One implementation per capability.** Compression, for example, goes through
  `shared/LambderCompressionCodec.ts` everywhere: at rest, on the wire, in
  responses. If a second copy of something starts to appear, that is the signal
  to share the first one.
- **Documentation is part of the change.** A new option, method or behavior
  belongs in the matching page under [docs/](./docs/README.md), and anything
  users would notice belongs in [CHANGELOG.md](./CHANGELOG.md) under the
  release it ships in.

## Source layout

| Directory | Contents |
| --- | --- |
| `src/core/` | The request pipeline: context, routing, responses, files, templating |
| `src/policies/` | Declarative rate limits, guards and idempotency |
| `src/session/` | Session manager and controller |
| `src/stores/` | DynamoDB primitives: cache, rate limiter, idempotency, S3 file source |
| `src/client/` | `LambderCaller` and the MSW adapter |
| `src/shared/` | Isomorphic modules both entry points re-export |

The three entry points (`src/index.ts`, `src/client.ts`, `src/testing.ts`)
define the public surface. Anything not exported from one of them is internal
and can change without a major version.

## Releasing

Releases are cut by the maintainer. The `deploy` script runs the tests, bumps
the patch version, builds `dist/` and publishes to npm; version notes are
written into [CHANGELOG.md](./CHANGELOG.md) as part of the release commit.

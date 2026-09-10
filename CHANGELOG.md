# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by the published npm version; a minor line's feature notes
sit on its first published patch, and later patches list only what they changed.
Releases up to 3.2.6 carry git tags; the ones after it were published without
one, so versions are not cross-linked to tag comparisons here.

## [5.0.0] - 2026-09-10

The v4 line is closed and its accumulated surface is released as v5. **There
are no breaking API changes**: code written against 4.9.1 compiles and runs
unchanged. The major marks the documentation and packaging milestone rather
than a migration.

### Added

- **A documentation set**, replacing the single 78KB readme. Eighteen guides
  under [docs/](./docs/README.md), organized by task: getting started,
  configuration, routing and actions, APIs and refusals, responses, sessions,
  API policies, the frontend client, frontend hosting, templating,
  translations, testing, the four DynamoDB tables, the three standalone
  stores, and a full exports reference. The readme is now an overview that
  links into them.
- **This changelog.** Release notes used to accumulate as "New in 4.x" blocks
  at the top of the readme; they now live here, back to 3.0.0, with the 3.4
  through 3.8 entries reconstructed from the source history rather than left
  as a pointer at the git log.
- **`docs/exports.md`**, a reference for all 154 exported names across the
  three entry points, grouped by purpose. Every export is now documented.
- **Guides for `LambderDdbRateLimiter` and `LambderDdbIdempotency`**, which
  shipped as standalone modules but had no documentation of their own.
- **`CONTRIBUTING.md`**: setup, the test and lint commands, the conventions a
  change is expected to follow, and the source layout.
- **Package metadata**: `description`, `author`, `keywords`, `homepage`,
  `bugs` and `engines` were empty or absent, so the npm page showed nothing
  about the package.

### Changed

- **Standard file names**: `Readme.md` is `README.md` and `License.md` is
  `LICENSE`; the `docs/` pages moved from `SCREAMING_SNAKE.md` to kebab-case.
- **The quick start was rewritten.** It had gone stale at v2.0: it taught
  `new Lambder({...})` instead of `initLambder().create({...})` and imported
  `LambderCaller` from `lambder` rather than `lambder/client`.
- **`eslint` runs again.** The config extended `standard-with-typescript`,
  which was never installed, so `npm run lint` failed to start. It now uses
  the `@typescript-eslint` packages the repo already carries, with the
  generics-heavy rules (`no-explicit-any`, `{}` as a generic default, unused
  handler arguments) relaxed deliberately and the rest of
  `eslint:recommended` on. The tree lints clean.

### Fixed

- `res.file` was documented as taking a `fallback` option, which 4.5.1
  removed.
- A handful of dead imports in the test suite, and three type-level
  assertions that now carry the codebase's `_` prefix for declarations that
  exist to be typechecked rather than used.

## [4.9.1] - 2026-09-10

### Added

- **Mandatory authorization on public APIs.** `requirePublicApiGuards: true` at
  creation makes `guards` a required field of every `addApi`, the same way
  `requireSessionApiGuards` does for session APIs, at the type level and at
  registration. Public APIs are open by default and that stays the default;
  what turning it on buys is that a public endpoint's openness becomes a
  written decision rather than an omission. The ones anybody may call declare a
  named no-op guard carrying the reason
  (`guards: { open: "Static strings already in the bundle." }`), the ones that
  authorize their caller some other way (a signature, a device secret, a
  one-shot token) name where that happens, and one grep over the guard names
  then lists every public door and why it is open. The two flags are
  independent, so an app can require either or both.

### Fixed

- **An empty `guards` option is refused.** `guards: {}` and `guards: []` were
  inhabited by the option type and passed the `require*ApiGuards` field check
  while normalizing to zero entries, so a declaration that authorized nothing
  satisfied a requirement that exists to make authorization explicit. Both are
  now compile errors (every form of the option is non-empty by construction)
  and a registration error for a plain-JS caller, whichever flag is on or off.
  Requiring the chosen key also rejects `guards: { theGuard: undefined }`,
  which an optional property accepted and which reached the guard's handler
  with an undefined param.

## [4.8.1] - 2026-09-08

### Added

- **Grouped cache keys.** `LambderDdbCache` keys may be a `{ pk, sk }` pair
  instead of a string, which stores related entries in one partition:
  `{ pk: "division:ist-34", sk: "1700:1800" }` keeps every cached window of one
  division together. `deletePartition(pk)` then drops the whole group without
  knowing which sort keys exist, and `listSortKeys(pk, { prefix, limit })`
  reads back what is currently cached under it. The group invalidation a cache
  of derived, per-entity values needs, in place of remembering every key ever
  written or waiting out the TTL. Reads stay one request, and the memory layer,
  single-flight and fill lease stay per entry. Only the `pk` part is hashed, so
  the sort key is queryable; a caller's `#` is escaped rather than refused
  (`~` to `~0`, `#` to `~1`). Plain string keys keep their exact item layout,
  so a live table needs no migration and both forms can share a partition.
- **`guards` on the API contract.** Each contract entry now carries the `guards`
  option exactly as declared (`ApiContractType["getUser"]["guards"]` is the
  literal `{ readonly orgPermission: "USERS.MANAGE" }`), so a client-side map
  of what an API needs can be pinned to the server's own declaration with
  `satisfies` instead of a test that reads the server source.

## [4.7.3] - 2026-09-08

### Fixed

- `use()` listed one generic short of the class's parameter list, so the
  missing one fell back to its default and an instance carrying a non-default
  value became unassignable to its own plugins (`requireSessionApiGuards` did
  exactly that in 4.7.1).

## [4.7.1] - 2026-09-08

### Added

- **Compressed request payloads.** `requestCompression` on `LambderCaller`
  gzips the payload of any call whose JSON reaches a threshold (`true` is
  `{ minBytes: 4096 }`), sending it as `payloadGz` beside its byte length
  instead of `payload` whenever that is actually smaller; the server restores
  it before rate-limit key slices, guards and input validation, so no call
  site, handler or schema changes. Chiefly a way to fit a large payload under
  Lambda's ~6MB invoke cap, which applies to the compressed bytes. The envelope
  stays `application/json` with its routing fields in plain text, so gateways,
  CDNs and mocks are unaffected. `maxRequestPayloadBytes` (default 20MB) bounds
  what a body may expand to.
- **Mandatory authorization on session APIs.** `requireSessionApiGuards: true`
  at creation makes `guards` a required field of every `addSessionApi`, at the
  type level (a missing declaration is a compile error at the registration
  site) and at registration (a plain-JS caller throws). An API the session
  alone authorizes declares a named no-op session guard, so every opt-out is
  explicit and one grep lists them all. The class of defect this closes is
  "the guard existed and the endpoint did not use it", which review discipline
  does not catch as a surface grows.
- **Brotli responses.** Response compression now negotiates `br` before `gzip`,
  smaller at comparable speed (15-25% on markup and prose, substantially more
  on the repetitive record lists API responses tend to be), which is bandwidth
  saved and headroom gained against the ~6MB response cap.
  `compression: { encodings: ["gzip"] }` opts out, `quality` (default 5) tunes
  it.

### Changed

- **One compression codec.** `shared/LambderCompressionCodec.ts` is now the only
  place Lambder compresses or decompresses bytes. Its
  `restoreBoundedText(bytes, declaredBytes, encoding)` carries the guarantee
  every compressed value in Lambder depends on, at rest and on the wire: the
  declared UTF-8 byte length bounds the decompression AND must match the result
  exactly, so a truncated, tampered or endlessly-expanding input fails instead
  of decoding to something merely plausible. Compression is split across three
  modules by what each one needs: the codec (zlib), the option and its resolver
  (pure, so the browser entry can resolve the caller's option), and the request
  payload format (the browser's `CompressionStream`).
- **One compression option, now everywhere.** The HTTP response option and the
  new request option resolve through the same `resolveCompressionOption` the
  DynamoDB stores and sessions use, and every site's option is the one generic
  `LambderCompressionOption<Settings>`. Same vocabulary at every site (`true`
  for that site's defaults, `false` for off, an object to override, `minBytes`
  as the threshold, `quality` as the Brotli quality, `encodings` as the
  negotiation order), same `Settings | null` resolved shape, and the same
  startup validation: `compression: { quality: 99 }` or `{ encodings: [] }` on
  a response is now a construction error instead of being silently ignored, and
  a field set to `undefined` keeps its default.

### Removed

- `stores/LambderDdbCompression.ts`, retired into the modules above.

## [4.6.2] - 2026-09-07

### Changed

- **`zod` and the AWS SDK clients are optional peer dependencies** rather than
  dependencies, so installing lambder never drags them into a tree that has no
  use for them: a frontend importing only `lambder/client` skips the ~21MB SDK
  entirely, and a Lambda deployment package does not ship a second copy of what
  the runtime already provides. Install whatever the code you actually import
  needs; see the peer dependency table in the README.

## [4.6.1] - 2026-09-07

### Added

- **Cookies as a first-class concern.** `res.setCookie(name, value, options)`
  and `res.clearCookie(name, options)` serialize Set-Cookie headers through the
  `cookie` package (defaults Path=/, SameSite=Lax, Secure; a function-form
  `domain` resolves against the request hostname, the same option the session
  takes), replacing hand-built header strings; `serializeCookie` and
  `serializeClearCookie` are exported for code holding a response.
  `ctx.cookieList` keeps every value a cookie name arrived with beside the
  first-wins `ctx.cookie`.

### Fixed

- **Session cookie scope changes heal.** A cookie's identity is
  (name, domain, path), so changing the session's `cookie.domain` or `path` on
  a live deployment leaves the old copy in every browser beside the new one,
  and a whole-header parse silently picks whichever the browser lists first.
  The controller now tries every copy of the session cookie (record and CSRF
  pairing checked per copy), logs the ambiguity, and evicts the stale host-only
  twin from the response, so a migrated browser recovers on its first request
  instead of answering `sessionExpired` until the old cookie expires.

## [4.5.1] - 2026-09-07

### Added

- **`files` at creation.** One `LambderFileSource` configured once:
  `files: new LambderLocalFileSource({ root: path.resolve("./public") })` for
  the folder bundled with the deployment, `new LambderS3FileSource({...})` for
  S3 or R2, or your own `{ read(relativePath) }`. The instance owns one reader
  over it (`lambder.files`): path rule, in-memory file cache and
  compiled-template cache in one place, shared by `servePublicFiles`,
  `serveIndexHtml`, `res.file` and `res.templateFile`, so a build hosted from a
  bucket serves its index.html and templates from the bucket too, cached the
  same way as its assets. The cache is tuned or disabled beside the source,
  `files: { source, memoryCache }`.

### Removed

- `publicPath` at creation and `servePublicFiles({ source })`, both replaced by
  `files`; `memoryCache` leaves `servePublicFiles` for the same reason.
- `res.file`'s SPA-era `fallback` option, which the fallback chain replaced.

## [4.4.1] - 2026-09-07

### Added

- **`guardInputsProvider`** on `LambderCaller`: supply guardInput-mode guard
  values for every call from one place (the organization the UI is on, a device
  token) instead of at each call site; per-call `guardInputs` merge on top.
  Name the covered guards in the caller's second type parameter,
  `new LambderCaller<Contract, "orgPermission">({ guardInputsProvider, ... })`:
  calls to APIs whose guardInput guards are all covered no longer require the
  options argument, uncovered ones (a Turnstile token) still do, and naming
  guards makes the provider itself mandatory.
- **Public file sources.** `servePublicFiles({ source })` serves from any
  `LambderPublicFileSource`: `LambderLocalFileSource` (a folder; the default),
  `LambderS3FileSource` (S3, or Cloudflare R2 and other S3-compatible stores
  via `clientConfig.endpoint`; `@aws-sdk/client-s3` is an optional peer
  dependency loaded on first read), or your own `{ read(relativePath) }`. The
  handler's traversal check, memory cache, mime fallback from the extension,
  Cache-Control, ETag and compression apply to every source. The `cacheControl`
  callback receives the relative file path.
- **`expireSessionDataAllByKey(sessionKey)`** on the session manager and
  controller: marks the data of every session of a subject stale, so each
  renews via `dataRefresh` on its next read. The way to apply a role or
  permission change to a user immediately, without logging them out
  (`deleteSessionAllByKey`) and without waiting for the data TTL.

## [4.3.2] - 2026-09-07

### Changed

- **One compression option everywhere.** `LambderDdbCache`,
  `LambderDdbIdempotency` and sessions take the same `compression` option
  (`true` for that store's defaults, `false` for off, `{ minBytes, quality }`
  to override), resolved by one shared function, and each store records a
  value's encoding so the option can be switched on or off on a live table.
  Defaults keep the previous behavior: the cache compresses everything, the
  idempotency store from 1KB. HTTP `compression` accepts `true` as
  `{ minBytes: 860 }`.

### Removed

- `compressionQuality` on the cache and idempotency store, replaced by
  `compression: { quality }`.

## [4.3.1] - 2026-09-07

### Added

- **Compressed sessions.** `session.data` is stored Brotli-compressed by
  default, as `dataBr` + `dataBytes` on the record, the same scheme
  `LambderDdbCache` and `LambderDdbIdempotency` use (one shared
  implementation). A session that caches roles, permissions or product lists
  shrinks 2-3x and stays within one DynamoDB read unit for longer.
  `session.compression` is `true` by default (the same as `{ minBytes: 0 }`:
  every record compressed); `false` turns it off and `{ minBytes }` compresses
  only from that JSON size. Records written under either setting read back, so
  it can be switched on or off on a live table.

## [4.2.3] - 2026-09-06

### Added

- **One refusal shape, with codes.** `LambderRefusalMessage` gained an optional
  machine-readable `code` (`refuse(content, { code })`), so clients branch and
  translate on an identifier instead of string-matching prose. Every refusal
  the framework itself authors (rate limit 429, idempotency 409 and 400,
  unknown API) is a `LambderRefusalMessage` stamped with a
  `LAMBDER_REFUSAL_CODES` constant under the reserved `lambder/` prefix; a
  rate-limit policy's own `errorMessage` (typed as a refusal message) inherits
  `lambder/rate-limited` unless it sets a code.

## [4.2.1] - 2026-09-06

### Added

- **Rate-limit budgets.** A policy's `budget` is `"perApi"` (default: each
  referencing API gets its own counter, so the numbers are a per-API ceiling
  and three APIs on a 60/min policy allow one IP 180/min in total) or
  `"perPolicy"` (one counter shared by every API referencing the policy). The
  policy is the group, and two separate shared budgets are two policies.
- **Per-API tuning.** The `rateLimit` option gained a map form like guards,
  `rateLimit: { lookupPerIp: { perMin: 20 } }`, which merges window overrides
  over a perApi policy's own (a tighter burst keeps the policy's daily cap).
  Overriding the windows of a perPolicy policy is a startup error;
  `errorMessage` is overridable on either.
- **Retry-After.** A 429 carries the exceeded window's reset as a `Retry-After`
  header (CORS exposes it by default via the new `exposeHeaders` option),
  `LambderCaller` failure outcomes surface it as `retryAfterSeconds`,
  `LambderDdbRateLimiter.isRateLimited()` answers
  `false | { window, limit, resetAt }`, and `LambderApiError` and `refuse()`
  accept `headers`.

### Changed

- **One validation path.** Preflight slices (guard `apiInput` and `guardInput`,
  rate-limit `apiInput` keys) answer through
  `setApiInputValidationErrorHandler` exactly like the API's own schema.

## [4.1.1] - 2026-09-06

### Changed

- **Configuration at creation.** `initLambder<SessionData>().create({...})`
  takes the WHOLE configuration (serving options, session, cors, rate limits,
  guards, idempotency) in one declaration, so nothing can be half-configured or
  wired in the wrong order, and api modules annotate with `typeof lambderApp`
  derived from the real instance.

### Removed

- The enable/define chain methods `enableApiRateLimits`,
  `enableApiIdempotency` and `defineApiGuards`, in favor of the `rateLimits`,
  `idempotency` and `guards` options of `create()`.

## [4.0.1] - 2026-09-06

### Added

- **Declarative auth as guards.** Guards take per-API params
  (`guards: { orgPermission: "SOME.PERMISSION" }`), can require a session
  (`session: true`, compile-checked), and RETURN typed values that land on the
  handler's `ctx.guardData[name]`. Together with the apiInput/guardInput input
  modes, permission checks and device auth become registration-time
  declarations instead of per-handler boilerplate.
- **Three package entry points.** `lambder` (server), `lambder/client`
  (browser-safe by construction: no AWS SDK, no Node built-ins),
  `lambder/testing` (`LambderMSW`); sources organized into core, policies,
  session, stores, client and shared.
- **`LambderCaller.createIdempotencyKeyScope()`** for one self-rotating key per
  logical operation.

### Changed

- **Hardened policy layer.** Rate-limit policies can share one counter across
  APIs (now `budget: "perPolicy"`); idempotency replays answer before rate
  limits, survive client IP changes (key-scoped for public APIs, 16-char
  minimum keys), store full response headers, refuse to store Set-Cookie
  responses, and Brotli-compress stored bodies of 1KB+ so the ~350KB replay
  budget applies to compressed bytes.
- **Secrets hashed at rest.** Session records store only sha256 hashes of the
  bearer secrets, so a session-table read yields no usable cookies;
  `LambderSessionReadError` keeps a DynamoDB blip from reading as a logout.
- Fail-open rate limiting logs its passes.
- `LambderDdbIdempotency.complete()` answers `"stored" | "too-large" | "lost"`.
- Idempotency keys must be 16-200 characters.

### Removed

- `LambderCaller.apiRaw()`; use `apiOutcome()`, whose failure outcomes carry
  the envelope on `response`.
- The `multiValueHeaders` alias on `res.raw()`; use `headers`.

### Breaking

Upgrading from 3.x:

- Configuration moved entirely to creation, removing `enableCors`,
  `enableDdbSession`, `setSessionCookieKey`, `enableApiRateLimits`,
  `enableApiIdempotency` and `defineApiGuards` in favor of the `cors`,
  `session`, `rateLimits`, `guards` and `idempotency` options of
  `initLambder().create({...})`. (The chain methods were removed in 4.1.1.)
- Session records are reshaped (hashes at rest); live sessions invalidate once
  on upgrade and clients just re-login.
- The manager-level `createSession` and `regenerateSession` return
  `LambderCreatedSession` (`{ session, sessionToken, csrfToken }`); the
  controller API is unchanged.
- `LambderMSW` moved from the root entry to `lambder/testing`.
- `LambderCaller.apiRaw()`, the `multiValueHeaders` alias, and the old
  idempotency `complete()` return shape are gone (see Removed and Changed).

## [3.8.1] - 2026-09-06

### Added

- Guards and custom rate-limit keys gained two typed input modes: **apiInput**
  (checks a slice of the API's own payload, declarable only where the schema
  carries those fields) and **guardInput** (a separate client-sent
  `guardInputs` channel the contract makes mandatory at the call site).

## [3.7.1] - 2026-09-06

### Added

- Guards and custom rate-limit keys became payload-sliced
  (`{ input, handler }`): the slice is validated before the handler runs, typed
  in the handler, and force-merged into the contract input.

## [3.6.1] - 2026-09-06

### Added

- **`refuse()`** and the standard `LambderRefusalMessage` shape: a one-liner
  callable from anywhere in an API call's stack, with never-return narrowing,
  over `LambderApiError`.

## [3.5.2] - 2026-09-06

### Added

- **Typed API refusals** with `LambderApiError`, so a refusal never pollutes
  crash logging and clients get a parseable response.
- **Caller outcomes and timeouts**: `apiOutcome()` resolves to a discriminated
  union instead of collapsing every failure to `null`, and `timeoutMs` aborts a
  call in the constructor or per call.
- **Declarative per-API policies**: rate limits, guards and idempotency,
  including `LambderDdbIdempotency`.

## [3.4.2] - 2026-09-06

### Added

- **`dataRefresh`** on the session: session data derived from external state
  (roles, permissions, feature flags) gets a shelf life, renewed in place on
  the same record past its `ttlSeconds` by an app callback, so changes reach
  every live session without a mass invalidation. Returning `null` ends the
  session; a thrown error surfaces as `LambderSessionDataRefreshError` and
  leaves the session untouched.

## [3.3.3] - 2026-08-26

### Added

- **`LambderDdbRateLimiter`**, a standalone DynamoDB fixed-window rate limiter.

## [3.3.1] - 2026-08-26

### Added

- Session cookie `Domain` may be resolved per request host, for one deployment
  serving several apex domains.

## [3.3.0] - 2026-08-16

### Changed

- **`serveIndexHtml` stopped guessing whether a path is a file.**
  `servePublicFiles` has already served every real file by then, so anything
  reaching this slot is an app route, dotted ones included. `skipFilePaths: true`
  opts back into 404ing paths whose last segment contains a dot.

## [3.2.6] - 2026-08-03

### Fixed

- Payload v2: the named stage prefix is stripped from `rawPath`, for parity
  with the v1 path.

## [3.2.5] - 2026-08-03

### Fixed

- Payload v2 hardening: format-aware error-path responses.

## [3.2.1] - 2026-08-03

### Added

- **`createLambderI18n`**: typed translations with enforced and optional
  languages, component-level extension, runtime dictionaries, and automatic
  language detection. Isomorphic and dependency-free.

## [3.1.0] - 2026-08-02

### Added

- **`LambderDdbCache`**, a standalone Brotli-compressed DynamoDB cache with an
  in-memory LRU layer, single-flight deduplication and a fill lease.

## [3.0.0] - 2026-08-02

### Added

- Public file serving with `servePublicFiles()` and `serveIndexHtml()`.
- Unified `addAction()` for non-HTTP triggers (EventBridge, SQS, custom
  events), dispatched by the same handler.
- Automatic gzip and ETag on the response pipeline.
- Thrown responses with a real `die`.
- The comment-based `LambderTemplatingEngine` and type-safe `html`/`xml`
  tagged templates.
- API Gateway HTTP API (payload v2) and Lambda Function URL support, detected
  per event.
- Typed AWS contracts and session hardening.

## Earlier versions

2.x and earlier are documented in the git history.


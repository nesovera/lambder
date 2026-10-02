# Exports reference

Every name the five entry points export, grouped by what it is for. Anything
not listed here is internal and may change without a major version.

- `lambder` is the server surface: the Lambda adapter, the API core, the
  session model and its DynamoDB store, the policy engines and every store,
  the callers and transports, plus everything from `lambder/client`.
- `lambder/client` is the browser-safe subset. All but the browser-only
  compression helpers (`compressPayloadGzip`, `isRequestCompressionAvailable`)
  are also exported from `lambder`.
- `lambder/mock` carries the mock runtime, browser-safe like `lambder/client`.
- `lambder/testing` puts a real app under test in this process. Server-only,
  and reached by nothing else in the package, so no deployment carries it.
- `lambder/build` is what a generator script runs at build time: the
  signature file, the declared options as data, the generated contract, the
  schemas a mock validates against in development, and the check of every
  refusal a handler can reach.
  Node-only, and reached by nothing else in the package.

The **Client** column marks what `lambder/client` also exports; `client only`
marks the two names it exports that the root entry does not.

## The framework

| Export | Client | Description |
| --- | --- | --- |
| `initLambder` | | Curried creator: fix the session data type, then `create(options)`, `guard(...)`, `rateLimitKey(...)` and `refuse(...)` typed to it; `declareRefusals(vocabulary, options?)` first binds the app's refusal vocabulary (one map of codes, or a list of maps), so `guard`'s `ctx.refuse` and the init's `refuse` are typed to it and `create()` hands it to the instance. The canonical entry. See [Configuration](./configuration.md) |
| `Lambder` (default) | | The class itself. Use `initLambder` instead; a direct `new` widens the inferred policy types |
| `LambderResolver` | | The `res` object routes, hooks and fallback handlers receive: the response builder plus `res.die.*`, which throws what it builds |
| `LambderResponseBuilder` | | The response builder a resolver extends and a global error handler receives; reachable via `lambder.getResponseBuilder(ctx?)` |
| `createContext` | | Build a render context from a raw Lambda event, given `{ apiPath?, trustedClientIpHeaders?, trustedHostHeaders?, originProof? }` (`LambderContextOptions`, optional; `apiPath` defaults to `"/api"` as at `create()`) |
| `isV2HttpEvent` | | Whether an event uses payload format v2 |

Types: `LambderCreateOptions`, `LambderHandler`, `LambderRenderContext`, `LambderContextOptions`,
`LambderSessionRenderContext`, `LambderRenderContextOf` and
`LambderSessionRenderContextOf` (one instance's context, read off
`typeof lambderApp`, for a helper typed apart from its handlers),
`LambderHttpEvent`, `LambderHttpEventFormat`,
`LambderActionTools`, `LambderCorsConfig`, `LambderOriginProof` (the
`originProof` option), `LambderRequestArrival` (what `ctx.arrivedVia` holds:
`"proxy"`, `"direct"`, `"invoke"` or `"unverified"`), the `crashes` option's `LambderCrashOptions`,
`LambderCrashReporter`, `LambderCrashSite`, and the `callSummary` option's
`LambderCallSummary` (one call's line), `LambderCallSummaryOption`,
`LambderCallOutcome` (how a call ended) and `LambderCallOutcomeHint` (an
outcome with its refusal code).

Types of the handlers an app writes, so a hook or a route handler can be
declared apart from its registration: `LambderRoutePath`,
`LambderRouteHandler`, `LambderSessionRouteHandler`, `LambderActionHandler`,
`LambderActionFilter`, `LambderHookEvent`, `LambderCreatedHook`,
`LambderBeforeRenderHook`, `LambderAfterRenderHook`, `LambderFallbackHook`,
`LambderGlobalErrorHandler`, `LambderFallbackHandler`,
`LambderInputValidationHandler`.

## Routing

| Export | Client | Description |
| --- | --- | --- |
| (registration methods only) | | `addRoute`, `addSessionRoute`, `addAction`, `addHook` and the `set*Handler` methods live on the instance. See [Routing](./routing.md) |

Types: `LambderRouteMatcher`, `LambderRouteCondition`, `LambderRouteConditionFn`,
`LambderPathParamsOf`.

## Responses and cookies

| Export | Client | Description |
| --- | --- | --- |
| `LambderResponse` | | The response object the pipeline finalizes |
| `serializeCookie` | | Build a Set-Cookie header value |
| `serializeClearCookie` | | Build a Set-Cookie header value that deletes a cookie |
| `resolveCookieDomain` | | Resolve a string-or-function cookie domain against a hostname |

Types: `LambderHttpResponse`, `LambderRawResponseInit`,
`LambderResponseOptions`, `LambderTemplateFileOptions`, `LambderHeadersInput`,
`LambderHttpStatusCode` and `LambderRefusalStatusCode` (client and mock too), `LambderCookieOptions`, `LambderClearCookieOptions`,
`LambderCookieDomain`, `LambderResponseCompressionOption`,
`LambderResponseCompressionSettings`.

See [Responses](./responses.md).

## Endpoints: declarations, groups and names

An instance declares its endpoints as values: `defineApi(options, handler)`,
gathered by `defineApiGroup(name, { action: declaration })` (or loaded on
first call with `lazyApiGroup(name, load)`), registered by
`registerApiGroups(...groups)`. These are instance members; the exports
below are the names, paths and types they use.

| Export | Client | Description |
| --- | --- | --- |
| `apiCallPath` | yes | Where a call to an endpoint goes: `apiCallPath("/api", "orders.place")` is `/api/orders/place` |
| `apiNameOfCallPath` | | The endpoint a request path calls, or null for a path that is not `{apiPath}/{group}/{action}` |
| `splitApiName` | yes | An endpoint name as its group and action, or null for a name that is not two identifiers |
| `isGroupName`, `isActionName` | | Whether a name can be a group (an identifier no caller member has) or an action (an identifier no function member has) |
| `LAMBDER_API_NAME_SEGMENT` | | The pattern a group's and an action's name match: a letter, then letters, digits or underscores |
| `LAMBDER_CALLER_MEMBER_NAMES` | | Every public member of LambderCaller, LambderInvokeCaller and the test visitor, which no group may shadow (their state is `#private`, which no group can reach) |
| `LAMBDER_RESERVED_GROUP_NAMES`, `LAMBDER_RESERVED_ACTION_NAMES` | yes | The names no group and no action may take |

Types: `LambderAppTypes` (what `create()` configured, the instance's one
type parameter), `LambderPlainAppTypes`, `LambderApiDeclaration`,
`LambderApiDeclarations`, `LambderApiGroup`, `LambderLazyApiGroup`,
`LambderRegistrableApiGroup`, `LambderApiModeOf` (an endpoint's mode from
its guards), `LambderEntryOf`, `LambderContractOfGroups`,
`LambderReservedGroupName`, `LambderReservedActionName`, and the readers of a
contract's groups `LambderContractGroupsOf`, `LambderContractNamesInGroup`,
`LambderContractActionOf`.

See [APIs and refusals](./apis.md).

## APIs, the contract and refusals

| Export | Client | Description |
| --- | --- | --- |
| `refuse` | yes | Throw a refusal from anywhere in an API call's stack; its code and data are checked against the endpoint where it is rendered. Inside a handler, `ctx.refuse` takes the same arguments typed to the endpoint's declared codes |
| `LambderApiRefusal` | yes | The refusal class `refuse()` is sugar over |
| `isLambderApiRefusal` | yes | Brand-based detection, safe across duplicate copies of the package |
| `LAMBDER_REFUSAL_CODES` | yes | The codes the framework stamps on its own refusals |
| `isLambderRefusalCode` | yes | Whether a code is one of the framework's own |
| `LambderApiRefusalValidationError` | | The crash a refusal causes when its endpoint may not send it: a code the endpoint does not declare, data on a code that declares none, data its code's schema rejects, `lambder/rate-limited` without its policy and wait, or a declared code under a 422 or 5xx status (`apiName`, `code`, `zodError`; the refusal as thrown is the `cause`). Also from `lambder/mock` |
| `isObjectPayload` | yes | Whether a value is what an API answers with, or a refusal carries as data: an array, or an object JSON writes as an object |
| `refusalMessageOf` | yes | An envelope's refusal as the message object every reader gets: a plain string becomes `{ type: "error", content }` |
| `describeCrash` | yes | Describe a thrown error for the envelope's `crash` field: name, message, stack, cause chain, where it happened |
| `errorFromCrashDetail` | yes | Rebuild an Error (with its cause chain) from a crash detail |
| `apiGuardParam` | yes | The parameter an API's guards option gives a guard, read off the generated `apiOptions` table with the literal the table pins: the value in the map form, `true` for a guard named without one, `undefined` when the API does not declare it |
| `apiGuardParamExportName` | yes | The identifier `writeApiGuardParams` exports an API's parameter under (`orders.list` exports `ordersListGuardParam`), for code that reads a generated module by API name |
| `apisWithGuard` | yes | The names of the APIs in a generated `apiOptions` table whose guards option names a guard, in any of its three forms: the list `LambderApisWithGuard` is the type of, read off the same entries in the table's order |

Types: `LambderApiContractShape`; the envelope, `LambderApiEnvelopeBody` (a
`LambderApiSuccessEnvelope` or a `LambderApiRefusalEnvelope`),
`LambderRefusalEnvelopeFields` (what a refusal envelope carries) and
`LambderApiRefusalConfig` (what `res.apiRefusal` takes);
`LambderApiRefusalOptions`, `LambderRefusalMessage` (generic over an
endpoint's declared codes, one arm per code), `LambderPlainRefusalMessage`
(the framework's codes that carry no data and the uncoded refusal),
`LambderRateLimitRefusalData` (what `lambder/rate-limited` carries: the
policy that refused and the seconds to wait), `LambderUncheckedRefusalMessage` (any
code, the form an app writes), `LambderRefusalCode`, `LambderRefuseOptions`,
`LambderDeclaredRefuse` and `LambderDeclaredRefuseOptions` (`ctx.refuse`
typed to declared codes), `LambderCrashDetail`, `LambderCrashCause`; and the
declared options as data (client too), what `lambder.apiOptionEntries()`
reports and `writeApiOptions` writes: `LambderApiOptionEntries`, its entry
types `LambderApiOptionEntry`, `LambderRateLimitPolicyEntry` and
`LambderGuardDeclarationEntry`, and the readers over a generated table
`LambderApisWithGuard` (the APIs naming a guard), `LambderApisGuardedBy` (the
APIs whose guards option is exactly this), `LambderApisWithMode` and
`LambderGuardParamOf`; and `LambderApiGuardParam`, the type of each export
`writeApiGuardParams` writes: the parameter an API gives a guard, tagged in
types alone with the API's name and the guard's.

See [APIs and refusals](./apis.md).

## Sessions

| Export | Client | Description |
| --- | --- | --- |
| `LambderSessionManager` | | The session model: tokens, expiry, sliding writes, `dataSchema` and `dataRefresh`, regeneration, over a store |
| `LambderSessionController` | | The per-request API: `ctx.sessionController` on every context, server and mock, and `lambder.getSessionController(ctx)` |
| `LambderDdbSessionStore` | | Sessions at rest in DynamoDB, `session.data` Brotli-compressed |
| `LambderMemorySessionStore` | | Sessions in a `Map`, for tests and the mock runtime |
| `LambderWebCrypto` | | The default `LambderSessionCrypto`: sha256 and HMAC-SHA256 through `crypto.subtle` |
| `LambderPlainSessionCrypto` | | The stand-in for a runtime without WebCrypto and a store that holds nothing worth hashing |
| `isWebCryptoAvailable` | | Whether this runtime offers `crypto.subtle` |
| `DEFAULT_SESSION_TOKEN_COOKIE_KEY`, `DEFAULT_SESSION_CSRF_COOKIE_KEY` | yes | The cookie names an app uses unless it configures its own |
| `LambderSessionDataRefreshError` | | The `dataRefresh` callback threw, or returned data `dataSchema` refuses |
| `LambderSessionReadError` | | Reading a session record failed at the store level |
| `LambderSessionNotFoundError` | | No session for this request: the cookies named none, the one they named did not pair with the posted CSRF token, or the session was ended while the request held it (`updateSessionData`, `refreshSessionData`, `regenerateSession`) |
| `LambderSessionAmbiguousError` | | The cookies cannot be resolved to one session, so none is used and every scope this host can write is cleared; a subclass of `LambderSessionNotFoundError`, so a route, a hook or an API call answers it as a missing session |

Types: `LambderSessionOptions`, `LambderSessionStore`, `LambderSessionRecord`
(both generic over the session data), `LambderSessionChanges` and
`LambderSessionUpdateResult` (what a store's `update` takes and answers),
`LambderCreatedSession`,
`LambderSessionDataRefreshConfig`, `LambderSessionDataOptions` (`dataSchema` and `dataRefresh`), `LambderSessionCookieOptions`,
`LambderSessionManagerOptions`, `LambderSessionControllerOptions`,
`LambderSessionRequestInfo`, `LambderSessionCrypto`,
`LambderDdbSessionStoreOptions`.

See [Sessions](./sessions.md).

## Signed claims and one-shot secrets

| Export | Client | Description |
| --- | --- | --- |
| `LambderSignedClaims` | yes | One kind of signed token: `sign(claims)` writes `<version>.<base64url claims>.<base64url HMAC-SHA256>` over the claims a zod schema accepted, `verify(token, { now? })` answers the claims or null for a forged, foreign, malformed, refused or expired token alike; an optional `exp` claim in epoch seconds is judged on every verify |
| `keyedDigest` | yes | HMAC-SHA256 of a value under the app's secret as 43 characters of base64url: how a secret an app stores and looks up by value (a device secret, a code sent by email) rests, so a copied table cannot be attacked offline |
| `randomSecret` | yes | A fresh secret from the cryptographic random source as base64url, 32 bytes unless told otherwise |
| `randomCode` | yes | A code of `length` characters drawn uniformly from an alphabet of 2 to 256 distinct characters, from the same source and without the bias of a plain modulo: what a person types or reads out (a pairing code, the digits in an email) |
| `constantTimeEquals` | yes | Length-aware comparison whose duration says nothing about where two digests differ |
| `LambderPasswordHasher` | | Passwords at rest as argon2id PHC strings through node's `crypto.argon2` (Node 24.7+): `hash(password)`, `verify(stored, password)` for argon2id, argon2i or argon2d strings in any parameter order, `needsRehash(stored)` for a hash written under another variant or cost |
| `LambderOneShotSecrets` | | Codes and tokens an app hands out once and takes back once (a code emailed to an address, an activation link, a pairing code), over a store that settles their races: `issue(kind, scope, { cooldownSeconds?, meta? })`, `redeem(kind, scope, candidate)` for a code, `redeemToken(kind, candidate)` for a token, `retire(scope)` |
| `LambderDdbOneShotSecretStore` | | The secrets as digests in DynamoDB under `OTS#`, sharing the policy table: a code as one item, a token as two written in one transaction |
| `LambderMemoryOneShotSecretStore` | | The same rules in a `Map`, for tests and development |

Types: `LambderSignedClaimsOptions`; `LambderPasswordHasherOptions` (`memoryKib`, `passes`, `parallelism`); `LambderOneShotSecretsOptions`,
`LambderOneShotSecretKind` (a `code` of an alphabet and length with a ceiling
on tries, or a `token` of random bytes or of an alphabet, redeemed by value),
`LambderOneShotIssueResult`,
`LambderOneShotRedeemResult`, `LambderOneShotCodeKindNames`,
`LambderOneShotTokenKindNames`; the store interface `LambderOneShotSecretStore`
and what it holds, `LambderOneShotSecretRecord`, `LambderOneShotSecretDraft`,
`LambderOneShotSecretShape`, `LambderOneShotIssueOutcome`; `LambderDdbOneShotSecretStoreOptions`.

See [Secrets and retries](./secrets.md).

## Declarative policies

| Export | Client | Description |
| --- | --- | --- |
| `lambderGuard` | | Build a named guard: input mode, session requirement, param, return value. `initLambder<SessionData>().guard` is the same builder typed to the app's session |
| `lambderGuardBuilder` | | The guard builder bound to other context types (what the mock runtime's `mock.guard` is) |
| `lambderRateLimitKey` | | Build a custom rate-limit key from a validated payload slice; the handler sees the render context |
| `lambderRateLimitKeyBuilder` | | The same builder bound to another context type; the mock runtime binds it as `rateLimitKey` |
| `rateLimitRefusal`, `DEFAULT_RATE_LIMIT_REFUSAL` | | The 429 refusal a rate limit throws (`rateLimitRefusal(detail, { policy, retryAfterSeconds }, words?)`), and its default words |

Types: guards, `LambderApiGuard`, `LambderGuardBuilder`, `LambderGuardMeta`, `LambderGuardMetaMap`, `LambderGuardRunAt`,
`LambderGuardsOption`, `LambderGuardsOptionValue`, `LambderAllowedGuardNames`,
`LambderGuardNamesInputLacks` (the apiInput guards among some names whose
fields an input does not carry), `LambderParamlessGuardNames`, `LambderGuardDataOf`, `LambderGuardInputsOf`,
`LambderGuardRefusals` (a guard's `refusals` option), `LambderGuardRefusalNamesOf`
(the codes an API's guards add to its own);
declared refusals, `LambderRefusalDeclaration` (one code of the vocabulary) and
`LambderRefusalVocabulary` (all of them in one map),
`LambderRefusalVocabularyOption` (one map or a list of maps, as
declareRefusals() takes them), `LambderMergedRefusalVocabulary` (the one map a
list declares),
`LambderRefusalsOption` and `LambderRefusalsOptionValue` (an API's `refusals`
option, typed and at runtime), `LambderRefusalNamesIn` (the codes a refusals
option names), `LambderHandlerRefusalsOf` (the codes as
`ctx.refuse` takes them), `LambderWireRefusalsOf` (the codes as the
contract records them);
rate limits, `LambderApiRateLimitsConfig`, `LambderApiRateLimitPolicyConfig`,
`LambderRateLimitKeyFn`, `LambderRateLimitKeyBuilder`, `LambderRateLimitPer`,
`LambderRateLimitBudget`, `LambderRateLimitChargeAt`,
`LambderRateLimitOption`, `LambderRateLimitOptionValue`,
`LambderRateLimitOverride`, `LambderRateLimitMessage` (a rate-limit refusal's
words, under the framework's code), `LambderAllowedPolicyNames`,
`LambderPolicyNamesInputLacks` (the apiInput-keyed policies among some names
whose key fields an input does not carry), and for charging a
policy from code, `LambderContextRateLimit`, `LambderContextRateLimitCheck`,
`LambderRateLimitCheckResult`, `LambderChargeablePolicyNames`,
`LambderChargeKeyArgs`; idempotency,
`LambderApiIdempotencyConfig`.

See [API policies](./api-policies.md).

## Stores

Each engine takes its store through an interface; DynamoDB and memory
implementations ship, and an app may bring its own.

| Export | Client | Description |
| --- | --- | --- |
| `LambderDdbCache` | | Compressed JSON cache with a memory layer, fill lease and grouped keys |
| `LambderMemoryCache` | | The same `LambderCache` rules in a bounded map, for tests |
| `LambderStorageBackedCache` | | The same `LambderCache` rules over storage an app supplies (a SQL table, Redis) through `LambderCacheStorage`, which only reads and writes entries |
| `LambderDdbRateLimiter` | | Fixed-window rate limiter in DynamoDB, atomic per window |
| `LambderMemoryRateLimiter` | | The same windows and semantics in a `Map`, with an injectable clock |
| `LambderDdbIdempotencyStore` | | Idempotency claims and replays in DynamoDB, owner-checked, compressed bodies |
| `LambderMemoryIdempotencyStore` | | The same claims and expiry in a `Map` |
| `RATE_LIMIT_WINDOWS` | | The fixed windows a policy may cap, with their lengths |
| `LambderExpiringMap` | | The bounded map every memory store and the memory cache sit on: expiry on read plus an amortized sweep, a ceiling, and `{ evictable }` entries held back from eviction |
| `LambderExpiringMapFullError` | | Thrown by `set()` when the ceiling is reached and every entry is protected from eviction |
| `LambderBackoffTimer` | yes | One pending wait at a time, each retry after a failure waiting longer than the last: `retry(run)` and `wait(signal?)` climb a jittered ladder, `after(ms, run)` waits off it, `retries` counts them since `reset()`, and `cancel()`. What the upload runner waits on between tries at storage. See [Retrying with a backoff](./client.md#retrying-with-a-backoff) |

Types: `LambderBackoffTimerOptions`; the interfaces `LambderRateLimiter`, `LambderIdempotencyStore`,
`LambderCache` (and `LambderSessionStore` above); cache, `LambderCacheKey`,
`LambderCacheSetOptions`, `LambderCacheGetOrSetOptions`, `LambderCacheListOptions`,
`LambderMemoryCacheOptions`, `LambderDdbCacheOptions`,
`LambderStorageBackedCacheOptions`,
`LambderCacheStorage` (what an app implements for it),
`LambderCacheStoredEntry`, `LambderCacheAddress`; rate limiter, `LambderDdbRateLimiterOptions`,
`LambderRateLimitWindow`, `LambderRateLimitPolicy`,
`LambderRateLimitExceeded`, `LambderRateLimitResult`; idempotency,
`LambderDdbIdempotencyStoreOptions`, `LambderIdempotencyBeginResult`,
`LambderIdempotencyDoneRecord`.

See [DynamoDB cache](./ddb-cache.md), [Rate limiter](./ddb-rate-limiter.md),
[Idempotency store](./ddb-idempotency.md).

## Files and hosting

| Export | Client | Description |
| --- | --- | --- |
| `LambderLocalFileSource` | | Read files from a folder |
| `LambderS3FileSource` | | Read files from S3, R2 or any S3-compatible store |
| `LambderHttpFileSource` | | Read files over HTTP(S) from a CDN, a public bucket's domain or any origin serving them by path |
| `LambderFiles` | | The instance's reader over a source: path rule, memory cache, template cache |

Types: `LambderFileSource`, `LambderFile`, `LambderReadFile`,
`LambderFilesOption`, `LambderFileMemoryCacheOption`,
`LambderS3FileSourceOptions`, `LambderHttpFileSourceOptions`,
`LambderPublicFilesOptions`, `LambderIndexHtmlOptions`.

See [Frontend hosting](./frontend-hosting.md).

## Direct uploads

| Export | Client | Description |
| --- | --- | --- |
| `LambderS3UploadBucket` | | An S3 bucket browsers upload files to with presigned POST or PUT tickets, and that the server verifies, reads, writes, copies and deletes through |
| `LambderMemoryUploadBucket` | | The same bucket in memory, answering storage requests the way S3 does, for tests and the mock runtime |
| `LambderUploadFileFactsSchema`, `LambderUploadTicketSchema` | | The zod schemas an app's ticket endpoint declares its input and output with |
| `checkUploadRule` | yes | A rule's verdict on a file's type and size, or null when it may be uploaded |
| `refuseUnacceptedUpload` | | Refuses a ticket for a file the rule does not accept, with the `lambder/upload-*` code; what a bucket of an app's own calls before it signs |
| `LambderUploadRunner` | yes | The browser half: checks the file against the rule, hashes it, asks for a ticket, sends it with progress, retries at storage and at the app's own endpoints, stops on an abort, and has the server confirm it |
| `LambderUploadError` | yes | How an upload failed, as a reason a screen can word, with the failed ticket or confirm call's outcome when that call ended it |

Types: `LambderUploadBucket` (the interface both buckets implement),
`LambderUploadVerdict`, `LambderUploadObjectOptions` (what a stored object
carries: tags, metadata, cache and disposition headers),
`LambderUploadContentDisposition`, `LambderS3UploadBucketOptions`,
`LambderMemoryUploadBucketOptions`, `LambderMemoryUploadObject` (what
`inspectObject` answers); and, the client too, `LambderUploadRule`,
`LambderUploadFileFacts`, `LambderUploadTicket`, `LambderUploadMethod`, `LambderUploadRuleVerdict`,
`LambderUploadRunnerOptions`, `LambderUploadProgress`, `LambderUploadPhase`,
`LambderUploadFailureReason`.

See [Direct uploads](./uploads.md).

## Templating

| Export | Client | Description |
| --- | --- | --- |
| `html` | yes | Tagged template with automatic HTML escaping; throws for an interpolation where escaping cannot protect it (unquoted, in a tag, in `on*`/`style`/`srcdoc`, in script content, at a comment's edge) and checks URL schemes. See [Templating](./templating.md) |
| `xml` | yes | Alias of `html`, for XML documents |
| `raw` | yes | Insert trusted markup verbatim |
| `jsonScript` | yes | Embed JSON safely in a `<script>`: hydration state as `application/json` under an id, or structured data as `application/ld+json` |
| `escapeHtml` | yes | Escape a string |
| `renderHtmlValue` | yes | Render any interpolatable value the tags accept |
| `LambderSafeHtml` | yes | The marker class for already-safe fragments, and the only body `res.html`, `res.xml`, `res.status` and `res.status404` take |
| `LambderTemplatingEngine` | | The comment-only HTML template engine. A data key the template has no slot or condition for throws; its names as a type parameter type the data |

Types: `LambderHtmlValue`, `LambderJsonScriptOptions`, `LambderTemplateData`,
`LambderTemplatingEngineOptions`.

See [Templating](./templating.md).

## Compression

| Export | Client | Description |
| --- | --- | --- |
| `resolveCompressionOption` | yes | Resolve any site's `compression` option to settings or null |
| `LAMBDER_ENCODINGS` | | The encodings responses can negotiate |
| `compressText` | | Brotli or gzip a buffer |
| `restoreBytes` | | Decompress under a bound: `{ declaredBytes }` bounds and verifies the result, `{ maxBytes }` is a ceiling alone for bytes that carry no declared length (a compressed HTTP answer). Returns the bytes, so ones that are not text survive; through zlib on Node and `DecompressionStream` elsewhere |
| `restoreText` | | `restoreBytes` plus the UTF-8 decode: what every text caller uses |
| `LambderCompressionError` | | Thrown when a restore fails |
| `LAMBDER_RESTORE_FAILURES` | | The reasons a restore can fail |
| `compressPayloadGzip` | client only | Gzip a request payload (browser `CompressionStream`) |
| `compressPayloadBrotli` | | Brotli a request payload, the Node caller's counterpart (zlib) |
| `isRequestCompressionAvailable` | client only | Whether the runtime can compress requests |
| `COMPRESSED_PAYLOAD_GZ_FIELD` | yes | The envelope field name (`payloadGz`) |
| `COMPRESSED_PAYLOAD_BR_FIELD` | yes | The Brotli envelope field name (`payloadBr`) |
| `COMPRESSED_PAYLOAD_BYTES_FIELD` | yes | The envelope field name (`payloadBytes`) |
| `DEFAULT_REQUEST_COMPRESSION_SETTINGS` | yes | `{ minBytes: 4096 }` |
| `DEFAULT_MAX_RESTORED_PAYLOAD_BYTES` | | `20_000_000` |

Types: `LambderCompressionOption`, `LambderCompressionSettings`,
`LambderCompressionSettingsBase`, `LambderEncoding`, `LambderRestoreFailure`, `LambderRestoreBound`,
`LambderCompressedGzipPayload`, `LambderCompressedBrotliPayload`,
`LambderRequestCompressionOption`, `LambderRequestCompressionSettings`.

See [Responses](./responses.md#compression) and
[Frontend client](./client.md#compressed-request-payloads).

## Frontend client and transports

| Export | Client | Description |
| --- | --- | --- |
| `LambderCaller` | yes | The typed API caller: `caller.orders.place(input)`, `.outcome(input)`, and `caller.api(name, input)` |
| `createIdempotencyKey`, `createIdempotencyKeyScope` | yes | An unguessable key for one logical operation, and a key scope that moves to a new one once an answer settles the operation; for `LambderCaller` and `LambderInvokeCaller` alike |
| `resolveApiOutcome` | yes | The one mapping from an HTTP answer to an outcome, shared by every caller |
| `apiNameKeyOf`, `lookupApiSignature`, `readApiSignature`, `API_SIGNATURE_HEX_LENGTH` | yes | The generated signature map's keys, and how a caller reads its entry for an endpoint |
| `extensibleEnum` | yes | Marks an enum whose readers tolerate values they were not built with, so its values stay out of the signature wherever it is output |
| `LambderApiSignatureEntry` | no | One endpoint as `lambder.apiSignatureEntries()` reports it: name, key, signature |
| `RELOAD_LOOP_WINDOW_MS` | yes | How long a stale-signature refusal repeated after a reload (the same endpoint, signature and version) counts as a reload loop |
| `compareDottedVersions`, `isDottedVersion` | yes | Dotted version strings compared as numbers, the way the server's version floor reads a caller's version |
| `lambderFetchTransport` | yes | The default transport: one POST over fetch, to the endpoint's path |
| `lambderCookieJarTransport` | yes | Any transport carrying a `LambderCookieJar` the way a browser carries cookies |
| `LambderCookieJar`, `parseSetCookie` | yes | A browser's cookie storage for transports that have no browser, and the reader for one `Set-Cookie` header |
| `buildTransportEnvelope` | yes | The envelope object every transport posts |
| `lambderHandlerTransport` | | A real Lambder handler in this process, called through a browser-shaped event |
| `LambderTransportFailure`, `isLambderTransportFailure` | yes | How a transport names why it could not deliver, instead of leaving the caller to assume the network |

Types: `LambderCallerOptions`, `LambderCallOptions`, `LambderLogListHandler`, `LambderApiOutcome`, `LambderValidationError`,
`LambderCallerEndpoint` (one endpoint on its group), `LambderCallerGroupCalls` (every group of a contract),
`LambderCallerMembers` (the caller without its groups),
`LambderApiFailureReason`, `LambderGuardInputsProvider`,
`LambderProvidedGuardInputs`, `LambderIdempotencyKeyScope`,
`LambderApiTransport`, `LambderApiTransportRequest`, `LambderTransportFailureReason`, `LambderApiHttpAnswer`,
`LambderStoredCookie`, `LambderHandlerTransportOptions`; and the arms of the
outcome union a consumer narrows to, `LambderApiAnswerOutcome` (the answer
outcome an HTTP answer resolves to), `LambderApiSuccessOutcome`,
`LambderApiFailure` (the whole failure side, which the caller's error
handler is handed beside the error), `LambderApiCallFailure`, `LambderApiValidationFailure`,
`LambderApiEnvelopeFailure`.

See [Frontend client](./client.md) and [The API core](./api-core.md#transports).

## The API core

| Export | Client | Description |
| --- | --- | --- |
| `LambderApiPipeline` | | The one pipeline the server and the mock runtime run |
| `readApiEnvelope` | | Read a posted envelope into a `LambderApiRequest`; a body that is not a JSON object is flagged on the request as no envelope, which the pipeline refuses |
| `readApiEnvelopeText` | | The same over a body's text, for an adapter holding nothing parsed: an empty body is an empty envelope, and text that is not JSON is flagged too |
| `apiSignatureOf` | | An endpoint's signature digested from its definition; what `lambder.apiSignatures()` builds the map both sides ship with from |
| `restoreCompressedPayload` | | Restore a `payloadGz` or `payloadBr` pair onto the request |
| `successEnvelope`, `refusalEnvelope`, `plainRefusalEnvelope`, `envelopeAnswer`, `refusalAnswer`, `validationAnswer`, `apiNotFoundAnswer`, `sessionExpiredAnswer`, `versionExpiredAnswer`, `invalidPayloadAnswer`, `crashAnswer` | | The one place the envelope is written and every outcome rendered: a handler's output as the only success, everything else as a refusal |
| `checkedRefusal` | | A thrown refusal as its endpoint may send it (the declared code's data parsed), or a `LambderApiRefusalValidationError`: what the pipeline, a hook refusing an API call and the mock's failure injection all run |
| `LambderAnswerHeaders`, `getAnswerHeader`, `setAnswerHeader`, `addAnswerHeader`, `toHttpAnswer` | | The answer's headers, and the accessor view a caller reads |
| `createApiCallContext` | | A fresh call context |
| `API_ANSWER_CONTENT_TYPE` | | The content type every API answer carries (`application/json; charset=utf-8`) |
| `LambderApiValidationRefusal`, `isLambderApiValidationRefusal` | | Input validation as a typed throw |
| `LambderApiOutputValidationError` | | The crash a handler's returned output causes when its API's output schema does not accept it (`apiName`; `zodError` when the schema rejected the output, null when parsing threw; what was thrown as `cause`); an idempotency key records it as the key's answer |
| `synthesizeLambdaHttpEvent`, `decodeLambdaHttpResult`, `localLambdaContext` | | The Lambda event conversions the invoke caller and the handler transport share. The event is payload format 2.0 unless `eventFormat: "v1"` asks for a REST API's |

Types: `LambderApiRequest`, `LambderApiRequestInfo`, `LambderCompressedPayloadFields`,
`LambderRestorePayloadResult`, `LambderApiAnswer`,
`LambderApiCallContext`, `LambderApiCallTrace`, `LambderResponseTools`,
`LambderApiDefinition`, `LambderApiSignatureMap` (client too),
`LambderApiIdempotencyOption`, `LambderApiPipelineOptions`,
`LambderApiSessionsConfig`, `LambderApiInputRefusal`, `LambderApiRunResult`,
`LambderApiExec`, `LambderValidationAnswerBody`, `LambderApiAllowedRefusal`, `LambderApiAllowedRefusals`,
`LambderEndpointRefusals` (what one endpoint's refusals are checked against),
`LambderSynthesizedRequest`, `LambderLambdaHttpResult`, and the contract
builder the root alone exports, `LambderContractEntry`;
and the contract helpers (client too): `LambderApiMode`,
`LambderGuardNamesIn`, `LambderContractMode`, `LambderContractKeysWithMode`,
`LambderContractKeysWithGuard`, `LambderJsonOf` (a type after JSON: what an
API's output and a refusal's data reach a client as),
`LambderContractRefusalsOf` (the codes one endpoint can refuse with, each to
`{ data }` or `{}`), `LambderContractRefusalMessage` (the message a call to
one endpoint can come back with), `LambderContractRefusals` and
`LambderContractAnyRefusalMessage` (the same across the whole contract),
`LambderContractGuardsOf`, `LambderContractGuardNames`,
`LambderContractGuardInputsOf`, `LambderContractGuardInput`,
`LambderContractGuardInputNames`, `LambderContractRateLimitOf`,
`LambderContractRateLimitNames`, `LambderContractIdempotencyOf`.

See [The API core](./api-core.md).

## Invoking another Lambder app

| Export | Client | Description |
| --- | --- | --- |
| `LambderInvokeCaller` | | Calls a Lambder app running in another lambda through a Lambda invoke, typed from the callee's contract |
| `LambderInvokeError` | | What `api()` throws: the reason, the outcome, the callee's crash, and its error rebuilt as `cause` |
| `isLambderInvokeError` | | Brand-based detection, safe across duplicate copies of the package |
| `LAMBDER_INVOKE_HEADER` | | The marker header name (`x-lambder-invoke`) |
| `LAMBDER_INVOKED_BY_HEADER` | | The header naming the calling function (`x-lambder-invoked-by`) |
| `LAMBDER_PARENT_REQUEST_HEADER` | | The header carrying the calling invocation's request id (`x-lambder-parent-request-id`), which the callee's call summary records as its `parentRequestId` |
| `LAMBDER_INVOKE_PROTOCOL` | | The marker's value (`"1"`) |
| `LAMBDER_INVOKE_MAX_EVENT_BYTES` | | `5_500_000`, the guard applied to the event before it is sent |
| `DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS` | | `{ minBytes: 4096, quality: 5 }` |

Types: `LambderInvokeCallerOptions`, `LambderInvokeCallOptions`,
`LambderInvokeOutcome`, `LambderInvokeFailure` and its arms
`LambderInvokeValidationFailure`, `LambderInvokeCrashFailure`,
`LambderInvokePayloadTooLargeFailure`, `LambderInvokeEnvelopeFailure`,
`LambderInvokeDeliveryFailure`, `LambderInvokeFailureReason`,
`LambderInvokeFunctionError`, `LambderInvokeFailureHandler`, `LambderInvokeCallCheck`, `LambderInvokeLogListHandler`, `LambderInvokeSession`, `LambderInvokeTransport`,
`LambderInvokeTransportResult`, `LambderLambdaHttpResult`,
`LambderInvokeRequestInit`, `LambderInvokeEventInit`, `LambderInvokeEndpoint`,
`LambderInvokeGroupCalls`.

See [Calling a Lambder app from another lambda](./invoke.md).

## Translations

| Export | Client | Description |
| --- | --- | --- |
| `createLambderI18n` | yes | Create the root translation instance |

Types: `LambderI18nConfig`, `LambderI18nInstance`, `LambderI18nTranslator`,
`LambderLanguageMeta`, `LambderI18nExtractParams`, `LambderI18nDictionaryLoader`,
`LambderI18nDictionaryEntry` (what a dictionary holds under one key: a text or
a plural entry), `LambderI18nPluralEntry` (a text's forms by plural category),
`LambderI18nPluralCategory`, `LambderI18nReadonlyInstance` (the reading
members of any instance of one contract, whatever its language set), and the
instance-derived `LambderI18nCodes`, `LambderI18nKeys`,
`LambderI18nTranslatorFor`.

See [Translations](./i18n.md).

## The mock runtime (`lambder/mock`)

| Export | Description |
| --- | --- |
| `initLambderMock` | Fix the contract and session types, then `guard`, `rateLimitKey`, `refuse` and `create(options)`; `declareRefusals(vocabulary, options?)` first binds the server's refusal vocabulary, the same map or list of maps the server's init declares, so every handler's `ctx.refuse` takes a code's data in its input form and the mock parses it as the server does |
| `LambderMockApp` | The runtime: registry, transports, sessions, failure injection, subscription, call log |
| `lambderMockPoliciesFrom` | The server's rate-limit policies as the mock restates them, from the generated `rateLimitPolicies` table plus the key handlers the table cannot hold, required for exactly the custom-keyed policies |
| `lambderMockConsoleLogger` | A ready-made subscriber |
| `lambderMockMswHandler` | One MSW handler for the whole API path, over the runtime |
| `LambderMemoryUploadBucket`, `lambderMockUploadMswHandler` | The storage a mock app's uploads go to, and the MSW handler that answers its storage requests the way S3 does |
| `lambderMockInvokeTransport` | The runtime as a callee of `LambderInvokeCaller` |
| `LambderMockTransportError` | An injected network failure or timeout, as the transport rejects |
| `assertApiSuccess`, `assertApiFailure`, `assertApiRefusal` | The outcome assertions, shared with `lambder/testing`: narrow an `apiOutcome` (a refusal to its declared code and that code's data) and say what it was when it is not what the test expected |
| `LambderCookieJar`, `lambderCookieJarTransport`, `LambderMemorySessionStore`, `LambderMemoryRateLimiter`, `LambderMemoryIdempotencyStore`, `LambderWebCrypto`, `LambderPlainSessionCrypto`, `LambderApiRefusal`, `refuse`, `LAMBDER_REFUSAL_CODES`, `LambderApiRefusalValidationError` | Re-exported for a mock setup's convenience |

Types: `LambderMockAppOptions`, `LambderMockSessionsOptions`,
`LambderMockIdempotencyOptions`, `LambderMockInvalidInputAnswer`, `LambderMockOverride`, `LambderMockTransport`,
`LambderMockTransportOptions`, `LambderMockCallContext`,
`LambderMockSessionCallContext`, `LambderMockContext`, `LambderMockRefusalsOf` (the codes a mock handler may
raise for an endpoint, data in the vocabulary's input form or the contract's wire form), `LambderMockGuards`,
`LambderMockSessionGuardsCheck` (every session endpoint names a mock guard
declared `session: true`), `LambderMockHandler`, `LambderMockEntry`, `LambderMockEntryOptions`,
`LambderMockEntryInput`, `LambderMockNotMockedInput` (what `notMocked` takes:
the reason, and a session endpoint's guards without the `apiOptions` table),
`LambderMockSlice`, `LambderMockRestEntry`,
`LambderMockRegistryCheck`, `LambderMockMissingNames`, `LambderMockStrayNames`,
`LambderMockDuplicateNames`,
`LambderMockLatency`, `LambderMockFailure`, `LambderMockFailureReason`,
`LambderMockOutcome`, `LambderMockCallEvent`, `LambderMockRequestEvent`,
`LambderMockResponseEvent`, `LambderMockCallRecord`, `LambderMockListener`,
`LambderMockRateLimitPolicies`, `LambderMockPolicyKeys`,
`LambderCustomKeyedPolicyNames`, `LambderMockGuardShapeOf` (what a mock guard
standing in for a declared server guard has to look like, from the generated
`guardDeclarations`), `LambderMockInputOf`, `LambderMockOutputOf`,
`LambderApiSchemaEntries`, `LambderApiSchemaEntry` and `LambderJsonSchema`
(the generated schemas module the `apiSchemas` option takes: every API's
input and output as JSON Schema),
`LambderMockConsoleLoggerOptions`, `LambderMswModule`, `LambderMockMswTarget`,
`LambderMemoryUploadBucketOptions`, `LambderMemoryUploadObject`,
and the event and answer shapes the invoke transport reads and returns,
`LambderMockInvokeEvent` and `LambderMockInvokeResult`, declared here so the
entry's type graph reaches neither `aws-lambda` nor the Lambda SDK, with its
options, `LambderMockInvokeTransportOptions`; and
`LambderHttpStatusCode`, the status union a failure injection or a refusal names, and `LambderRefusalStatusCode`, the statuses a declared code may leave with.

The entry also re-exports the types a mock setup names around those values:
`LambderApiTransport`, `LambderApiTransportRequest`, `LambderSessionCrypto`,
`LambderRefusalMessage`, `LambderDeclaredRefuse`, `LambderDeclaredRefuseOptions`, `LambderApiRequest`, `LambderApiAnswer`,
`LambderSessionRecord`, and the return types of the two session members it
hands out, `LambderCreatedSession` and `LambderSessionManager`; and
`LambderExpectedFailure`, what `assertApiFailure` may be told to expect beside
the reason.

See [The mock runtime](./mock.md).

## Testing a real app (`lambder/testing`)

| Export | Description |
| --- | --- |
| `lambderTestApp` | Puts a built Lambder instance under test: memory stores under it in place, memory twins under the caches, one-shot secret stores and upload buckets the app builds itself, mock apps behind its invoke callers, simulated browsers in front of it. Returns a `LambderTestApp` |
| `assertApiSuccess`, `assertApiFailure`, `assertApiRefusal` | Narrow an `apiOutcome` through an `asserts` signature (`assertApiRefusal` to one of the endpoint's declared codes, with its data typed), and throw a plain Error naming what the outcome was. No test runner is imported |
| `LambderMemorySessionStore`, `LambderMemoryRateLimiter`, `LambderMemoryIdempotencyStore`, `LambderMemoryOneShotSecretStore`, `LambderMemoryCache`, `LambderMemoryUploadBucket`, `LambderLocalFileSource`, `LambderCookieJar`, `LAMBDER_REFUSAL_CODES` | Re-exported for a test's convenience: the stores to inspect or hand in, the twins `memoryTwinOf` hands back, a file source over fixtures, a visitor's jar, the codes to assert on |
| `bootLambdaPackage` | Boots an assembled deployment package the way Lambda boots it, in a fresh node process with its imports held to the package (what the runtime supplies, the AWS SDK by default, resolved from an install outside it), and hands its handler API calls or events in turn. Resolves to what each call answered, what the import cost, and the phase that failed; throws for a misconfiguration |
| `lambderSessionStoreConformance`, `lambderIdempotencyStoreConformance`, `lambderRateLimiterConformance`, `lambderOneShotSecretStoreConformance`, `lambderCacheConformance`, `lambderCacheStorageConformance` | The rules each store interface promises, registered as cases with the runner's own `it` and `expect`, for an app to hold a store it writes to the rules Lambder's own stores meet; the last two for a `LambderCache` and for the `LambderCacheStorage` under `LambderStorageBackedCache` |

Types: `LambderTestApp` and `LambderTestVisitor` (the two classes, reached
through `lambderTestApp()` and `visitor()` rather than constructed),
`LambderTestAppOptions`, `LambderTestVisitorOptions`, `LambderTestRequestInit`,
`LambderTestVisitorEndpoint` and `LambderTestVisitorGroupCalls` (a visitor's
endpoints by group: the output, thrown on a failure, and `.outcome`),
`LambderTestedInstance` (an instance as `lambderTestApp` takes it),
`LambderMemoryUploadBucketOptions`, `LambderMemoryUploadObject`,
`LambderExpectedFailure`; the suites' options
(`LambderSessionStoreConformanceOptions`,
`LambderIdempotencyStoreConformanceOptions`,
`LambderRateLimiterConformanceOptions`,
`LambderOneShotSecretStoreConformanceOptions`,
`LambderCacheConformanceOptions`,
`LambderCacheStorageConformanceOptions`) and what they take from the
runner (`LambderConformanceRunner`, `LambderConformanceIt`,
`LambderConformanceExpect`, `LambderConformanceAssertion`,
`LambderConformanceSetup`); what a visitor hands back:
`LambderLambdaHttpResult` from `request()`, `LambderCreatedSession` from
`signIn()`, `LambderApiOutcome` and `LambderApiFailureReason` from
`apiOutcome()`; and the boot's own: `LambderPackageBootOptions`,
`LambderPackageBootCall` (an API call or an event),
`LambderPackageBootResult`, `LambderPackageBootCallResult` (one call's
answer) and `LambderPackageBootMeasurements`.

See [Testing](./testing.md).

## Build (`lambder/build`)

| Export | Description |
| --- | --- |
| `writeApiSignatures` | Writes the signature module both sides ship from the instance a module exports, or checks the one on disk, naming the endpoints that moved, and verifies it against the module loaded in a fresh process |
| `writeApiContract` | Writes the server's contract type as plain types in a module that imports nothing, for a client to compile instead of the server, or checks the one on disk, naming the APIs that moved; a write is verified against the contract, entry by entry, before the file is touched |
| `writeApiOptions` | Writes the declared options of every API, every rate-limit policy less its key handler and every guard's input mode and refusal codes as three `as const` tables of plain data (`apiOptions`, `rateLimitPolicies`, `guardDeclarations`), from the instance a module exports, or checks the one on disk, naming what moved per table. See [the options as a generated file](./apis.md#the-options-as-a-generated-file) |
| `writeApiGuardParams` | Writes one guard's parameters as one export per API that declares it (`orders.list` exports `ordersListGuardParam`), each typed `LambderApiGuardParam`, and nothing else about any API: a browser gating on the guard imports the ones its screens use, and its bundle carries those alone. See [one guard's parameters, for a browser](./apis.md#one-guards-parameters-for-a-browser) |
| `writeApiSchemas` | Writes every API's input schema (its input form) and output schema (its output form) as JSON Schema in one `as const` table of plain data (`apiSchemas`) that imports nothing, for the mock to validate its calls against in development, or checks the one on disk, naming the APIs that moved and listing every refinement, transform, pipe and computed default the file cannot carry; a schema JSON Schema cannot represent throws. See [the schemas, for the mock](./apis.md#the-schemas-for-the-mock) |
| `generateApiFiles` | Writes, or with `check` verifies, every file a script names for each of its apps (the contract, the signatures, the options, the guard parameters, the schemas), in one call that names everything stale or broken, each contract printed in a Node process of its own with a heap sized for the compiler. See [Generating every file at once](./apis.md#generating-every-file-at-once) |
| `checkApiRefusals` | Reads a project through the compiler and holds every refusal a handler can reach (an endpoint's, a guard's, a mock entry's, through any helper it calls) to the codes it may send, naming each code it may not send, each declared code nothing reaches, each refusal with no code, each handler it cannot follow and each handler handed no typed refuse, and failing a project in which it finds none to check. See [Checking what a handler can reach](./apis.md#checking-what-a-handler-can-reach) |

Types: `LambderApiSignatureSource` (what it reads: anything with
`apiSignatureEntries()`), `LambderApiSignatureFileOptions`,
`LambderApiSignatureFileResult`, `LambderApiContractFileOptions`,
`LambderApiContractFileResult`, `LambderModuleLocation` (how both take the
module that exports the instance),
`LambderApiOptionsSource`, `LambderApiOptionsFileOptions`,
`LambderApiOptionsFileResult`, `LambderApiGuardParamsFileOptions`,
`LambderApiGuardParamsFileResult`, `LambderNameChanges`,
`LambderApiSchemasSource` (what `writeApiSchemas` reads: anything with
`apiSchemaEntries()`), `LambderApiSchemasFileOptions`,
`LambderApiSchemasFileResult`, `LambderApiSchemaLoss` (one place a schema
does what the file cannot carry), and what
`generateApiFiles` takes and answers: `LambderApiFilesConfig`,
`LambderApiFilesApp` (one app's module and files), `LambderApiFilesOptions`
(`check`, and `contractHeapMegabytes`, the heap of a contract's process),
`LambderApiFilesResult`,
and what `checkApiRefusals` takes and answers:
`LambderApiRefusalCheckOptions`, `LambderApiRefusalCheckResult`,
`LambderRefusalCheckFinding`.

See [APIs](./apis.md#signatures-when-a-client-must-update) and
[the contract as a generated file](./apis.md#the-contract-as-a-generated-file).

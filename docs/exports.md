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
  signature file, the declared options as data, and the generated contract.
  Node-only, and reached by nothing else in the package.

The **Client** column marks what `lambder/client` also exports; `client only`
marks the two names it exports that the root entry does not.

## The framework

| Export | Client | Description |
| --- | --- | --- |
| `initLambder` | | Curried creator: fix the session data type, then `create(options)`, `guard(...)` and `rateLimitKey(...)` typed to it. The canonical entry. See [Configuration](./configuration.md) |
| `Lambder` (default) | | The class itself. Use `initLambder` instead; a direct `new` widens the inferred policy types |
| `LambderResolver` | | The `res` object routes, hooks and fallback handlers receive: the response builder plus `res.die.*`, which throws what it builds |
| `LambderResponseBuilder` | | The response builder a resolver extends and a global error handler receives; reachable via `lambder.getResponseBuilder(ctx?)` |
| `createContext` | | Build a render context from a raw Lambda event, given `{ apiPath?, trustedClientIpHeaders?, trustedHostHeaders? }` (`LambderContextOptions`, optional; `apiPath` defaults to `"/api"` as at `create()`) |
| `isV2HttpEvent` | | Whether an event uses payload format v2 |

Types: `LambderCreateOptions`, `LambderHandler`, `LambderRenderContext`, `LambderContextOptions`,
`LambderSessionRenderContext`, `LambderHttpEvent`, `LambderHttpEventFormat`,
`LambderActionTools`, `LambderCorsConfig`, and the `crashes` option's
`LambderCrashOptions`, `LambderCrashReporter`, `LambderCrashSite`.

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
| `finalizeResponse` | | Apply compression, ETag and the size guard to a response |
| `serializeCookie` | | Build a Set-Cookie header value |
| `serializeClearCookie` | | Build a Set-Cookie header value that deletes a cookie |
| `resolveCookieDomain` | | Resolve a string-or-function cookie domain against a hostname |

Types: `LambderHttpResponse`, `LambderRawResponseInit`,
`LambderResponseOptions`, `LambderFinalizeOptions`, `LambderHeadersInput`,
`LambderHttpStatusCode` (client and mock too), `LambderCookieOptions`, `LambderClearCookieOptions`,
`LambderCookieDomain`, `LambderResponseCompressionOption`,
`LambderResponseCompressionSettings`.

See [Responses](./responses.md).

## APIs, the contract and refusals

| Export | Client | Description |
| --- | --- | --- |
| `refuse` | yes | Throw a typed refusal from anywhere in an API call's stack |
| `LambderApiRefusal` | yes | The refusal class `refuse()` is sugar over |
| `isLambderApiRefusal` | yes | Brand-based detection, safe across duplicate copies of the package |
| `LAMBDER_REFUSAL_CODES` | yes | The codes the framework stamps on its own refusals |
| `refusalMessageOf` | yes | An envelope's errorMessage as the message object every reader gets: a plain string becomes `{ type: "error", content }` |
| `describeCrash` | yes | Describe a thrown error for the envelope's `crash` field: name, message, stack, cause chain, where it happened |
| `errorFromCrashDetail` | yes | Rebuild an Error (with its cause chain) from a crash detail |
| `apiGuardParam` | yes | The parameter an API's guards option gives a guard, read off the generated `apiOptions` table with the literal the table pins: the value in the map form, `true` for a guard named without one, `undefined` when the API does not declare it |

Types: `LambderApiContractShape`, `LambderApiEnvelopeBody`, `LambderApiResponseConfig`,
`LambderApiRefusalOptions`, `LambderRefusalMessage` (generic over an app's own
codes), `LambderAppRefusalMessage`, `LambderRefusalCode`,
`LambderRefuseOptions`, `LambderCrashDetail`, `LambderCrashCause`; and the
declared options as data (client too), what `lambder.apiOptionEntries()`
reports and `writeApiOptions` writes: `LambderApiOptionEntries`, its entry
types `LambderApiOptionEntry`, `LambderRateLimitPolicyEntry` and
`LambderGuardDeclarationEntry`, and the readers over a generated table
`LambderApisWithGuard` (the APIs naming a guard), `LambderApisGuardedBy` (the
APIs whose guards option is exactly this), `LambderApisWithMode` and
`LambderGuardParamOf`.

See [APIs and refusals](./apis.md).

## Sessions

| Export | Client | Description |
| --- | --- | --- |
| `LambderSessionManager` | | The session model: tokens, expiry, sliding writes, `dataRefresh`, regeneration, over a store |
| `LambderSessionController` | | The per-request API: `ctx.sessionController` on every context, server and mock, and `lambder.getSessionController(ctx)` |
| `LambderDdbSessionStore` | | Sessions at rest in DynamoDB, `session.data` Brotli-compressed |
| `LambderMemorySessionStore` | | Sessions in a `Map`, for tests and the mock runtime |
| `LambderWebCrypto` | | The default `LambderSessionCrypto`: sha256 and HMAC-SHA256 through `crypto.subtle` |
| `LambderPlainSessionCrypto` | | The stand-in for a runtime without WebCrypto and a store that holds nothing worth hashing |
| `isWebCryptoAvailable` | | Whether this runtime offers `crypto.subtle` |
| `DEFAULT_SESSION_TOKEN_COOKIE_KEY`, `DEFAULT_SESSION_CSRF_COOKIE_KEY` | yes | The cookie names an app uses unless it configures its own |
| `LambderSessionDataRefreshError` | | The `dataRefresh` callback threw |
| `LambderSessionReadError` | | Reading a session record failed at the store level |
| `LambderSessionNotFoundError` | | No session for this request: the cookies named none, the one they named did not pair with the posted CSRF token, or the session was ended while the request held it (`updateSessionData`, `refreshSessionData`, `regenerateSession`) |
| `LambderSessionAmbiguousError` | | The cookies cannot be resolved to one session, so none is used and every scope this host can write is cleared; a subclass of `LambderSessionNotFoundError`, so a route, a hook or an API call answers it as a missing session |

Types: `LambderSessionOptions`, `LambderSessionStore`, `LambderSessionRecord`
(both generic over the session data), `LambderSessionChanges` and
`LambderSessionUpdateResult` (what a store's `update` takes and answers),
`LambderCreatedSession`,
`LambderSessionDataRefreshConfig`, `LambderSessionCookieOptions`,
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
| `constantTimeEquals` | yes | Length-aware comparison whose duration says nothing about where two digests differ |

| `LambderOneShotSecrets` | | Codes and tokens an app hands out once and takes back once (a code emailed to an address, an activation link, a pairing code), over a store that settles their races: `issue(kind, scope, { cooldownSeconds?, meta? })`, `redeem(kind, scope, candidate)` for a code, `redeemToken(kind, candidate)` for a token, `retire(scope)` |
| `LambderDdbOneShotSecretStore` | | The secrets as digests in DynamoDB under `OTS#`, sharing the policy table: a code as one item, a token as two written in one transaction |
| `LambderMemoryOneShotSecretStore` | | The same rules in a `Map`, for tests and development |

Types: `LambderSignedClaimsOptions`; `LambderOneShotSecretsOptions`,
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
| `rateLimitRefusal`, `DEFAULT_RATE_LIMIT_REFUSAL` | | The 429 refusal a rate limit throws, and its default message |

Types: guards, `LambderApiGuard`, `LambderGuardBuilder`, `LambderGuardMeta`, `LambderGuardMetaMap`, `LambderGuardRunAt`,
`LambderGuardsOption`, `LambderGuardsOptionValue`, `LambderAllowedGuardNames`,
`LambderParamlessGuardNames`, `LambderGuardDataOf`, `LambderGuardInputsOf`;
rate limits, `LambderApiRateLimitsConfig`, `LambderApiRateLimitPolicyConfig`,
`LambderRateLimitKeyFn`, `LambderRateLimitKeyBuilder`, `LambderRateLimitPer`,
`LambderRateLimitBudget`, `LambderRateLimitChargeAt`,
`LambderRateLimitOption`, `LambderRateLimitOptionValue`,
`LambderRateLimitOverride`, `LambderAllowedPolicyNames`, and for charging a
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
| `LambderDdbRateLimiter` | | Fixed-window rate limiter in DynamoDB, atomic per window |
| `LambderMemoryRateLimiter` | | The same windows and semantics in a `Map`, with an injectable clock |
| `LambderDdbIdempotencyStore` | | Idempotency claims and replays in DynamoDB, owner-checked, compressed bodies |
| `LambderMemoryIdempotencyStore` | | The same claims and expiry in a `Map` |
| `RATE_LIMIT_WINDOWS` | | The fixed windows a policy may cap, with their lengths |
| `LambderExpiringMap` | | The bounded map every memory store and the memory cache sit on: expiry on read plus an amortized sweep, a ceiling, and `{ evictable }` entries held back from eviction |
| `LambderExpiringMapFullError` | | Thrown by `set()` when the ceiling is reached and every entry is protected from eviction |
| `LambderBackoffTimer` | yes | One pending wait at a time, each retry after a failure waiting longer than the last: `retry(run)` and `wait(signal?)` climb a jittered ladder, `after(ms, run)` waits off it, `reset()` and `cancel()`. What the upload runner waits on between tries at storage. See [Secrets and retries](./secrets.md#retrying-with-a-backoff) |

Types: `LambderBackoffTimerOptions`; the interfaces `LambderRateLimiter`, `LambderIdempotencyStore`,
`LambderCache` (and `LambderSessionStore` above); cache, `LambderCacheKey`,
`LambderCacheSetOptions`, `LambderCacheListOptions`,
`LambderMemoryCacheOptions`, `LambderDdbCacheOptions`,
`LambderDdbCacheGetOrSetOptions`; rate limiter, `LambderDdbRateLimiterOptions`,
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
| `LambderUploadRunner` | yes | The browser half: checks the file against the rule, hashes it, asks for a ticket, sends it with progress, retries and cancellation, and has the server confirm it |
| `LambderUploadError` | yes | How an upload failed, as a reason a screen can word |

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
| `jsonScript` | yes | Embed JSON safely for client hydration |
| `escapeHtml` | yes | Escape a string |
| `renderHtmlValue` | yes | Render any interpolatable value the tags accept |
| `LambderSafeHtml` | yes | The marker class for already-safe fragments |
| `LambderTemplatingEngine` | | The comment-only HTML template engine |

Types: `LambderHtmlValue`, `LambderTemplateData`,
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
| `LambderCaller` | yes | The typed API caller |
| `createIdempotencyKey`, `createIdempotencyKeyScope` | yes | An unguessable key for one logical operation, and a key scope that moves to a new one once an answer settles the operation; for `LambderCaller` and `LambderInvokeCaller` alike |
| `resolveApiOutcome` | yes | The one mapping from an HTTP answer to an outcome, shared by every caller |
| `apiNameKeyOf`, `lookupApiSignature`, `readApiSignature`, `API_SIGNATURE_HEX_LENGTH` | yes | The generated signature map's keys, and how a caller reads its entry for an endpoint |
| `extensibleEnum` | yes | Marks an enum whose readers tolerate values they were not built with, so its values stay out of the signature wherever it is output |
| `LambderApiSignatureEntry` | no | One endpoint as `lambder.apiSignatureEntries()` reports it: name, key, signature |
| `RELOAD_LOOP_WINDOW_MS` | yes | How long a stale-signature refusal repeated after a reload (the same endpoint, signature and version) counts as a reload loop |
| `compareDottedVersions`, `isDottedVersion` | yes | Dotted version strings compared as numbers, the way the server's version floor reads a caller's version |
| `lambderFetchTransport` | yes | The default transport: one POST over fetch |
| `lambderCookieJarTransport` | yes | Any transport carrying a `LambderCookieJar` the way a browser carries cookies |
| `LambderCookieJar`, `parseSetCookie` | yes | A browser's cookie storage for transports that have no browser, and the reader for one `Set-Cookie` header |
| `buildTransportEnvelope` | yes | The envelope object every transport posts |
| `lambderHandlerTransport` | | A real Lambder handler in this process, called through a browser-shaped event |
| `LambderTransportFailure`, `isLambderTransportFailure` | yes | How a transport names why it could not deliver, instead of leaving the caller to assume the network |

Types: `LambderCallerOptions`, `LambderCallOptions`, `LambderLogListHandler`, `LambderApiOutcome`, `LambderValidationError`,
`LambderApiFailureReason`, `LambderGuardInputsProvider`,
`LambderProvidedGuardInputs`, `LambderIdempotencyKeyScope`,
`LambderApiTransport`, `LambderApiTransportRequest`, `LambderTransportFailureReason`, `LambderApiHttpAnswer`,
`LambderStoredCookie`, `LambderHandlerTransportOptions`; and the arms of the
outcome union a consumer narrows to, `LambderApiAnswerOutcome` (the answer
outcome an HTTP answer resolves to), `LambderApiSuccessOutcome`,
`LambderApiCallFailure`, `LambderApiValidationFailure`,
`LambderApiEnvelopeFailure`.

See [Frontend client](./client.md) and [The API core](./api-core.md#transports).

## The API core

| Export | Client | Description |
| --- | --- | --- |
| `LambderApiPipeline` | | The one pipeline the server and the mock runtime run |
| `readApiEnvelope` | | Read a posted envelope into a `LambderApiRequest` |
| `apiSignatureOf` | | An endpoint's signature digested from its definition; what `lambder.apiSignatures()` builds the map both sides ship with from |
| `restoreCompressedPayload` | | Restore a `payloadGz` or `payloadBr` pair onto the request |
| `buildApiEnvelope`, `envelopeAnswer`, `refusalAnswer`, `validationAnswer`, `apiNotFoundAnswer`, `sessionExpiredAnswer`, `versionExpiredAnswer`, `invalidPayloadAnswer`, `crashAnswer` | | The one place the envelope is written and every outcome rendered |
| `LambderAnswerHeaders`, `getAnswerHeader`, `setAnswerHeader`, `addAnswerHeader`, `toHttpAnswer` | | The answer's headers, and the accessor view a caller reads |
| `createApiCallContext` | | A fresh call context |
| `API_ANSWER_CONTENT_TYPE` | | The content type every API answer carries (`application/json; charset=utf-8`) |
| `LambderApiValidationRefusal`, `isLambderApiValidationRefusal` | | Input validation as a typed throw |
| `LambderApiOutputValidationError` | | The crash a handler's returned output causes when its API's output schema does not accept it (`apiName`; `zodError` when the schema rejected the output, null when parsing threw; what was thrown as `cause`); an idempotency key records it as the key's answer |
| `answerFromResponse`, `responseFromAnswer` | | The server adapter's conversions between a `LambderResponse` and an answer |
| `synthesizeLambdaHttpEvent`, `decodeLambdaHttpResult`, `localLambdaContext` | | The Lambda event conversions the invoke caller and the handler transport share. The event is payload format 2.0 unless `eventFormat: "v1"` asks for a REST API's |

Types: `LambderApiRequest`, `LambderApiRequestInfo`, `LambderCompressedPayloadFields`,
`LambderRestorePayloadResult`, `LambderApiAnswer`,
`LambderApiCallContext`, `LambderApiCallTrace`, `LambderResponseTools`,
`LambderApiDefinition`, `LambderApiSignatureMap` (client too),
`LambderApiIdempotencyOption`, `LambderApiPipelineOptions`,
`LambderApiSessionsConfig`, `LambderApiInputRefusal`, `LambderApiRunResult`,
`LambderApiExec`, `LambderApiEnvelopeConfig`, `LambderValidationAnswerBody`,
`LambderSynthesizedRequest`, `LambderLambdaHttpResult`, and the two contract
builders the root alone exports, `LambderContractEntry` and
`LambderMergeContract`;
and the contract helpers (client too): `LambderApiMode`,
`LambderGuardNamesIn`, `LambderContractMode`, `LambderContractKeysWithMode`,
`LambderContractKeysWithGuard`, `LambderJsonOf` (a type after JSON: what an
API's output reaches a client as), `LambderJsonOutputOf` (the same at the top
of an output, where `void` and `undefined` stay as they are),
`LambderContractGuardsOf`, `LambderContractGuardNames`,
`LambderContractGuardInputsOf`, `LambderContractGuardInput`,
`LambderContractGuardInputNames`, `LambderContractRateLimitOf`,
`LambderContractRateLimitNames`, `LambderContractIdempotencyOf`.

See [The API core](./api-core.md).

## Invoking another Lambder app

| Export | Client | Description |
| --- | --- | --- |
| `LambderInvokeCaller` | | Calls a Lambder app running in another lambda directly, typed from the callee's contract |
| `LambderInvokeError` | | What `api()` throws: the reason, the outcome, the callee's crash, and its error rebuilt as `cause` |
| `isLambderInvokeError` | | Brand-based detection, safe across duplicate copies of the package |
| `LAMBDER_INVOKE_HEADER` | | The marker header name (`x-lambder-invoke`) |
| `LAMBDER_INVOKED_BY_HEADER` | | The header naming the calling function (`x-lambder-invoked-by`) |
| `LAMBDER_INVOKE_PROTOCOL` | | The marker's value (`"1"`) |
| `LAMBDER_INVOKE_MAX_EVENT_BYTES` | | `5_500_000`, the guard applied to the event before it is sent |
| `DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS` | | `{ minBytes: 4096, quality: 5 }` |

Types: `LambderInvokeCallerOptions`, `LambderInvokeCallOptions`,
`LambderInvokeOutcome`, `LambderInvokeFailure` and its arms
`LambderInvokeValidationFailure`, `LambderInvokeCrashFailure`,
`LambderInvokePayloadTooLargeFailure`, `LambderInvokeEnvelopeFailure`,
`LambderInvokeDeliveryFailure`, `LambderInvokeFailureReason`,
`LambderInvokeFunctionError`, `LambderInvokeFailureHandler`, `LambderInvokeLogListHandler`, `LambderInvokeSession`, `LambderInvokeTransport`,
`LambderInvokeTransportResult`, `LambderLambdaHttpResult`,
`LambderInvokeRequestInit`, `LambderInvokeEventInit`.

See [Calling a Lambder app from another lambda](./invoke.md).

## Translations

| Export | Client | Description |
| --- | --- | --- |
| `createLambderI18n` | yes | Create the root translation instance |

Types: `LambderI18nConfig`, `LambderI18nInstance`, `LambderI18nTranslator`,
`LambderLanguageMeta`, `LambderI18nExtractParams`, `LambderI18nDictionaryLoader`,
and the instance-derived
`LambderI18nCodes`, `LambderI18nKeys`, `LambderI18nTranslatorFor`.

See [Translations](./i18n.md).

## The mock runtime (`lambder/mock`)

| Export | Description |
| --- | --- |
| `initLambderMock` | Fix the contract and session types, then `guard` and `create(options)` |
| `LambderMockApp` | The runtime: registry, transports, sessions, failure injection, subscription, call log |
| `lambderMockPoliciesFrom` | The server's rate-limit policies as the mock restates them, from the generated `rateLimitPolicies` table plus the key handlers the table cannot hold, required for exactly the custom-keyed policies |
| `lambderMockConsoleLogger` | A ready-made subscriber |
| `lambderMockMswHandler` | One MSW handler for the whole API path, over the runtime |
| `LambderMemoryUploadBucket`, `lambderMockUploadMswHandler` | The storage a mock app's uploads go to, and the MSW handler that answers its storage requests the way S3 does |
| `lambderMockInvokeTransport` | The runtime as a callee of `LambderInvokeCaller` |
| `LambderMockTransportError` | An injected network failure or timeout, as the transport rejects |
| `assertApiSuccess`, `assertApiFailure` | The outcome assertions, shared with `lambder/testing`: narrow an `apiOutcome` and say what it was when it is not what the test expected |
| `LambderCookieJar`, `lambderCookieJarTransport`, `LambderMemorySessionStore`, `LambderMemoryRateLimiter`, `LambderMemoryIdempotencyStore`, `LambderWebCrypto`, `LambderPlainSessionCrypto`, `LambderApiRefusal`, `refuse`, `LAMBDER_REFUSAL_CODES` | Re-exported for a mock setup's convenience |

Types: `LambderMockAppOptions`, `LambderMockSessionsOptions`,
`LambderMockIdempotencyOptions`, `LambderMockInvalidInputAnswer`, `LambderMockOverride`, `LambderMockTransport`,
`LambderMockTransportOptions`, `LambderMockCallContext`,
`LambderMockSessionCallContext`, `LambderMockContext`, `LambderMockGuards`,
`LambderMockHandler`, `LambderMockEntry`, `LambderMockEntryOptions`,
`LambderMockEntryInput`, `LambderMockSlice`, `LambderMockRestEntry`,
`LambderMockRegistryCheck`, `LambderMockMissingNames`, `LambderMockStrayNames`,
`LambderMockDuplicateNames`, `LambderMockPublicNames`, `LambderMockSessionNames`,
`LambderMockLatency`, `LambderMockFailure`, `LambderMockFailureReason`,
`LambderMockOutcome`, `LambderMockCallEvent`, `LambderMockRequestEvent`,
`LambderMockResponseEvent`, `LambderMockCallRecord`, `LambderMockListener`,
`LambderMockRateLimitPolicies`, `LambderMockPolicyKeys`,
`LambderCustomKeyedPolicyNames`, `LambderMockGuardShapeOf` (what a mock guard
standing in for a declared server guard has to look like, from the generated
`guardDeclarations`), `LambderMockInputOf`, `LambderMockOutputOf`,
`LambderMockConsoleLoggerOptions`, `LambderMswModule`, `LambderMockMswTarget`,
`LambderMemoryUploadBucketOptions`, `LambderMemoryUploadObject`,
and the event and answer shapes the invoke transport reads and returns,
`LambderMockInvokeEvent` and `LambderMockInvokeResult`, declared here so the
entry's type graph reaches neither `aws-lambda` nor the Lambda SDK; and
`LambderHttpStatusCode`, the status union a failure injection or a refusal names.

The entry also re-exports the types a mock setup names around those values:
`LambderApiTransport`, `LambderApiTransportRequest`, `LambderSessionCrypto`,
`LambderRefusalMessage`, `LambderApiRequest`, `LambderApiAnswer`,
`LambderSessionRecord`, and the return types of the two session members it
hands out, `LambderCreatedSession` and `LambderSessionManager`; and
`LambderExpectedFailure`, what `assertApiFailure` may be told to expect beside
the reason.

See [The mock runtime](./mock.md).

## Testing a real app (`lambder/testing`)

| Export | Description |
| --- | --- |
| `lambderTestApp` | Puts a built Lambder instance under test: memory stores under it in place, simulated browsers in front of it. Returns a `LambderTestApp` |
| `assertApiSuccess`, `assertApiFailure` | Narrow an `apiOutcome` through an `asserts` signature, and throw a plain Error naming what the outcome was. No test runner is imported |
| `LambderMemorySessionStore`, `LambderMemoryRateLimiter`, `LambderMemoryIdempotencyStore`, `LambderMemoryOneShotSecretStore`, `LambderMemoryCache`, `LambderMemoryUploadBucket`, `LambderLocalFileSource`, `LambderCookieJar`, `LAMBDER_REFUSAL_CODES` | Re-exported for a test's convenience: the stores to inspect or hand in, the cache to swap an app's own for, an upload bucket to put under an app's uploads, a file source over fixtures, a visitor's jar, the codes to assert on |
| `lambderSessionStoreConformance`, `lambderIdempotencyStoreConformance`, `lambderRateLimiterConformance`, `lambderOneShotSecretStoreConformance` | The rules each store interface promises, registered as cases with the runner's own `it` and `expect`, for an app to hold a store it writes to the rules Lambder's own stores meet |

Types: `LambderTestApp` and `LambderTestVisitor` (the two classes, reached
through `lambderTestApp()` and `visitor()` rather than constructed),
`LambderTestAppOptions`, `LambderTestVisitorOptions`, `LambderTestRequestInit`,
`LambderTestedInstance` (an instance as `lambderTestApp` takes it),
`LambderMemoryUploadBucketOptions`, `LambderMemoryUploadObject`,
`LambderExpectedFailure`; the suites' options
(`LambderSessionStoreConformanceOptions`,
`LambderIdempotencyStoreConformanceOptions`,
`LambderRateLimiterConformanceOptions`,
`LambderOneShotSecretStoreConformanceOptions`) and what they take from the
runner (`LambderConformanceRunner`, `LambderConformanceIt`,
`LambderConformanceExpect`, `LambderConformanceAssertion`,
`LambderConformanceSetup`); and what a visitor hands back:
`LambderLambdaHttpResult` from `request()`, `LambderCreatedSession` from
`signIn()`, `LambderApiOutcome` and `LambderApiFailureReason` from
`apiOutcome()`.

See [Testing](./testing.md).

## Build (`lambder/build`)

| Export | Description |
| --- | --- |
| `writeApiSignatures` | Writes the signature module both sides ship from the instance a module exports, or checks the one on disk, naming the endpoints that moved, and verifies it against the module loaded in a fresh process |
| `writeApiContract` | Writes the server's contract type as plain types in a module that imports nothing, for a client to compile instead of the server, or checks the one on disk, naming the APIs that moved; a write is verified against the contract, entry by entry, before the file is touched |
| `writeApiOptions` | Writes the declared options of every API, every rate-limit policy less its key handler and every guard's input mode as three `as const` tables of plain data (`apiOptions`, `rateLimitPolicies`, `guardDeclarations`), from the instance a module exports, or checks the one on disk, naming what moved per table. See [the options as a generated file](./apis.md#the-options-as-a-generated-file) |
| `writeApiGuardParams` | Writes one guard's parameters as an `as const` table (`guardParams`) of the APIs that declare it and what each gives it, and nothing else about any API: the least a browser gating on the guard needs. See [one guard's parameters, for a browser](./apis.md#one-guards-parameters-for-a-browser) |

Types: `LambderApiSignatureSource` (what it reads: anything with
`apiSignatureEntries()`), `LambderApiSignatureFileOptions`,
`LambderApiSignatureFileResult`, `LambderApiContractFileOptions`,
`LambderApiContractFileResult`, `LambderModuleLocation` (how both take the
module that exports the instance),
`LambderApiOptionsSource`, `LambderApiOptionsFileOptions`,
`LambderApiOptionsFileResult`, `LambderApiGuardParamsFileOptions`,
`LambderApiGuardParamsFileResult`, `LambderNameChanges`.

See [APIs](./apis.md#signatures-when-a-client-must-update) and
[the contract as a generated file](./apis.md#the-contract-as-a-generated-file).

# Exports reference

Every name the three entry points export, grouped by what it is for. Anything
not listed here is internal and may change without a major version.

- `lambder` is the server surface: 49 values and 102 types.
- `lambder/client` is the browser-safe subset: 20 values and 28 types, all of
  them also exported from `lambder`.
- `lambder/testing` carries the MSW adapter.

The **Client** column marks what `lambder/client` also exports.

## The framework

| Export | Client | Description |
| --- | --- | --- |
| `initLambder` | | Curried creator: fix the session data type, then `create(options)`. The canonical entry. See [Configuration](./configuration.md) |
| `Lambder` (default) | | The class itself. Use `initLambder` instead; a direct `new` widens the inferred policy types |
| `LambderResolver` | | The `res` object handlers receive |
| `LambderResponseBuilder` | | Builds resolvers; reachable via `lambder.getResponseBuilder(ctx?)` |
| `createContext` | | Build a render context from a raw Lambda event |
| `isV2HttpEvent` | | Whether an event uses payload format v2 |

Types: `LambderCreateOptions`, `LambderHandler`, `LambderRenderContext`,
`LambderSessionRenderContext`, `LambderHttpEvent`, `LambderHttpEventFormat`,
`LambderActionTools`, `LambderCorsConfig`.

## Routing

| Export | Client | Description |
| --- | --- | --- |
| (registration methods only) | | `addRoute`, `addSessionRoute`, `addAction`, `addHook` and the `set*Handler` methods live on the instance. See [Routing](./routing.md) |

Types: `LambderRouteMatcher`, `RouteCondition`, `ConditionFunction`,
`PathParamsOf`.

## Responses and cookies

| Export | Client | Description |
| --- | --- | --- |
| `LambderResponse` | | The response object the pipeline finalizes |
| `finalizeResponse` | | Apply compression, ETag and the size guard to a response |
| `acceptsEncoding` | | Whether a request's `Accept-Encoding` allows an encoding |
| `serializeCookie` | | Build a Set-Cookie header value |
| `serializeClearCookie` | | Build a Set-Cookie header value that deletes a cookie |
| `resolveCookieDomain` | | Resolve a string-or-function cookie domain against a hostname |

Types: `LambderHttpResponse`, `LambderRawResponseInit`,
`LambderResponseOptions`, `LambderFinalizeOptions`, `LambderHeadersInput`,
`HttpStatusCode`, `LambderCookieOptions`, `LambderClearCookieOptions`,
`LambderCookieDomain`, `LambderResponseCompressionOption`,
`LambderResponseCompressionSettings`.

See [Responses](./responses.md).

## APIs, the contract and refusals

| Export | Client | Description |
| --- | --- | --- |
| `refuse` | yes | Throw a typed refusal from anywhere in an API call's stack |
| `LambderApiError` | yes | The refusal class `refuse()` is sugar over |
| `isLambderApiError` | yes | Brand-based detection, safe across duplicate copies of the package |
| `LAMBDER_REFUSAL_CODES` | yes | The codes the framework stamps on its own refusals |

Types: `ApiContractShape`, `LambderApiResponse`, `LambderApiResponseConfig`,
`LambderApiErrorOptions`, `LambderRefusalMessage`, `LambderRefusalCode`,
`LambderRefuseOptions`.

See [APIs and refusals](./apis.md).

## Sessions

| Export | Client | Description |
| --- | --- | --- |
| `LambderSessionManager` | | The record-level session store |
| `LambderSessionController` | | The per-request API, via `lambder.getSessionController(ctx)` |
| `LambderSessionDataRefreshError` | | The `dataRefresh` callback threw |
| `LambderSessionReadError` | | Reading a session record failed at the DynamoDB level |

Types: `LambderSessionOptions`, `LambderSessionContext`,
`LambderCreatedSession`, `LambderSessionDataRefreshConfig`,
`LambderSessionCookieOptions`.

See [Sessions](./sessions.md).

## Declarative policies

| Export | Client | Description |
| --- | --- | --- |
| `lambderGuard` | | Build a named guard: input mode, session requirement, param, return value |
| `lambderRateLimitKey` | | Build a custom rate-limit key from a validated payload slice |

Types: guards, `LambderApiGuard`, `LambderGuardMeta`, `LambderGuardMetaMap`,
`LambderGuardsOption`, `LambderGuardsOptionValue`, `LambderAllowedGuardNames`,
`LambderParamlessGuardNames`, `LambderGuardDataOf`, `LambderGuardInputsOf`;
rate limits, `LambderApiRateLimitsConfig`, `LambderApiRateLimitPolicyConfig`,
`LambderRateLimitKeyFn`, `LambderRateLimitPer`, `LambderRateLimitBudget`,
`LambderRateLimitOption`, `LambderRateLimitOptionValue`,
`LambderRateLimitOverride`, `LambderAllowedPolicyNames`; idempotency,
`LambderApiIdempotencyConfig`.

See [API policies](./api-policies.md).

## DynamoDB stores

| Export | Client | Description |
| --- | --- | --- |
| `LambderDdbCache` | | Compressed JSON cache with a memory layer, fill lease and grouped keys |
| `LambderDdbRateLimiter` | | Fixed-window rate limiter, atomic per window |
| `LambderDdbIdempotency` | | Idempotency claims and replays, owner-checked |

Types: cache, `LambderCacheKey`, `LambderDdbCacheOptions`,
`LambderDdbCacheSetOptions`, `LambderDdbCacheGetOrSetOptions`,
`LambderDdbCacheListOptions`; rate limiter, `LambderDdbRateLimiterOptions`,
`LambderRateLimitWindow`, `LambderRateLimitPolicy`,
`LambderRateLimitExceeded`, `LambderRateLimitResult`; idempotency,
`LambderDdbIdempotencyOptions`, `LambderIdempotencyBeginResult`,
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
| `LambderPublicFilesHandler` | | The handler `servePublicFiles()` registers |

Types: `LambderFileSource`, `LambderFile`, `LambderReadFile`,
`LambderFilesOption`, `LambderFileMemoryCacheOption`,
`LambderS3FileSourceOptions`, `LambderHttpFileSourceOptions`,
`LambderPublicFilesOptions`, `LambderIndexHtmlOptions`.

See [Frontend hosting](./frontend-hosting.md).

## Templating

| Export | Client | Description |
| --- | --- | --- |
| `html` | yes | Tagged template with automatic HTML escaping |
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
| `restoreBoundedText` | | Decompress with the declared byte length bounding AND verifying the result |
| `LambderCompressionError` | | Thrown when a restore fails |
| `LAMBDER_RESTORE_FAILURES` | | The reasons a restore can fail |
| `compressPayloadJson` | yes | Gzip a request payload (browser `CompressionStream`) |
| `decompressPayloadJson` | yes | Restore one |
| `isRequestCompressionAvailable` | yes | Whether the runtime can compress requests |
| `COMPRESSED_PAYLOAD_FIELD` | yes | The envelope field name (`payloadGz`) |
| `COMPRESSED_PAYLOAD_BYTES_FIELD` | yes | The envelope field name (`payloadBytes`) |
| `DEFAULT_REQUEST_COMPRESSION_SETTINGS` | yes | `{ minBytes: 4096 }` |
| `DEFAULT_MAX_REQUEST_PAYLOAD_BYTES` | | `20_000_000` |

Types: `LambderCompressionOption`, `LambderCompressionSettings`,
`LambderCompressionSettingsBase`, `LambderEncoding`, `LambderRestoreFailure`,
`LambderCompressedPayload`, `LambderRequestCompressionOption`,
`LambderRequestCompressionSettings`.

See [Responses](./responses.md#compression) and
[Frontend client](./client.md#compressed-request-payloads).

## Frontend client

| Export | Client | Description |
| --- | --- | --- |
| `LambderCaller` | yes | The typed API caller |

Types: `LambderCallerOptions`, `LambderCallOptions`, `LambderApiOutcome`,
`LambderApiFailureReason`, `LambderGuardInputsProvider`,
`LambderProvidedGuardInputs`, `LambderIdempotencyKeyScope`.

See [Frontend client](./client.md).

## Translations

| Export | Client | Description |
| --- | --- | --- |
| `createLambderI18n` | yes | Create the root translation instance |

Types: `LambderI18nConfig`, `LambderI18nInstance`, `LambderI18nTranslator`,
`LambderLanguageMeta`, `LambderI18nExtractParams`, and the instance-derived
`LambderI18nCodes`, `LambderI18nKeys`, `LambderI18nTranslatorFor`.

See [Translations](./i18n.md).

## Testing (`lambder/testing`)

| Export | Description |
| --- | --- |
| `LambderMSW` | Serve a typed API contract from MSW handlers |
| `LambderMswModule` | The shape of the `msw` module the adapter is handed |

See [Testing](./testing.md).

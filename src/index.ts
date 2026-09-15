import Lambder from './core/Lambder.js';

export default Lambder;
export { initLambder } from './core/Lambder.js';
// The created hook's parameter is the instance, so it is declared beside the class.
export type { LambderCreatedHook } from './core/Lambder.js';
export { default as LambderCaller } from "./client/LambderCaller.js";
export type { LambderApiOutcome, LambderApiFailureReason, LambderValidationError, LambderCallOptions, LambderCallerOptions, LambderGuardInputsProvider, LambderProvidedGuardInputs, LambderIdempotencyKeyScope, LambderLogListHandler } from "./client/LambderCaller.js";

// Transports: how a caller reaches a server (fetch in production, a handler in-process for tests, a cookie jar over either)
export { lambderFetchTransport } from "./client/lambderFetchTransport.js";
export { buildTransportEnvelope, LambderTransportFailure, isLambderTransportFailure } from "./shared/transport/LambderApiTransport.js";
export { lambderCookieJarTransport } from "./shared/transport/lambderCookieJarTransport.js";
export type { LambderApiTransport, LambderApiTransportRequest, LambderTransportFailureReason } from "./shared/transport/LambderApiTransport.js";
export { LambderCookieJar, parseSetCookie } from "./shared/transport/LambderCookieJar.js";
export { LambderExpiringMap, LambderExpiringMapFullError } from "./shared/util/LambderExpiringMap.js";
export type { LambderStoredCookie } from "./shared/transport/LambderCookieJar.js";
export { lambderHandlerTransport } from "./invoke/lambderHandlerTransport.js";
export type { LambderHandlerTransportOptions } from "./invoke/lambderHandlerTransport.js";
export {
    synthesizeLambdaHttpEvent,
    decodeLambdaHttpResult,
    localLambdaContext,
    LAMBDER_INVOKE_HEADER,
    LAMBDER_INVOKED_BY_HEADER,
    LAMBDER_INVOKE_PROTOCOL,
} from "./invoke/LambderLambdaEvent.js";
export type { LambderSynthesizedRequest, LambderLambdaHttpResult, LambderInvokeSession } from "./invoke/LambderLambdaEvent.js";

// The API core: the request, answer, envelope and pipeline both the server and the mock runtime run
export { LambderApiPipeline } from "./api/LambderApiPipeline.js";
export type { LambderApiPipelineOptions, LambderApiSessionsConfig, LambderApiInputRefusal, LambderApiRunResult, LambderApiExec } from "./api/LambderApiPipeline.js";
export { readApiEnvelope, restoreCompressedPayload } from "./api/LambderApiRequest.js";
export type { LambderApiRequest, LambderApiRequestInfo, LambderCompressedPayloadFields, LambderRestorePayloadResult } from "./api/LambderApiRequest.js";
export { toHttpAnswer } from "./api/LambderApiAnswer.js";
export type { LambderApiAnswer } from "./api/LambderApiAnswer.js";
export { LambderAnswerHeaders, getAnswerHeader, setAnswerHeader, addAnswerHeader } from "./shared/wire/LambderAnswerHeaders.js";
export { createApiCallContext } from "./api/LambderApiCallContext.js";
export type { LambderApiCallContext, LambderApiCallTrace } from "./api/LambderApiCallContext.js";
export type { LambderApiDefinition } from "./api/LambderApiDefinition.js";
export {
    buildApiEnvelope, envelopeAnswer, refusalAnswer, validationAnswer, apiNotFoundAnswer,
    sessionExpiredAnswer, versionExpiredAnswer, invalidPayloadAnswer, crashAnswer, API_ANSWER_CONTENT_TYPE,
} from "./api/LambderApiEnvelope.js";
export type { LambderApiEnvelopeConfig, LambderValidationAnswerBody } from "./api/LambderApiEnvelope.js";
export { LambderApiValidationRefusal, isLambderApiValidationRefusal } from "./api/LambderApiValidationRefusal.js";

// Calling a Lambder app from another lambda (server-only: the Lambda SDK, zlib)
export { LambderInvokeError, isLambderInvokeError } from "./invoke/LambderInvokeOutcome.js";
export type {
    LambderInvokeOutcome,
    LambderInvokeFailure,
    LambderInvokeValidationFailure,
    LambderInvokeCrashFailure,
    LambderInvokePayloadTooLargeFailure,
    LambderInvokeEnvelopeFailure,
    LambderInvokeDeliveryFailure,
    LambderInvokeFailureReason,
    LambderInvokeFunctionError,
} from "./invoke/LambderInvokeOutcome.js";
export {
    default as LambderInvokeCaller,
    LAMBDER_INVOKE_MAX_EVENT_BYTES,
} from "./invoke/LambderInvokeCaller.js";
export type {
    LambderInvokeCallerOptions,
    LambderInvokeCallOptions,
    LambderInvokeFailureHandler,
    LambderInvokeLogListHandler,
    LambderInvokeTransport,
    LambderInvokeTransportResult,
    LambderInvokeRequestInit,
    LambderInvokeEventInit,
} from "./invoke/LambderInvokeCaller.js";

// A crash described for a caller allowed to see it (the envelope's `crash` field)
export { describeCrash, errorFromCrashDetail } from "./shared/wire/LambderCrashDetail.js";
export type { LambderCrashDetail, LambderCrashCause } from "./shared/wire/LambderCrashDetail.js";

// Typed API refusals (isomorphic: shared code may throw them from anywhere)
export { LambderApiRefusal, isLambderApiRefusal, refuse, LAMBDER_REFUSAL_CODES } from "./shared/wire/LambderApiRefusal.js";
export type { LambderApiRefusalOptions, LambderRefusalMessage, LambderAppRefusalMessage, LambderRefusalCode, LambderRefuseOptions } from "./shared/wire/LambderApiRefusal.js";
export { default as LambderResponseBuilder } from "./core/LambderResponseBuilder.js";
export { default as LambderResolver } from "./core/LambderResolver.js";
export { default as LambderSessionManager } from "./session/LambderSessionManager.js";
export type { LambderSessionManagerOptions } from "./session/LambderSessionManager.js";
export { default as LambderSessionController } from "./session/LambderSessionController.js";
export { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from "./shared/wire/LambderSessionCookieNames.js";
export type { LambderSessionControllerOptions, LambderSessionRequestInfo } from "./session/LambderSessionController.js";
export type { LambderSessionStore, LambderSessionRecord } from "./shared/contracts/LambderSessionStore.js";
export { LambderMemorySessionStore } from "./stores/LambderMemorySessionStore.js";
export { LambderWebCrypto, LambderPlainSessionCrypto, isWebCryptoAvailable } from "./session/LambderSessionCrypto.js";
export type { LambderSessionCrypto } from "./session/LambderSessionCrypto.js";
export { LambderDdbSessionStore } from "./stores/LambderDdbSessionStore.js";
export type { LambderDdbSessionStoreOptions } from "./stores/LambderDdbSessionStore.js";

// Response model
export {
    LambderResponse,
    finalizeResponse,
    answerFromResponse,
    responseFromAnswer,
    type LambderHttpResponse,
    type LambderHeadersInput,
    type LambderFinalizeOptions,
    type LambderResponseCompressionSettings,
    type LambderResponseCompressionOption,
} from "./core/LambderResponse.js";
// The status union every refusal option names, from the module that declares it.
export type { LambderHttpStatusCode } from "./shared/wire/LambderHttpStatus.js";

// Type-safe templating (tagged templates with auto-escaping)
export { html, xml, raw, jsonScript, escapeHtml, renderHtmlValue, LambderSafeHtml, type LambderHtmlValue } from "./shared/LambderHtml.js";

// Comment-based HTML templating engine (build-pipeline-safe slots and conditionals, standalone)
export { LambderTemplatingEngine } from "./core/LambderTemplatingEngine.js";
export type { LambderTemplateData, LambderTemplatingEngineOptions } from "./core/LambderTemplatingEngine.js";
export type {
    LambderResponseOptions,
    LambderRawResponseInit,
    LambderResolverApiMethod,
} from "./core/LambderResponseBuilder.js";

// Routing / configuration types
export type { LambderRouteMatcher, LambderRouteConditionFn, LambderRouteCondition, LambderPathParamsOf, LambderRoutePath } from "./core/LambderRouting.js";
export type { LambderCorsConfig } from "./core/LambderCors.js";
export type {
    LambderCreateOptions,
    LambderSessionOptions,
    LambderActionTools,
    LambderHandler,
} from "./core/LambderCreateOptions.js";
export type { LambderIndexHtmlOptions } from "./core/LambderIndexHtml.js";
// The handlers and hooks an app writes, so one can be declared apart from its registration
export type {
    LambderRouteHandler,
    LambderSessionRouteHandler,
    LambderActionHandler,
    LambderActionFilter,
    LambderHookEvent,
    LambderBeforeRenderHook,
    LambderAfterRenderHook,
    LambderFallbackHook,
    LambderGlobalErrorHandler,
    LambderFallbackHandler,
    LambderInputValidationHandler,
} from "./core/LambderCreateOptions.js";

// Public file serving
// The handler itself is reached through servePublicFiles(), like its
// LambderIndexHtmlHandler sibling; only its options are named by an app.
export type { LambderPublicFilesOptions } from "./core/LambderPublicFiles.js";
export { LambderFiles } from "./core/LambderFiles.js";
export type { LambderFilesOption, LambderFileMemoryCacheOption, LambderReadFile } from "./core/LambderFiles.js";
export { LambderLocalFileSource } from "./stores/LambderLocalFileSource.js";
export type { LambderFileSource, LambderFile } from "./shared/contracts/LambderFileSource.js";
export { LambderS3FileSource } from "./stores/LambderS3FileSource.js";
export type { LambderS3FileSourceOptions } from "./stores/LambderS3FileSource.js";
export { LambderHttpFileSource } from "./stores/LambderHttpFileSource.js";
export type { LambderHttpFileSourceOptions } from "./stores/LambderHttpFileSource.js";

// Session types
export type { LambderSessionCookieOptions } from "./session/LambderSessionController.js";
export type { LambderCreatedSession, LambderSessionDataRefreshConfig } from "./session/LambderSessionManager.js";
// Compression: the option every site shares, and the one codec behind them all.
export { resolveCompressionOption, LAMBDER_ENCODINGS } from "./shared/wire/LambderCompressionOption.js";
export type {
    LambderCompressionOption,
    LambderCompressionSettings,
    LambderCompressionSettingsBase,
    LambderEncoding,
} from "./shared/wire/LambderCompressionOption.js";
// Brotli/gzip plus the bounded, length-verified restore every compressed
// value in Lambder (records at rest, request payloads) goes through.
export {
    compressText,
    restoreBytes,
    restoreText,
    LambderCompressionError,
    LAMBDER_RESTORE_FAILURES,
} from "./shared/wire/LambderCompressionCodec.js";
export type { LambderRestoreFailure, LambderRestoreBound } from "./shared/wire/LambderCompressionCodec.js";
export { LambderSessionDataRefreshError, LambderSessionReadError } from "./session/LambderSessionManager.js";
export { LambderSessionNotFoundError, LambderSessionAmbiguousError } from "./session/LambderSessionController.js";

// DynamoDB-backed compressed cache (standalone, server-only)
export { LambderDdbCache } from "./stores/LambderDdbCache.js";
export type {
    LambderCacheKey,
    LambderDdbCacheOptions,
    LambderDdbCacheSetOptions,
    LambderDdbCacheGetOrSetOptions,
    LambderDdbCacheListOptions,
} from "./stores/LambderDdbCache.js";

// Fixed-window rate limiting: the shared vocabulary, the DynamoDB limiter and the in-memory one
export { RATE_LIMIT_WINDOWS } from "./shared/contracts/LambderRateLimiter.js";
export type {
    LambderRateLimiter,
    LambderRateLimitWindow,
    LambderRateLimitPolicy,
    LambderRateLimitExceeded,
    LambderRateLimitResult,
} from "./shared/contracts/LambderRateLimiter.js";
export { LambderDdbRateLimiter } from "./stores/LambderDdbRateLimiter.js";
export type { LambderDdbRateLimiterOptions } from "./stores/LambderDdbRateLimiter.js";
export { LambderMemoryRateLimiter } from "./stores/LambderMemoryRateLimiter.js";

// Idempotency records: the store interface, the DynamoDB store and the in-memory one
export type {
    LambderIdempotencyStore,
    LambderIdempotencyBeginResult,
    LambderIdempotencyDoneRecord,
} from "./shared/contracts/LambderIdempotencyStore.js";
export { LambderDdbIdempotencyStore } from "./stores/LambderDdbIdempotencyStore.js";
export type { LambderDdbIdempotencyStoreOptions } from "./stores/LambderDdbIdempotencyStore.js";
export { LambderMemoryIdempotencyStore } from "./stores/LambderMemoryIdempotencyStore.js";

// Declarative per-API policies: guards
export { lambderGuard, lambderRateLimitKey } from "./core/LambderPolicyBuilders.js";
export { lambderGuardBuilder } from "./api/LambderApiGuards.js";
export type {
    LambderGuardBuilder,
    LambderApiGuard,
    LambderGuardMeta,
    LambderGuardMetaMap,
    LambderAllowedGuardNames,
    LambderParamlessGuardNames,
    LambderGuardsOption,
    LambderGuardDataOf,
    LambderGuardInputsOf,
} from "./api/LambderApiGuards.js";

// Declarative per-API policies: rate limits
export { lambderRateLimitKeyBuilder, rateLimitRefusal, DEFAULT_RATE_LIMIT_REFUSAL } from "./api/LambderApiRateLimits.js";
export type { LambderRateLimitKeyBuilder } from "./api/LambderApiRateLimits.js";
export type {
    LambderRateLimitKeyFn,
    LambderRateLimitPer,
    LambderRateLimitBudget,
    LambderApiRateLimitPolicyConfig,
    LambderApiRateLimitsConfig,
    LambderAllowedPolicyNames,
    LambderRateLimitOption,
} from "./api/LambderApiRateLimits.js";

// Declarative per-API policies: idempotency
export type { LambderApiIdempotencyConfig } from "./api/LambderApiIdempotency.js";

// The runtime shapes of the three policy options, declared below both the
// contract that records them and the engines that read them.
export type {
    LambderGuardsOptionValue,
    LambderRateLimitOverride,
    LambderRateLimitOptionValue,
    LambderApiIdempotencyOption,
} from "./shared/wire/LambderApiOptionValues.js";

// Typed translations (standalone, isomorphic)
export { createLambderI18n } from "./shared/LambderI18n.js";
export type {
    LambderLanguageMeta,
    LambderI18nConfig,
    LambderI18nInstance,
    LambderI18nTranslator,
    LambderI18nExtractParams,
    LambderI18nCodes,
    LambderI18nKeys,
    LambderI18nTranslatorFor,
} from "./shared/LambderI18n.js";

// Type-safe API contract utilities and the wire envelope
export type {
    LambderApiContractShape,
    LambderApiMode,
    LambderApiEnvelopeBody,
    LambderApiResponseConfig,
    LambderApiNullAnswerConfig,
    LambderContractEntry,
    LambderMergeContract,
    LambderGuardNamesIn,
    LambderContractMode,
    LambderContractKeysWithMode,
    LambderContractGuardsOf,
    LambderContractGuardNames,
    LambderContractGuardInputsOf,
    LambderContractGuardInput,
    LambderContractGuardInputNames,
    LambderContractRateLimitOf,
    LambderContractIdempotencyOf,
} from "./shared/wire/LambderApiContract.js";

// Context types and utilities
export type { LambderRenderContext, LambderSessionRenderContext, LambderHttpEvent, LambderHttpEventFormat } from "./core/LambderContext.js";
export type {
    LambderApiAnswerOutcome,
    LambderApiSuccessOutcome,
    LambderApiCallFailure,
    LambderApiValidationFailure,
    LambderApiEnvelopeFailure,
    LambderApiHttpAnswer,
} from "./shared/wire/LambderApiOutcome.js";
export { resolveApiOutcome } from "./shared/wire/LambderApiOutcome.js";
export { createContext, isV2HttpEvent } from "./core/LambderContext.js";

// Request payload compression: the wire format LambderCaller and the server share.
export {
    COMPRESSED_PAYLOAD_GZ_FIELD,
    COMPRESSED_PAYLOAD_BR_FIELD,
    COMPRESSED_PAYLOAD_BYTES_FIELD,
    DEFAULT_REQUEST_COMPRESSION_SETTINGS,
    DEFAULT_MAX_RESTORED_PAYLOAD_BYTES,
    // The Brotli twin of the browser's compressPayloadGzip, beside it now
    // rather than inside LambderInvokeCaller; the root entry's name is unchanged.
    DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS,
    compressPayloadBrotli,
} from "./shared/wire/LambderRequestPayload.js";
export type {
    LambderCompressedGzipPayload,
    LambderCompressedBrotliPayload,
    LambderRequestCompressionOption,
    LambderRequestCompressionSettings,
} from "./shared/wire/LambderRequestPayload.js";

// Cookies (res.setCookie / res.clearCookie build on these; exported for code holding a LambderResponse)
export { serializeCookie, serializeClearCookie, resolveCookieDomain } from "./shared/wire/LambderCookie.js";
export type { LambderCookieOptions, LambderClearCookieOptions, LambderCookieDomain } from "./shared/wire/LambderCookie.js";

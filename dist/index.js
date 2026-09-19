import Lambder from './core/Lambder.js';
export default Lambder;
export { initLambder } from './core/Lambder.js';
export { default as LambderCaller } from "./client/LambderCaller.js";
// Transports: how a caller reaches a server (fetch in production, a handler in-process for tests, a cookie jar over either)
export { lambderFetchTransport } from "./client/lambderFetchTransport.js";
export { buildTransportEnvelope, LambderTransportFailure, isLambderTransportFailure } from "./shared/transport/LambderApiTransport.js";
export { lambderCookieJarTransport } from "./shared/transport/lambderCookieJarTransport.js";
export { LambderCookieJar, parseSetCookie } from "./shared/transport/LambderCookieJar.js";
export { LambderExpiringMap, LambderExpiringMapFullError } from "./shared/util/LambderExpiringMap.js";
export { lambderHandlerTransport } from "./invoke/lambderHandlerTransport.js";
export { synthesizeLambdaHttpEvent, decodeLambdaHttpResult, localLambdaContext, LAMBDER_INVOKE_HEADER, LAMBDER_INVOKED_BY_HEADER, LAMBDER_INVOKE_PROTOCOL, } from "./invoke/LambderLambdaEvent.js";
// The API core: the request, answer, envelope and pipeline both the server and the mock runtime run
export { LambderApiPipeline } from "./api/LambderApiPipeline.js";
export { readApiEnvelope, restoreCompressedPayload } from "./api/LambderApiRequest.js";
export { toHttpAnswer } from "./api/LambderApiAnswer.js";
export { LambderAnswerHeaders, getAnswerHeader, setAnswerHeader, addAnswerHeader } from "./shared/wire/LambderAnswerHeaders.js";
export { createApiCallContext } from "./api/LambderApiCallContext.js";
// Per-endpoint signatures: what a client build ships with, digested from the server's own registrations.
export { apiSignatureOf } from "./api/LambderApiSignature.js";
export { apiNameKeyOf, lookupApiSignature, readApiSignature, API_SIGNATURE_HEX_LENGTH, extensibleEnum } from "./shared/wire/LambderApiSignature.js";
export { RELOAD_LOOP_WINDOW_MS } from "./client/LambderReloadLoopBreaker.js";
export { compareDottedVersions, isDottedVersion } from "./shared/wire/LambderVersionOrder.js";
export { buildApiEnvelope, envelopeAnswer, refusalAnswer, validationAnswer, apiNotFoundAnswer, sessionExpiredAnswer, versionExpiredAnswer, invalidPayloadAnswer, crashAnswer, API_ANSWER_CONTENT_TYPE, } from "./api/LambderApiEnvelope.js";
export { LambderApiValidationRefusal, isLambderApiValidationRefusal } from "./api/LambderApiValidationRefusal.js";
// Calling a Lambder app from another lambda (server-only: the Lambda SDK, zlib)
export { LambderInvokeError, isLambderInvokeError } from "./invoke/LambderInvokeOutcome.js";
export { default as LambderInvokeCaller, LAMBDER_INVOKE_MAX_EVENT_BYTES, } from "./invoke/LambderInvokeCaller.js";
// A crash described for a caller allowed to see it (the envelope's `crash` field)
export { describeCrash, errorFromCrashDetail } from "./shared/wire/LambderCrashDetail.js";
// Typed API refusals (isomorphic: shared code may throw them from anywhere)
export { LambderApiRefusal, isLambderApiRefusal, refuse, LAMBDER_REFUSAL_CODES } from "./shared/wire/LambderApiRefusal.js";
export { default as LambderResponseBuilder } from "./core/LambderResponseBuilder.js";
export { default as LambderResolver } from "./core/LambderResolver.js";
export { default as LambderSessionManager } from "./session/LambderSessionManager.js";
export { default as LambderSessionController } from "./session/LambderSessionController.js";
export { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from "./shared/wire/LambderSessionCookieNames.js";
export { LambderMemorySessionStore } from "./stores/LambderMemorySessionStore.js";
export { LambderWebCrypto, LambderPlainSessionCrypto, isWebCryptoAvailable } from "./session/LambderSessionCrypto.js";
export { LambderDdbSessionStore } from "./stores/LambderDdbSessionStore.js";
// Response model
export { LambderResponse, finalizeResponse, answerFromResponse, responseFromAnswer, } from "./core/LambderResponse.js";
// Type-safe templating (tagged templates with auto-escaping)
export { html, xml, raw, jsonScript, escapeHtml, renderHtmlValue, LambderSafeHtml } from "./shared/LambderHtml.js";
// Comment-based HTML templating engine (build-pipeline-safe slots and conditionals, standalone)
export { LambderTemplatingEngine } from "./core/LambderTemplatingEngine.js";
export { LambderFiles } from "./core/LambderFiles.js";
export { LambderLocalFileSource } from "./stores/LambderLocalFileSource.js";
export { LambderS3FileSource } from "./stores/LambderS3FileSource.js";
export { LambderHttpFileSource } from "./stores/LambderHttpFileSource.js";
// Compression: the option every site shares, and the one codec behind them all.
export { resolveCompressionOption, LAMBDER_ENCODINGS } from "./shared/wire/LambderCompressionOption.js";
// Brotli/gzip plus the bounded, length-verified restore every compressed
// value in Lambder (records at rest, request payloads) goes through.
export { compressText, restoreBytes, restoreText, LambderCompressionError, LAMBDER_RESTORE_FAILURES, } from "./shared/wire/LambderCompressionCodec.js";
export { LambderSessionDataRefreshError, LambderSessionReadError } from "./session/LambderSessionManager.js";
export { LambderSessionNotFoundError, LambderSessionAmbiguousError } from "./session/LambderSessionController.js";
// DynamoDB-backed compressed cache (standalone, server-only)
export { LambderDdbCache } from "./stores/LambderDdbCache.js";
// Fixed-window rate limiting: the shared vocabulary, the DynamoDB limiter and the in-memory one
export { RATE_LIMIT_WINDOWS } from "./shared/contracts/LambderRateLimiter.js";
export { LambderDdbRateLimiter } from "./stores/LambderDdbRateLimiter.js";
export { LambderMemoryRateLimiter } from "./stores/LambderMemoryRateLimiter.js";
export { LambderDdbIdempotencyStore } from "./stores/LambderDdbIdempotencyStore.js";
export { LambderMemoryIdempotencyStore } from "./stores/LambderMemoryIdempotencyStore.js";
// Declarative per-API policies: guards
export { lambderGuard, lambderRateLimitKey } from "./core/LambderPolicyBuilders.js";
export { lambderGuardBuilder } from "./api/LambderApiGuards.js";
// Declarative per-API policies: rate limits
export { lambderRateLimitKeyBuilder, rateLimitRefusal, DEFAULT_RATE_LIMIT_REFUSAL } from "./api/LambderApiRateLimits.js";
// Typed translations (standalone, isomorphic)
export { createLambderI18n } from "./shared/LambderI18n.js";
export { resolveApiOutcome } from "./shared/wire/LambderApiOutcome.js";
export { createContext, isV2HttpEvent } from "./core/LambderContext.js";
// Request payload compression: the wire format LambderCaller and the server share.
export { COMPRESSED_PAYLOAD_GZ_FIELD, COMPRESSED_PAYLOAD_BR_FIELD, COMPRESSED_PAYLOAD_BYTES_FIELD, DEFAULT_REQUEST_COMPRESSION_SETTINGS, DEFAULT_MAX_RESTORED_PAYLOAD_BYTES, 
// The Brotli twin of the browser's compressPayloadGzip, beside it now
// rather than inside LambderInvokeCaller; the root entry's name is unchanged.
DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS, compressPayloadBrotli, } from "./shared/wire/LambderRequestPayload.js";
// Cookies (res.setCookie / res.clearCookie build on these; exported for code holding a LambderResponse)
export { serializeCookie, serializeClearCookie, resolveCookieDomain } from "./shared/wire/LambderCookie.js";
